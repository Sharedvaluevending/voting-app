// services/backtest.js
// ====================================================
// ROBUST HISTORICAL BACKTEST
// Fetches historical candles, walks bar-by-bar, simulates trades.
// Uses shared engines (SignalEngine, RiskEngine, ManageEngine) - same as live/paper.
// ====================================================

const { ENGINE_CONFIG } = require('./trading-engine');
const { fetchHistoricalCandlesForCoin, fetchHistoricalKrakenCandles, COIN_META, TRACKED_COINS } = require('./crypto-api');
const { loadCachedCandles, saveCachedCandles, BYBIT_DELAY_MS } = require('./backtest-cache');
const { runBacktestForCoin: runBacktestForCoinNew } = require('./backtest/run-backtest');
const fetch = require('node-fetch');

const MIN_SCORE = ENGINE_CONFIG.MIN_SIGNAL_SCORE || 52;
const INITIAL_BALANCE = 10000;
const RISK_PER_TRADE = 0.02;  // 2% per trade
const DEFAULT_LEVERAGE = 2;
const WARMUP_BARS = 100;      // Extra 1h bars to fetch before start date for indicator warmup

/**
 * Fetch multi-timeframe historical candles for a coin
 * Wraps each fetch in a per-coin timeout so one slow coin doesn't block everything.
 */
const PER_COIN_FETCH_TIMEOUT = 15000; // 15s max per coin fetch (keep under Render's 30s req timeout)

async function fetchWithTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout fetching ${label}`)), timeoutMs))
  ]);
}

async function fetchHistoricalCandlesMultiTF(coinId, startMs, endMs, options) {
  options = options || {};
  const useBitgetOnly = options.useBitgetOnly === true;
  const useCache = options.useCache !== false;  // default ON for scripts

  const meta = COIN_META[coinId];
  if (!meta?.bybit) return { error: `No Bitget symbol for ${coinId}` };

  // Extend start backward to get warmup bars for indicator calculation.
  const warmupMs = WARMUP_BARS * 3600000;
  const fetchStartMs = startMs - warmupMs;

  // Check cache first (avoids API calls entirely)
  if (useCache) {
    const cached = loadCachedCandles(coinId, fetchStartMs, endMs);
    if (cached) {
      console.log(`[Backtest] ${coinId}: loaded from cache (1h=${cached['1h']?.length || 0})`);
      return cached;
    }
  }

  let candles1h, candles4h, candles1d;
  let source = 'kraken';
  let krakenError = null;
  let bitgetError = null;

  // useBitgetOnly: skip Kraken entirely to avoid rate limits
  if (!useBitgetOnly) {
    try {
      [candles1h, candles4h, candles1d] = await fetchWithTimeout(
        Promise.all([
          fetchHistoricalKrakenCandles(coinId, '1h', fetchStartMs, endMs),
          fetchHistoricalKrakenCandles(coinId, '4h', fetchStartMs, endMs),
          fetchHistoricalKrakenCandles(coinId, '1d', fetchStartMs, endMs)
        ]),
        PER_COIN_FETCH_TIMEOUT,
        `${coinId}-kraken`
      );
      if (!candles1h || candles1h.length === 0) krakenError = 'Kraken returned 0 candles';
    } catch (err) {
      krakenError = `Kraken error: ${err.message}`;
      console.warn(`[Backtest] ${coinId}: ${krakenError}`);
    }
  }

  if (useBitgetOnly || !candles1h || candles1h.length < 50) {
    try {
      if (!useBitgetOnly) console.log(`[Backtest] ${coinId}: trying Bitget...`);
      source = 'bitget';
      [candles1h, candles4h, candles1d] = await fetchWithTimeout(
        Promise.all([
          fetchHistoricalCandlesForCoin(coinId, '1h', fetchStartMs, endMs),
          fetchHistoricalCandlesForCoin(coinId, '4h', fetchStartMs, endMs),
          fetchHistoricalCandlesForCoin(coinId, '1d', fetchStartMs, endMs)
        ]),
        PER_COIN_FETCH_TIMEOUT,
        coinId
      );
      if (!candles1h || candles1h.length === 0) bitgetError = 'Bitget returned 0 candles';
    } catch (err) {
      bitgetError = `Bitget error: ${err.message}`;
      console.warn(`[Backtest] ${coinId}: ${bitgetError}`);
    }
  }

  const c1h = (candles1h || []).length;
  const c4h = (candles4h || []).length;
  const c1d = (candles1d || []).length;
  console.log(`[Backtest] ${coinId}: fetched 1h=${c1h}, 4h=${c4h}, 1d=${c1d} candles [${source}] (${WARMUP_BARS} warmup)`);

  if (!candles1h || c1h < 50) {
    const details = [bitgetError, krakenError].filter(Boolean).join('; ');
    const reason = c1h === 0
      ? `No candles from either API. ${details}`
      : `Only ${c1h} candles from ${source} (need 50+). ${details}`;
    console.warn(`[Backtest] ${coinId}: ${reason}`);
    return { error: reason };
  }

  const result = {
    '1h': candles1h,
    '4h': candles4h && c4h >= 5 ? candles4h : null,
    '1d': candles1d && c1d >= 5 ? candles1d : null,
    '15m': null,
    '1w': null
  };
  if (useCache) saveCachedCandles(coinId, fetchStartMs, endMs, result);
  return result;
}

/**
 * Run backtest for one coin.
 * Uses shared engines (SignalEngine, RiskEngine, ManageEngine) - same as live/paper trading.
 */
async function runBacktestForCoin(coinId, startMs, endMs, options) {
  options = options || {};

  const fetchOpts = {
    useBitgetOnly: options.useBitgetOnly === true,
    useCache: options.useCache === true
  };
  const candles = await fetchHistoricalCandlesMultiTF(coinId, startMs, endMs, fetchOpts);
  if (!candles || candles.error) return { error: candles?.error || 'Insufficient candles', trades: [], equityCurve: [] };

  return runBacktestForCoinNew(coinId, startMs, endMs, { ...options, candles, btcCandles: options.btcCandles });
}

// Legacy backtest removed. Backtest uses run-backtest.js (shared engines) exclusively.
/**
 * Run backtest for all coins or a subset.
 * Coins are processed in parallel batches to stay within API rate limits
 * while keeping total time well under Render's 30s request timeout.
 */
const PER_COIN_BACKTEST_TIMEOUT = 12000; // 12s max per coin (fits ~30s hosting timeout)
const PARALLEL_BATCH_SIZE = 2; // 2 coins at a time (stays under Render/Heroku 30s limit)

async function runBacktest(startMs, endMs, options) {
  options = options || {};
  const coins = options.coins || TRACKED_COINS;
  const results = [];
  const failed = [];
  const backtestStart = Date.now();
  const days = Math.round((endMs - startMs) / 86400000);
  console.log(`[Backtest] Starting: ${coins.length} coins, ${days} days range (parallel batches of ${PARALLEL_BATCH_SIZE})`);

  // === PRE-FETCH BTC CANDLES (mirrors live system) ===
  // The live system analyzes BTC first and uses the result to filter altcoin signals.
  // We fetch BTC candles once and share across all coin backtests.
  // Skip entirely if both BTC features are toggled off (saves API call time)
  const ft = options.features || {};
  const needBtc = ft.btcFilter !== false || ft.btcCorrelation !== false;
  let btcCandles = null;
  if (needBtc && (!coins.includes('bitcoin') || coins.length > 1)) {
    try {
      console.log(`[Backtest] Pre-fetching BTC candles for signal filter...`);
      btcCandles = await fetchHistoricalCandlesMultiTF('bitcoin', startMs, endMs);
      if (btcCandles && !btcCandles.error && btcCandles['1h'] && btcCandles['1h'].length >= 50) {
        console.log(`[Backtest] BTC candles loaded: ${btcCandles['1h'].length} bars`);
      } else {
        console.warn(`[Backtest] BTC candle fetch failed (${btcCandles?.error || 'insufficient data'}) - running without BTC filter`);
        btcCandles = null;
      }
    } catch (err) {
      console.warn(`[Backtest] BTC candle fetch error: ${err.message} - running without BTC filter`);
      btcCandles = null;
    }
  }

  // Process coins in parallel batches
  for (let i = 0; i < coins.length; i += PARALLEL_BATCH_SIZE) {
    const batch = coins.slice(i, i + PARALLEL_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (coinId) => {
        const coinStart = Date.now();
        try {
          const optionsWithBtc = { ...options, btcCandles: coinId !== 'bitcoin' ? btcCandles : null };
          const result = await fetchWithTimeout(
            runBacktestForCoin(coinId, startMs, endMs, optionsWithBtc),
            PER_COIN_BACKTEST_TIMEOUT,
            `backtest ${coinId}`
          );
          const elapsed = ((Date.now() - coinStart) / 1000).toFixed(1);
          console.log(`[Backtest] ${coinId}: ${result.error ? 'FAILED - ' + result.error : result.totalTrades + ' trades'} (${elapsed}s)`);
          return { coinId, result };
        } catch (err) {
          const elapsed = ((Date.now() - coinStart) / 1000).toFixed(1);
          console.error(`[Backtest] ${coinId}: ERROR - ${err.message} (${elapsed}s)`);
          return { coinId, result: { coinId, error: err.message, trades: [] } };
        }
      })
    );
    for (const settled of batchResults) {
      const { coinId, result } = settled.status === 'fulfilled' ? settled.value : { coinId: 'unknown', result: { error: settled.reason?.message, trades: [] } };
      results.push(result);
      if (result.error) failed.push({ coinId, error: result.error });
    }
    // Small delay between batches to avoid rate limits
    if (i + PARALLEL_BATCH_SIZE < coins.length) await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[Backtest] Done: ${results.length - failed.length}/${results.length} coins succeeded in ${((Date.now() - backtestStart) / 1000).toFixed(1)}s`);

  const successResults = results.filter(r => !r.error);
  const allTrades = successResults.flatMap(r => (r.trades || []).map(t => ({ ...t, coinId: r.coinId, symbol: r.symbol })));
  const totalWins = allTrades.filter(t => t.pnl > 0).length;
  const totalLosses = allTrades.filter(t => t.pnl <= 0).length;
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const usedInitialBalance = options.initialBalance ?? INITIAL_BALANCE;
  // Capital aggregation: each coin runs with its own balance, so total capital = coins × balance
  const totalCapital = Math.max(1, successResults.length) * usedInitialBalance;
  const returnPct = totalCapital > 0 ? (totalPnl / totalCapital) * 100 : 0;

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
      returnPct,
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
