// services/smc-backtest.js
// ====================================================
// SMC SETUP BACKTEST
// Runs backtest for a given setup (scenario) on historical candles
// ====================================================

const { analyzeOHLCV, getSwingPoints, ATR_OHLC } = require('./trading-engine');
const { evaluateScenario, recentStructureShift } = require('./smc-scenarios/scenario-checks');
const { getScenario } = require('./smc-scenarios/scenario-definitions');
const { computeMaxDrawdown, computeMaxDrawdownPct } = require('./backtest/analytics');

const INITIAL_BALANCE = 10000;
const RISK_PER_TRADE = 0.02;
const LEVERAGE = 2;
const SL_ATR_MULT = 2;
const TP_ATR_MULT = 4;       // 2:1 RR (TP = 4× ATR, SL = 2× ATR)
const TAKER_FEE = 0.001;
const SLIPPAGE_BPS = 5;
const MIN_PHASES_FOR_ENTRY = 4;

/**
 * Run backtest for an SMC setup.
 * @param {string} coinId - e.g. 'bitcoin'
 * @param {string} setupId - e.g. 'fvg_liquidity_long'
 * @param {number} startMs - start timestamp
 * @param {number} endMs - end timestamp
 * @param {Object} options - { initialBalance, leverage, candles }
 */
async function runSetupBacktest(coinId, setupId, startMs, endMs, options = {}) {
  const initialBalance = options.initialBalance ?? INITIAL_BALANCE;
  const leverage = options.leverage ?? LEVERAGE;
  const timeframe = options.timeframe || '1h';
  const scenario = getScenario(setupId);
  if (!scenario) {
    return { error: `Unknown setup: ${setupId}`, trades: [], equityCurve: [] };
  }

  const { fetchHistoricalCandlesForCoin, fetchHistoricalKrakenCandles } = require('./crypto-api');
  const { loadCachedCandles, saveCachedCandles } = require('./backtest-cache');
  const WARMUP = timeframe === '4h' ? 25 : 100; // 4h bars

  const now = Date.now();
  if (endMs > now) endMs = now;
  if (startMs > endMs) startMs = endMs - 90 * 24 * 3600000;

  const fetchStartMs = startMs - WARMUP * (timeframe === '4h' ? 4 : 1) * 3600000;
  let candles = options.candles;
  const tfKey = timeframe; // '1h' or '4h'

  if (!candles || !candles[tfKey]) {
    const cacheKey = coinId + '_' + timeframe;
    const cached = loadCachedCandles(cacheKey, fetchStartMs, endMs);
    if (cached && cached[tfKey] && cached[tfKey].length >= 50) {
      candles = cached;
    } else {
      try {
        let ctf = await fetchHistoricalCandlesForCoin(coinId, timeframe, fetchStartMs, endMs);
        if (!ctf || ctf.length < 50) {
          ctf = await fetchHistoricalKrakenCandles(coinId, timeframe, fetchStartMs, endMs);
        }
        candles = { [tfKey]: ctf };
        if (ctf && ctf.length >= 50) saveCachedCandles(cacheKey, fetchStartMs, endMs, candles);
      } catch (err) {
        return { error: err.message || 'Failed to fetch candles', trades: [], equityCurve: [] };
      }
    }
  }

  const ctf = candles[tfKey];
  if (!ctf || ctf.length < 50) {
    return { error: `Insufficient ${timeframe} candle data (need 50+ bars)`, trades: [], equityCurve: [] };
  }

  // For 1h backtest, also fetch 4h for HTF bias gating
  let c4h = candles['4h'] || null;
  if (timeframe === '1h' && !c4h) {
    try {
      c4h = await fetchHistoricalCandlesForCoin(coinId, '4h', fetchStartMs, endMs);
      if (!c4h || c4h.length < 40) c4h = null;
    } catch (e) { c4h = null; }
  }

  let startBar = Math.min(40, Math.floor(ctf.length / 4));
  for (let i = 0; i < ctf.length; i++) {
    if (ctf[i].openTime >= startMs) {
      startBar = Math.max(40, i);
      break;
    }
  }
  const lastBar = ctf.length - 1;
  if (startBar >= lastBar) startBar = Math.min(40, Math.floor(ctf.length / 4));

  const trades = [];
  let equity = initialBalance;
  let position = null;
  const equityCurve = [{ bar: startBar, equity: initialBalance, time: ctf[startBar]?.openTime }];

  const direction = scenario.direction;

  // Build 4h bar index lookup for bias check at each 1h bar
  function get4hBiasAt(barTime) {
    if (!c4h || c4h.length < 40) return 'NEUTRAL';
    // Find 4h bars up to barTime
    const idx = c4h.findIndex(b => b.openTime > barTime);
    const slice4h = idx > 0 ? c4h.slice(0, idx) : c4h;
    if (slice4h.length < 40) return 'NEUTRAL';
    const isBull = recentStructureShift(slice4h, 'BULL');
    const isBear = recentStructureShift(slice4h, 'BEAR');
    if (isBull && !isBear) return 'BULL';
    if (isBear && !isBull) return 'BEAR';
    return 'NEUTRAL';
  }

  for (let t = startBar; t < lastBar; t++) {
    if (equity <= 0) break;

    const slice = ctf.slice(0, t + 1);
    const currentPrice = slice[slice.length - 1].close;
    const analysis = analyzeOHLCV(slice, currentPrice);
    const result = evaluateScenario(slice, analysis, setupId, t);

    if (position) {
      const nextBar = ctf[t + 1];
      const exitPrice = nextBar.open;
      const slip = 1 + (SLIPPAGE_BPS / 10000);

      let shouldExit = false;
      let exitReason = 'SIGNAL';

      if (position.direction === 'LONG') {
        if (nextBar.low <= position.stopLoss) {
          shouldExit = true;
          exitReason = 'SL';
        } else if (position.takeProfit && nextBar.high >= position.takeProfit) {
          shouldExit = true;
          exitReason = 'TP';
        } else if (result.ready && direction === 'SHORT') {
          shouldExit = true;
        }
      } else {
        if (nextBar.high >= position.stopLoss) {
          shouldExit = true;
          exitReason = 'SL';
        } else if (position.takeProfit && nextBar.low <= position.takeProfit) {
          shouldExit = true;
          exitReason = 'TP';
        } else if (result.ready && direction === 'LONG') {
          shouldExit = true;
        }
      }

      if (shouldExit) {
        const adjExit = position.direction === 'LONG' ? exitPrice / slip : exitPrice * slip;
        const exitFees = position.size * TAKER_FEE;
        const pnl = position.direction === 'LONG'
          ? ((adjExit - position.entry) / position.entry) * position.size
          : ((position.entry - adjExit) / position.entry) * position.size;
        equity = Math.max(0, equity + pnl - exitFees - position.entryFees);
        trades.push({
          direction: position.direction,
          entry: position.entry,
          exit: adjExit,
          entryBar: position.entryBar,
          exitBar: t + 1,
          exitTime: nextBar.openTime,
          reason: exitReason,
          pnl: pnl - exitFees - position.entryFees,
          size: position.size,
          setupId
        });
        position = null;
      }
      continue;
    }

    if (result.ready && result.score >= MIN_PHASES_FOR_ENTRY) {
      // HTF bias gate: skip entry if 4h opposes the setup direction
      const barTime = ctf[t]?.openTime || 0;
      const htfBias = get4hBiasAt(barTime);
      if (htfBias === 'BULL' && direction === 'SHORT') continue;
      if (htfBias === 'BEAR' && direction === 'LONG') continue;

      const nextBar = ctf[t + 1];
      const entryPrice = nextBar.open;
      const slip = 1 + (SLIPPAGE_BPS / 10000);
      const highs = slice.map(c => c.high);
      const lows = slice.map(c => c.low);
      const closes = slice.map(c => c.close);
      const atr = ATR_OHLC(highs, lows, closes, 14);

      const riskDist = Math.max(atr * SL_ATR_MULT, entryPrice * 0.005);
      const rewardDist = atr * TP_ATR_MULT;

      let stopLoss, takeProfit, adjEntry;

      if (direction === 'LONG') {
        adjEntry = entryPrice * slip;
        stopLoss = adjEntry - riskDist;
        takeProfit = adjEntry + rewardDist;
      } else {
        adjEntry = entryPrice / slip;
        stopLoss = adjEntry + riskDist;
        takeProfit = adjEntry - rewardDist;
      }

      const riskAmount = equity * RISK_PER_TRADE;
      const positionSize = Math.min(equity * leverage * 0.95, riskDist > 0 ? (riskAmount / riskDist) * adjEntry : equity * 0.1);
      const entryFees = positionSize * TAKER_FEE;

      if (entryFees + (positionSize / leverage) <= equity) {
        equity -= entryFees;
        position = {
          direction,
          entry: adjEntry,
          entryBar: t + 1,
          stopLoss,
          takeProfit,
          size: positionSize,
          entryFees,
          setupId
        };
      }
    }
  }

  if (position) {
    const lastBarC = ctf[ctf.length - 1];
    const exitPrice = lastBarC.close;
    const slip = 1 + (SLIPPAGE_BPS / 10000);
    const adjExit = position.direction === 'LONG' ? exitPrice / slip : exitPrice * slip;
    const exitFees = position.size * TAKER_FEE;
    const pnl = position.direction === 'LONG'
      ? ((adjExit - position.entry) / position.entry) * position.size
      : ((position.entry - adjExit) / position.entry) * position.size;
    equity = Math.max(0, equity + pnl - exitFees - position.entryFees);
    trades.push({
      direction: position.direction,
      entry: position.entry,
      exit: adjExit,
      entryBar: position.entryBar,
      exitBar: ctf.length - 1,
      exitTime: lastBarC.openTime,
      reason: 'END',
      pnl: pnl - exitFees - position.entryFees,
      size: position.size,
      setupId
    });
  }

  let runningEquity = initialBalance;
  const curveMap = new Map();
  curveMap.set(startBar, { equity: initialBalance, time: ctf[startBar]?.openTime });
  for (const tr of trades) {
    runningEquity += tr.pnl;
    curveMap.set(tr.exitBar, { equity: runningEquity, time: ctf[tr.exitBar]?.openTime });
  }
  const curveStep = timeframe === '4h' ? 6 : 24;
  for (let t = startBar; t < ctf.length; t += curveStep) {
    if (!curveMap.has(t)) {
      const closedBefore = trades.filter(tr => tr.exitBar <= t).reduce((s, tr) => s + tr.pnl, 0);
      curveMap.set(t, { equity: initialBalance + closedBefore, time: ctf[t]?.openTime });
    }
  }
  const equityCurveArr = [...curveMap.entries()].sort((a, b) => a[0] - b[0]).map(([bar, data]) => ({ bar, ...data }));

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const maxDrawdown = computeMaxDrawdown(equityCurveArr);
  const maxDrawdownPct = computeMaxDrawdownPct(equityCurveArr);

  const dataRangeNote = ctf.length > 0
    ? `${new Date(ctf[startBar]?.openTime || 0).toISOString().slice(0, 10)} to ${new Date(ctf[lastBar]?.openTime || 0).toISOString().slice(0, 10)} [${timeframe}]`
    : null;

  return {
    trades,
    equityCurve: equityCurveArr,
    dataRangeNote,
    summary: {
      totalTrades: trades.length,
      wins,
      losses,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      totalPnl,
      totalPnlPercent: initialBalance > 0 ? (totalPnl / initialBalance) * 100 : 0,
      profitFactor,
      maxDrawdown,
      maxDrawdownPct,
      initialBalance,
      finalBalance: equity,
      setupId,
      setupName: scenario.name
    }
  };
}

module.exports = {
  runSetupBacktest
};
