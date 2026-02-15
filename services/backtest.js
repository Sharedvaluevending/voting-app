// services/backtest.js
// ====================================================
// ROBUST HISTORICAL BACKTEST
// Fetches historical candles, walks bar-by-bar, simulates trades.
// ====================================================

const { analyzeCoin, ENGINE_CONFIG } = require('./trading-engine');
const { fetchHistoricalCandlesForCoin, COIN_META, TRACKED_COINS } = require('./crypto-api');

const MIN_SCORE = ENGINE_CONFIG.MIN_SIGNAL_SCORE || 52;
const INITIAL_BALANCE = 10000;
const RISK_PER_TRADE = 0.02;  // 2% per trade
const DEFAULT_LEVERAGE = 2;
const WARMUP_BARS = 100;      // Extra 1h bars to fetch before start date for indicator warmup

/**
 * Fetch multi-timeframe historical candles for a coin
 * Wraps each fetch in a per-coin timeout so one slow coin doesn't block everything.
 */
const PER_COIN_FETCH_TIMEOUT = 30000; // 30s max per coin fetch

async function fetchWithTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout fetching ${label}`)), timeoutMs))
  ]);
}

async function fetchHistoricalCandlesMultiTF(coinId, startMs, endMs) {
  const meta = COIN_META[coinId];
  if (!meta?.bybit) return null;

  // Extend start backward to get warmup bars for indicator calculation.
  // Without warmup, short date ranges (e.g. 3 days) don't have enough candles
  // for EMA/ATR/ADX to stabilize before the first trade.
  const warmupMs = WARMUP_BARS * 3600000; // each 1h bar = 3.6M ms
  const fetchStartMs = startMs - warmupMs;

  try {
    const [candles1h, candles4h, candles1d] = await fetchWithTimeout(
      Promise.all([
        fetchHistoricalCandlesForCoin(coinId, '1h', fetchStartMs, endMs),
        fetchHistoricalCandlesForCoin(coinId, '4h', fetchStartMs, endMs),
        fetchHistoricalCandlesForCoin(coinId, '1d', fetchStartMs, endMs)
      ]),
      PER_COIN_FETCH_TIMEOUT,
      coinId
    );

    console.log(`[Backtest] ${coinId}: fetched 1h=${(candles1h||[]).length}, 4h=${(candles4h||[]).length}, 1d=${(candles1d||[]).length} candles (${WARMUP_BARS} warmup)`);

    if (!candles1h || candles1h.length < 50) {
      console.warn(`[Backtest] ${coinId}: insufficient 1h candles (${(candles1h||[]).length} < 50)`);
      return null;
    }

    return {
      '1h': candles1h,
      '4h': candles4h && candles4h.length >= 5 ? candles4h : null,
      '1d': candles1d && candles1d.length >= 5 ? candles1d : null,
      '15m': null,
      '1w': null
    };
  } catch (err) {
    console.error(`[Backtest] ${coinId}: candle fetch failed - ${err.message}`);
    return null;
  }
}

/**
 * Build candles object sliced at bar index t (for 1h as primary)
 */
function sliceCandlesAt(candles, t) {
  if (!candles || !candles['1h'] || t >= candles['1h'].length) return null;
  const c1h = candles['1h'];
  const slice = {
    '1h': c1h.slice(0, t + 1),
    '4h': candles['4h'] && candles['4h'].length > 0 ? candles['4h'].slice(0, Math.min(Math.floor(t / 4) + 1, candles['4h'].length)) : null,
    '1d': candles['1d'] && candles['1d'].length > 0 ? candles['1d'].slice(0, Math.min(Math.floor(t / 24) + 1, candles['1d'].length)) : null,
    '15m': null,
    '1w': null
  };
  if (slice['1h'].length < 20) return null;
  return slice;
}

/**
 * Build coinData for backtest at bar t
 */
function buildCoinData(coinId, candles, t) {
  const c1h = candles['1h'];
  const bar = c1h[t];
  const meta = COIN_META[coinId];
  const price = bar.close;
  const prev24 = t >= 24 ? c1h[t - 24].close : 0;
  const change24h = prev24 > 0 ? ((price - prev24) / prev24) * 100 : 0;
  return {
    id: coinId,
    symbol: meta?.symbol || coinId.toUpperCase(),
    name: meta?.name || coinId,
    price,
    change24h,
    volume24h: 0,
    marketCap: 0,
    lastUpdated: new Date(bar.openTime)
  };
}

/**
 * Run backtest for one coin
 */
async function runBacktestForCoin(coinId, startMs, endMs, options) {
  options = options || {};
  const minScore = options.minScore ?? MIN_SCORE;
  const leverage = options.leverage ?? DEFAULT_LEVERAGE;

  const candles = await fetchHistoricalCandlesMultiTF(coinId, startMs, endMs);
  if (!candles) return { error: 'Insufficient candles', trades: [], equityCurve: [] };

  const c1h = candles['1h'];
  const trades = [];
  let equity = INITIAL_BALANCE;
  let position = null;  // { direction, entry, entryBar, stopLoss, takeProfit1, size }

  // Find the first bar at or after the user's requested start date.
  // Bars before this are warmup-only: used for indicator calculation but no new trades.
  let tradeStartBar = 50; // minimum warmup
  for (let i = 0; i < c1h.length; i++) {
    if (c1h[i].openTime >= startMs) {
      tradeStartBar = Math.max(50, i);
      break;
    }
  }

  const history = { prices: [], volumes: [], marketCaps: [] };

  for (let t = 50; t < c1h.length - 1; t++) {
    const bar = c1h[t];
    const nextBar = c1h[t + 1];
    const slice = sliceCandlesAt(candles, t);
    if (!slice) continue;

    const coinData = buildCoinData(coinId, candles, t);
    const options_bt = { strategyWeights: options.strategyWeights || [], btcSignal: null, fundingRates: {} };

    // Check if we have an open position - did SL or TP hit?
    if (position) {
      const high = nextBar.high;
      const low = nextBar.low;
      let closed = false;
      let exitPrice = nextBar.close;
      let reason = '';

      if (position.direction === 'LONG') {
        if (position.stopLoss && low <= position.stopLoss) {
          closed = true;
          exitPrice = position.stopLoss;
          reason = 'SL';
        } else if (position.takeProfit1 && high >= position.takeProfit1) {
          closed = true;
          exitPrice = position.takeProfit1;
          reason = 'TP1';
        }
      } else {
        if (position.stopLoss && high >= position.stopLoss) {
          closed = true;
          exitPrice = position.stopLoss;
          reason = 'SL';
        } else if (position.takeProfit1 && low <= position.takeProfit1) {
          closed = true;
          exitPrice = position.takeProfit1;
          reason = 'TP1';
        }
      }

      if (closed) {
        const pnl = position.direction === 'LONG'
          ? ((exitPrice - position.entry) / position.entry) * position.size
          : ((position.entry - exitPrice) / position.entry) * position.size;
        equity += pnl;
        trades.push({
          direction: position.direction,
          entry: position.entry,
          exit: exitPrice,
          entryBar: position.entryBar,
          exitBar: t + 1,
          reason,
          pnl,
          size: position.size
        });
        position = null;
      }
      continue;
    }

    // No position - look for entry (only within user's requested date range)
    if (t < tradeStartBar) continue; // warmup period — skip trade entries
    const signal = analyzeCoin(coinData, slice, history, options_bt);
    const canLong = signal.signal === 'BUY' || signal.signal === 'STRONG_BUY';
    const canShort = signal.signal === 'SELL' || signal.signal === 'STRONG_SELL';

    if ((canLong || canShort) && signal.score >= minScore && signal.stopLoss && signal.takeProfit1) {
      const direction = canLong ? 'LONG' : 'SHORT';
      const entry = nextBar.open;  // Enter at next bar open
      const slDist = Math.abs(entry - signal.stopLoss);
      if (slDist <= 0) continue;
      const riskAmount = equity * RISK_PER_TRADE;
      const size = (riskAmount * entry) / slDist;
      const actualSize = Math.min(size, equity * 0.95);
      position = {
        direction,
        entry,
        entryBar: t + 1,
        stopLoss: signal.stopLoss,
        takeProfit1: signal.takeProfit1,
        size: actualSize
      };
    }
  }

  // Build equity curve
  const equityCurve = [{ t: 0, equity: INITIAL_BALANCE, date: c1h[0]?.openTime }];
  let runningEquity = INITIAL_BALANCE;
  trades.forEach((tr, i) => {
    runningEquity += tr.pnl;
    equityCurve.push({ t: tr.exitBar, equity: runningEquity, date: c1h[tr.exitBar]?.openTime, trade: i + 1 });
  });

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

  return {
    coinId,
    symbol: COIN_META[coinId]?.symbol,
    startMs,
    endMs,
    bars: c1h.length,
    trades,
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    totalPnl,
    profitFactor,
    finalEquity: INITIAL_BALANCE + totalPnl,
    returnPct: ((totalPnl / INITIAL_BALANCE) * 100),
    equityCurve,
    maxDrawdown: computeMaxDrawdown(equityCurve),
    maxDrawdownPct: computeMaxDrawdownPct(equityCurve)
  };
}

function computeMaxDrawdown(equityCurve) {
  let peak = equityCurve[0]?.equity || INITIAL_BALANCE;
  let maxDd = 0;
  equityCurve.forEach(p => {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDd) maxDd = dd;
  });
  return maxDd;
}

function computeMaxDrawdownPct(equityCurve) {
  let peak = equityCurve[0]?.equity || INITIAL_BALANCE;
  let maxDdPct = 0;
  equityCurve.forEach(p => {
    if (p.equity > peak) peak = p.equity;
    const ddPct = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  });
  return maxDdPct;
}

/**
 * Run backtest for all coins or a subset
 */
const PER_COIN_BACKTEST_TIMEOUT = 45000; // 45s max per coin simulation

async function runBacktest(startMs, endMs, options) {
  options = options || {};
  const coins = options.coins || TRACKED_COINS;
  const results = [];
  const failed = [];
  const backtestStart = Date.now();
  const days = Math.round((endMs - startMs) / 86400000);
  console.log(`[Backtest] Starting: ${coins.length} coins, ${days} days range`);

  for (const coinId of coins) {
    const coinStart = Date.now();
    try {
      const result = await fetchWithTimeout(
        runBacktestForCoin(coinId, startMs, endMs, options),
        PER_COIN_BACKTEST_TIMEOUT,
        `backtest ${coinId}`
      );
      const elapsed = ((Date.now() - coinStart) / 1000).toFixed(1);
      console.log(`[Backtest] ${coinId}: ${result.error ? 'FAILED - ' + result.error : result.totalTrades + ' trades'} (${elapsed}s)`);
      results.push(result);
      if (result.error) failed.push({ coinId, error: result.error });
      if (options.delay) await new Promise(r => setTimeout(r, options.delay));
    } catch (err) {
      const elapsed = ((Date.now() - coinStart) / 1000).toFixed(1);
      console.error(`[Backtest] ${coinId}: ERROR - ${err.message} (${elapsed}s)`);
      results.push({ coinId, error: err.message, trades: [] });
      failed.push({ coinId, error: err.message });
    }
  }
  console.log(`[Backtest] Done: ${results.length - failed.length}/${results.length} coins succeeded in ${((Date.now() - backtestStart) / 1000).toFixed(1)}s`);

  const successResults = results.filter(r => !r.error);
  const allTrades = successResults.flatMap(r => (r.trades || []).map(t => ({ ...t, coinId: r.coinId, symbol: r.symbol })));
  const totalWins = allTrades.filter(t => t.pnl > 0).length;
  const totalLosses = allTrades.filter(t => t.pnl <= 0).length;
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));

  const totalBars = successResults.reduce((s, r) => s + (r.bars || 0), 0);
  return {
    results,
    failed,
    summary: {
      totalTrades: allTrades.length,
      wins: totalWins,
      losses: totalLosses,
      winRate: allTrades.length > 0 ? (totalWins / allTrades.length) * 100 : 0,
      totalPnl,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0),
      returnPct: ((totalPnl / INITIAL_BALANCE) * 100),
      coinsProcessed: successResults.length,
      coinsFailed: failed.length,
      totalBars
    },
    startMs,
    endMs
  };
}

module.exports = {
  runBacktest,
  runBacktestForCoin,
  fetchHistoricalCandlesMultiTF,
  MIN_SCORE,
  INITIAL_BALANCE
};
