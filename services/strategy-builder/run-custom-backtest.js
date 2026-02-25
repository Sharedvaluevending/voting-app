// services/strategy-builder/run-custom-backtest.js
// ====================================================
// CUSTOM BACKTEST - Uses rule engine instead of SignalEngine
// Reuses candle fetch, execution sim, analytics
// ====================================================

const { evaluateBar } = require('./rule-engine');
const ind = require('../../lib/indicators');
const { runBacktestForCoin: fetchAndRun } = require('../backtest');
const { computeMaxDrawdown, computeMaxDrawdownPct } = require('../backtest/analytics');

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
    if (cached && cached['1h']) {
      candles = cached;
    } else {
      try {
        let c1h = await fetchHistoricalKrakenCandles(coinId, '1h', fetchStartMs, endMs),
            c4h = await fetchHistoricalKrakenCandles(coinId, '4h', fetchStartMs, endMs),
            c1d = await fetchHistoricalKrakenCandles(coinId, '1d', fetchStartMs, endMs);
        if (!c1h || c1h.length < 50) {
          c1h = await fetchHistoricalCandlesForCoin(coinId, '1h', fetchStartMs, endMs);
          c4h = await fetchHistoricalCandlesForCoin(coinId, '4h', fetchStartMs, endMs);
          c1d = await fetchHistoricalCandlesForCoin(coinId, '1d', fetchStartMs, endMs);
        }
        candles = { '1h': c1h, '4h': c4h, '1d': c1d };
        saveCachedCandles(coinId, fetchStartMs, endMs, candles);
      } catch (err) {
        return { error: err.message || 'Failed to fetch candles', trades: [], equityCurve: [] };
      }
    }
  }

  const c1h = candles['1h'];
  if (!c1h || c1h.length < 100) {
    return { error: 'Insufficient candle data', trades: [], equityCurve: [] };
  }

  // Find start bar index
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

  for (let t = startBar; t < c1h.length - 1; t++) {
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
      const riskDist = atr * SL_ATR_MULT;
      const rewardDist = atr * TP_ATR_MULT;
      const stopLoss = adjEntry - riskDist;
      const takeProfit = adjEntry + rewardDist;
      const riskAmount = equity * RISK_PER_TRADE;
      const positionSize = Math.min(equity * leverage * 0.95, (riskAmount / riskDist) * adjEntry);
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

module.exports = {
  runCustomBacktest
};
