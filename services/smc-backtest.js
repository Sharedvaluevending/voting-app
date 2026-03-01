// services/smc-backtest.js
// ====================================================
// SMC SETUP BACKTEST
// Runs backtest for a given setup (scenario) on historical candles
// ====================================================

const { analyzeOHLCV, getSwingPoints, ATR_OHLC } = require('./trading-engine');
const { evaluateScenario } = require('./smc-scenarios/scenario-checks');
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
  const scenario = getScenario(setupId);
  if (!scenario) {
    return { error: `Unknown setup: ${setupId}`, trades: [], equityCurve: [] };
  }

  const { fetchHistoricalCandlesForCoin, fetchHistoricalKrakenCandles } = require('./crypto-api');
  const { loadCachedCandles, saveCachedCandles } = require('./backtest-cache');
  const WARMUP = 100;

  const now = Date.now();
  if (endMs > now) endMs = now;
  if (startMs > endMs) startMs = endMs - 90 * 24 * 3600000;

  const fetchStartMs = startMs - WARMUP * 3600000;
  let candles = options.candles;

  if (!candles || !candles['1h']) {
    const cached = loadCachedCandles(coinId, fetchStartMs, endMs);
    if (cached && cached['1h'] && cached['1h'].length >= 100) {
      candles = cached;
    } else {
      try {
        let c1h = await fetchHistoricalCandlesForCoin(coinId, '1h', fetchStartMs, endMs);
        if (!c1h || c1h.length < 100) {
          c1h = await fetchHistoricalKrakenCandles(coinId, '1h', fetchStartMs, endMs);
        }
        candles = { '1h': c1h };
        if (c1h && c1h.length >= 100) saveCachedCandles(coinId, fetchStartMs, endMs, candles);
      } catch (err) {
        return { error: err.message || 'Failed to fetch candles', trades: [], equityCurve: [] };
      }
    }
  }

  const c1h = candles['1h'];
  if (!c1h || c1h.length < 100) {
    return { error: 'Insufficient candle data (need 100+ bars)', trades: [], equityCurve: [] };
  }

  let startBar = 50;
  for (let i = 0; i < c1h.length; i++) {
    if (c1h[i].openTime >= startMs) {
      startBar = Math.max(50, i);
      break;
    }
  }
  const lastBar = c1h.length - 1;
  if (startBar >= lastBar) startBar = 50;

  const trades = [];
  let equity = initialBalance;
  let position = null;
  const equityCurve = [{ bar: startBar, equity: initialBalance, time: c1h[startBar]?.openTime }];

  const direction = scenario.direction;

  for (let t = startBar; t < lastBar; t++) {
    if (equity <= 0) break;

    const slice = c1h.slice(0, t + 1);
    const currentPrice = slice[slice.length - 1].close;
    const analysis = analyzeOHLCV(slice, currentPrice);
    const result = evaluateScenario(slice, analysis, setupId, t);

    if (position) {
      const nextBar = c1h[t + 1];
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
      const nextBar = c1h[t + 1];
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
    const lastBarC = c1h[c1h.length - 1];
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
      exitBar: c1h.length - 1,
      exitTime: lastBarC.openTime,
      reason: 'END',
      pnl: pnl - exitFees - position.entryFees,
      size: position.size,
      setupId
    });
  }

  let runningEquity = initialBalance;
  const curveMap = new Map();
  curveMap.set(startBar, { equity: initialBalance, time: c1h[startBar]?.openTime });
  for (const tr of trades) {
    runningEquity += tr.pnl;
    curveMap.set(tr.exitBar, { equity: runningEquity, time: c1h[tr.exitBar]?.openTime });
  }
  for (let t = startBar; t < c1h.length; t += 24) {
    if (!curveMap.has(t)) {
      const closedBefore = trades.filter(tr => tr.exitBar <= t).reduce((s, tr) => s + tr.pnl, 0);
      curveMap.set(t, { equity: initialBalance + closedBefore, time: c1h[t]?.openTime });
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

  const dataRangeNote = c1h.length > 0
    ? `${new Date(c1h[startBar]?.openTime || 0).toISOString().slice(0, 10)} to ${new Date(c1h[lastBar]?.openTime || 0).toISOString().slice(0, 10)}`
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
