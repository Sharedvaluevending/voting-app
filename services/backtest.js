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
const PER_COIN_FETCH_TIMEOUT = 180000; // 180s per coin fetch (15m for 1yr = ~175 pages × 600ms ≈ 105s + headroom)

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
  const primaryTf = options.primaryTf || '1h';

  const meta = COIN_META[coinId];
  if (!meta?.bybit) return { error: `No Bitget symbol for ${coinId}` };

  // Warmup in primary TF units (100 bars of whatever TF we're trading on)
  const MS_PER_TF_LOCAL = { '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
  const warmupMs = WARMUP_BARS * (MS_PER_TF_LOCAL[primaryTf] || 3600000);
  const fetchStartMs = startMs - warmupMs;

  // Check cache first (avoids API calls entirely)
  if (useCache) {
    const cached = loadCachedCandles(coinId, fetchStartMs, endMs);
    if (cached) {
      console.log(`[Backtest] ${coinId}: loaded from cache (1h=${cached['1h']?.length || 0})`);
      return cached;
    }
  }

  // Determine which timeframes to fetch based on primary TF.
  // Always fetch the primary + all higher TFs needed for context.
  const TF_HIERARCHY = ['15m', '1h', '4h', '1d'];
  const primaryIdx = TF_HIERARCHY.indexOf(primaryTf);
  const tfsToFetch = primaryIdx >= 0 ? TF_HIERARCHY.slice(primaryIdx) : ['1h', '4h', '1d'];

  let fetchedCandles = {};
  let source = 'bitget';
  let bitgetError = null;
  let krakenError = null;

  // Bitget is primary: fully paginated, supports multi-month date ranges
  try {
    const fetches = tfsToFetch.map(tf => fetchHistoricalCandlesForCoin(coinId, tf, fetchStartMs, endMs));
    const results = await fetchWithTimeout(
      Promise.all(fetches),
      PER_COIN_FETCH_TIMEOUT,
      `${coinId}-bitget`
    );
    tfsToFetch.forEach((tf, i) => { fetchedCandles[tf] = results[i]; });
    if (!fetchedCandles[primaryTf] || fetchedCandles[primaryTf].length === 0) {
      bitgetError = 'Bitget returned 0 candles';
    }
  } catch (err) {
    bitgetError = `Bitget error: ${err.message}`;
    console.warn(`[Backtest] ${coinId}: ${bitgetError}`);
  }

  // Kraken fallback (capped at ~720 bars, but covers many coins)
  if (!fetchedCandles[primaryTf] || fetchedCandles[primaryTf].length < 50) {
    try {
      console.log(`[Backtest] ${coinId}: Bitget failed, trying Kraken fallback...`);
      source = 'kraken';
      const fetches = tfsToFetch.map(tf => fetchHistoricalKrakenCandles(coinId, tf, fetchStartMs, endMs));
      const results = await fetchWithTimeout(
        Promise.all(fetches),
        PER_COIN_FETCH_TIMEOUT,
        `${coinId}-kraken`
      );
      tfsToFetch.forEach((tf, i) => { fetchedCandles[tf] = results[i]; });
      if (!fetchedCandles[primaryTf] || fetchedCandles[primaryTf].length === 0) {
        krakenError = 'Kraken returned 0 candles';
      }
    } catch (err) {
      krakenError = `Kraken error: ${err.message}`;
      console.warn(`[Backtest] ${coinId}: ${krakenError}`);
    }
  }

  const primaryCount = (fetchedCandles[primaryTf] || []).length;
  const logParts = tfsToFetch.map(tf => `${tf}=${(fetchedCandles[tf] || []).length}`).join(', ');
  console.log(`[Backtest] ${coinId}: fetched ${logParts} candles [${source}] (${WARMUP_BARS} warmup, primary=${primaryTf})`);

  if (primaryCount < 50) {
    const details = [bitgetError, krakenError].filter(Boolean).join('; ');
    const reason = primaryCount === 0
      ? `No candles from either API. ${details}`
      : `Only ${primaryCount} ${primaryTf} candles from ${source} (need 50+). ${details}`;
    console.warn(`[Backtest] ${coinId}: ${reason}`);
    return { error: reason };
  }

  const result = {
    '15m': fetchedCandles['15m'] || null,
    '1h': fetchedCandles['1h'] || null,
    '4h': fetchedCandles['4h'] && (fetchedCandles['4h'].length >= 5) ? fetchedCandles['4h'] : null,
    '1d': fetchedCandles['1d'] && (fetchedCandles['1d'].length >= 5) ? fetchedCandles['1d'] : null,
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
  const primaryTf = options.primaryTf || '1h';

  const fetchOpts = {
    useBitgetOnly: options.useBitgetOnly === true,
    useCache: options.useCache === true,
    primaryTf
  };
  const candles = await fetchHistoricalCandlesMultiTF(coinId, startMs, endMs, fetchOpts);
  if (!candles || candles.error) return { error: candles?.error || 'Insufficient candles', trades: [], equityCurve: [] };

  return runBacktestForCoinNew(coinId, startMs, endMs, { ...options, candles, btcCandles: options.btcCandles, primaryTf });
}

// Legacy backtest removed. Backtest uses run-backtest.js (shared engines) exclusively.
/**
 * Run backtest for all coins or a subset.
 * Coins are processed in parallel batches to stay within API rate limits
 * while keeping total time well under Render's 30s request timeout.
 */
const PER_COIN_BACKTEST_TIMEOUT = 120000; // 120s per coin (15m TF = 4× more bars than 1h)
const PARALLEL_BATCH_SIZE = 2; // 2 coins at a time (avoids API rate limits)

async function runBacktest(startMs, endMs, options) {
  options = options || {};
  options.startMs = startMs;
  options.endMs = endMs;
  const coins = options.coins || TRACKED_COINS;
  const results = [];
  const failed = [];
  const backtestStart = Date.now();
  const days = Math.round((endMs - startMs) / 86400000);
  const primaryTf = options.primaryTf || '1h';
  console.log(`[Backtest] Starting: ${coins.length} coins, ${days} days range, TF=${primaryTf} (parallel batches of ${PARALLEL_BATCH_SIZE})`);

  // === PRE-FETCH BTC CANDLES (mirrors live system) ===
  const ft = options.features || {};
  const needBtc = ft.btcFilter !== false || ft.btcCorrelation !== false;
  let btcCandles = null;
  if (needBtc && (!coins.includes('bitcoin') || coins.length > 1)) {
    try {
      console.log(`[Backtest] Pre-fetching BTC candles for signal filter...`);
      btcCandles = await fetchHistoricalCandlesMultiTF('bitcoin', startMs, endMs, { primaryTf: '1h' });
      const btcTf = btcCandles?.['1h'] ? '1h' : primaryTf;
      if (btcCandles && !btcCandles.error && btcCandles[btcTf] && btcCandles[btcTf].length >= 50) {
        console.log(`[Backtest] BTC candles loaded: ${btcCandles[btcTf].length} bars (${btcTf})`);
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

  // Aggregate equity curve: sort all trades by exit time, build combined curve
  const tradesWithExit = allTrades.filter(t => t.exitBar != null || t.exitTime);
  const byExit = [...tradesWithExit].sort((a, b) => {
    const ta = a.exitTime ?? (a.exitBar != null ? startMs + (a.exitBar || 0) * 3600000 : 0);
    const tb = b.exitTime ?? (b.exitBar != null ? startMs + (b.exitBar || 0) * 3600000 : 0);
    return ta - tb;
  });
  const equityCurve = [{ t: 0, equity: totalCapital, date: startMs }];
  let eq = totalCapital;
  byExit.forEach((t, i) => {
    eq += t.pnl || 0;
    equityCurve.push({ t: i + 1, equity: Math.max(0, eq), date: t.exitTime || startMs, trade: i + 1, pnl: t.pnl });
  });

  // Regime breakdown
  const regimeBreakdown = {};
  allTrades.forEach(t => {
    const r = t.regime || 'unknown';
    if (!regimeBreakdown[r]) regimeBreakdown[r] = { trades: 0, wins: 0, pnl: 0 };
    regimeBreakdown[r].trades += 1;
    if ((t.pnl || 0) > 0) regimeBreakdown[r].wins += 1;
    regimeBreakdown[r].pnl += t.pnl || 0;
  });

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
    equityCurve,
    regimeBreakdown,
    allTrades,
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
