// services/strategy-builder/run-custom-backtest.js
// ====================================================
// CUSTOM BACKTEST - Uses rule engine instead of SignalEngine
// Reuses candle fetch, execution sim, analytics
// ====================================================

const { evaluateBar } = require('./rule-engine');
const ind = require('../../lib/indicators');
const { computeMaxDrawdown, computeMaxDrawdownPct } = require('../backtest/analytics');

const SL_ATR_MULT_AUTO = 2;
const TP_ATR_MULT_AUTO = 3;

const INITIAL_BALANCE = 10000;
const RISK_PER_TRADE = 0.02;
const LEVERAGE = 2;
const SL_ATR_MULT = 2;
const TP_ATR_MULT = 3;
const TAKER_FEE = 0.001;
const SLIPPAGE_BPS = 5;

/**
 * Run custom strategy backtest for one coin.
 * @param {string} coinId
 * @param {number} startMs
 * @param {number} endMs
 * @param {Object} strategy - { entry, exit }
 * @param {Object} options - { initialBalance, leverage, candles (pre-fetched) }
 */
async function runCustomBacktest(coinId, startMs, endMs, strategy, options = {}) {
  const initialBalance = options.initialBalance ?? INITIAL_BALANCE;
  const leverage = options.leverage ?? LEVERAGE;

  const { fetchHistoricalCandlesForCoin, fetchHistoricalKrakenCandles } = require('../crypto-api');
  const { loadCachedCandles, saveCachedCandles } = require('../backtest-cache');
  const WARMUP = 100;

  const fetchStartMs = startMs - WARMUP * 3600000;
  let candles = options.candles;

  if (!candles || !candles['1h']) {
    const cached = loadCachedCandles(coinId, fetchStartMs, endMs);
    if (cached && cached['1h'] && cached['1h'].length >= 100) {
      candles = cached;
    } else {
      try {
        // Bitget first (paginates, more history); Kraken fallback (~30d)
        let c1h = await fetchHistoricalCandlesForCoin(coinId, '1h', fetchStartMs, endMs);
        let c4h = await fetchHistoricalCandlesForCoin(coinId, '4h', fetchStartMs, endMs);
        let c1d = await fetchHistoricalCandlesForCoin(coinId, '1d', fetchStartMs, endMs);
        if (!c1h || c1h.length < 100) {
          c1h = await fetchHistoricalKrakenCandles(coinId, '1h', fetchStartMs, endMs);
          c4h = await fetchHistoricalKrakenCandles(coinId, '4h', fetchStartMs, endMs);
          c1d = await fetchHistoricalKrakenCandles(coinId, '1d', fetchStartMs, endMs);
        }
        candles = { '1h': c1h, '4h': c4h, '1d': c1d };
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

  // Find start bar index (first bar within date range)
  let startBar = 50;
  for (let i = 0; i < c1h.length; i++) {
    if (c1h[i].openTime >= startMs) {
      startBar = Math.max(50, i);
      break;
    }
  }

  const trades = [];
  let equity = initialBalance;
  let position = null;
  const equityCurve = [{ bar: startBar, equity: initialBalance, time: c1h[startBar]?.openTime }];

  const lastBar = c1h.length - 1;
  for (let t = startBar; t < lastBar; t++) {
    if (equity <= 0) break;

    const bar = c1h[t];
    const nextBar = c1h[t + 1];
    const slice = c1h.slice(0, t + 1);

    const result = evaluateBar(slice, strategy, t);

    if (position) {
      // Check exit
      if (result.exit) {
        const exitPrice = nextBar.open;
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
          exitBar: t + 1,
          exitTime: nextBar.openTime,
          reason: 'SIGNAL',
          pnl: pnl - exitFees - position.entryFees,
          size: position.size
        });
        position = null;
      }
      continue;
    }

    // Check entry (BUY only for v1 - we can add SELL/short later)
    if (result.signal === 'BUY' && result.entry) {
      const entryPrice = nextBar.open;
      const slip = 1 + (SLIPPAGE_BPS / 10000);
      const adjEntry = entryPrice * slip;
      const highs = slice.map(c => c.high);
      const lows = slice.map(c => c.low);
      const closes = slice.map(c => c.close);
      const atr = ind.ATR(highs, lows, closes, 14);
      const riskDist = Math.max(atr * SL_ATR_MULT, adjEntry * 0.005); // min 0.5% to avoid div by zero
      const rewardDist = atr * TP_ATR_MULT;
      const stopLoss = adjEntry - riskDist;
      const takeProfit = adjEntry + rewardDist;
      const riskAmount = equity * RISK_PER_TRADE;
      const positionSize = Math.min(equity * leverage * 0.95, riskDist > 0 ? (riskAmount / riskDist) * adjEntry : equity * 0.1);
      const entryFees = positionSize * TAKER_FEE;

      if (entryFees + (positionSize / leverage) > equity) continue;

      equity -= entryFees;
      position = {
        direction: 'LONG',
        entry: adjEntry,
        entryBar: t + 1,
        stopLoss,
        takeProfit,
        size: positionSize,
        entryFees
      };
    }
  }

  // Close any open position at end
  if (position) {
    const lastBar = c1h[c1h.length - 1];
    const exitPrice = lastBar.close;
    const slip = 1 + (SLIPPAGE_BPS / 10000);
    const adjExit = exitPrice / slip;
    const exitFees = position.size * TAKER_FEE;
    const pnl = ((adjExit - position.entry) / position.entry) * position.size;
    equity = Math.max(0, equity + pnl - exitFees - position.entryFees);
    trades.push({
      direction: position.direction,
      entry: position.entry,
      exit: adjExit,
      entryBar: position.entryBar,
      exitBar: c1h.length - 1,
      exitTime: lastBar.openTime,
      reason: 'END',
      pnl: pnl - exitFees - position.entryFees,
      size: position.size
    });
  }

  // Build equity curve (sample every 24 bars for size, full on trade events)
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
  const curveMapSorted = [...curveMap.entries()].sort((a, b) => a[0] - b[0]);
  equityCurve.length = 0;
  curveMapSorted.forEach(([bar, data]) => equityCurve.push({ bar, ...data }));

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const maxDrawdown = computeMaxDrawdown(equityCurve);
  const maxDrawdownPct = computeMaxDrawdownPct(equityCurve);

  return {
    trades,
    equityCurve,
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
      finalBalance: equity
    }
  };
}

/**
 * Evaluate strategy on current candles for auto-trade.
 * @param {Object} strategy - { entry, exit }
 * @param {Object} allCandles - { coinId: { '1h': [...] } }
 * @param {string[]} coinIds - coins to evaluate
 * @param {Object} prices - price data for coin info
 * @returns {Array} signals in format { coin, _coinId, _direction, _overallScore, _bestStrat }
 */
function evaluateStrategyForAutoTrade(strategy, allCandles, coinIds, prices = []) {
  const signals = [];
  for (const coinId of coinIds || []) {
    const coinCandles = allCandles?.[coinId]?.['1h'];
    if (!coinCandles || coinCandles.length < 100) continue;
    const t = coinCandles.length - 2;
    const slice = coinCandles.slice(0, t + 1);
    const result = evaluateBar(slice, strategy, t);
    if (result.signal !== 'BUY' || !result.entry) continue;
    const bar = coinCandles[t];
    const nextBar = coinCandles[t + 1];
    const entryPrice = nextBar?.open || bar?.close;
    const highs = slice.map(c => c.high);
    const lows = slice.map(c => c.low);
    const closes = slice.map(c => c.close);
    const atr = ind.ATR(highs, lows, closes, 14);
    const riskDist = Math.max(atr * SL_ATR_MULT_AUTO, entryPrice * 0.005);
    const rewardDist = atr * TP_ATR_MULT_AUTO;
    const stopLoss = entryPrice - riskDist;
    const takeProfit = entryPrice + rewardDist;
    const coinData = Array.isArray(prices) ? prices.find(p => p.id === coinId) : null;
    signals.push({
      coin: coinData || { id: coinId },
      _coinId: coinId,
      _direction: 'LONG',
      _overallScore: 60,
      _bestStrat: { stopLoss, takeProfit1: takeProfit, takeProfit2: takeProfit * 1.2, takeProfit3: takeProfit * 1.5, entry: entryPrice, riskReward: rewardDist / riskDist, id: 'strategy-builder' }
    });
  }
  return signals;
}

module.exports = {
  runCustomBacktest,
  evaluateStrategyForAutoTrade
};
