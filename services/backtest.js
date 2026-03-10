// services/backtest.js
// ====================================================
// ROBUST HISTORICAL BACKTEST
// Fetches historical candles, walks bar-by-bar, simulates trades.
// Uses shared engines (SignalEngine, RiskEngine, ManageEngine) - same as live/paper.
// ====================================================

const { ENGINE_CONFIG } = require('./trading-engine');
const { fetchHistoricalKrakenCandles, COIN_META, TRACKED_COINS, markBacktestLoad } = require('./crypto-api');
const { loadCachedCandles, saveCachedCandles } = require('./backtest-cache');
const { getCandles } = require('./candle-cache');
const { runBacktestForCoin: runBacktestForCoinNew } = require('./backtest/run-backtest');
const { computeMaxDrawdownPct } = require('./backtest/analytics');

const MIN_SCORE = ENGINE_CONFIG.MIN_SIGNAL_SCORE || 52;
const INITIAL_BALANCE = 10000;
const DEFAULT_RISK_PER_TRADE = 0.02;
const DEFAULT_LEVERAGE = 2;
const WARMUP_BARS = 100;      // Extra 1h bars to fetch before start date for indicator warmup
const MAX_DOLLAR_RISK_FRACTION = 0.10;

/**
 * Fetch multi-timeframe historical candles for a coin
 * Wraps each fetch in a per-coin timeout so one slow coin doesn't block everything.
 */
const PER_COIN_FETCH_TIMEOUT = 600000; // 10 min per coin (1yr 1h = ~52 pages; 429 waits can be long)

async function fetchWithTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => {
      const mins = Math.round(timeoutMs / 60000);
      reject(new Error(`Timeout fetching ${label} (exceeded ${mins} min). 1yr+ is supported; try 1h/4h TF or fewer coins if slow.`));
    }, timeoutMs))
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
  const MS_PER_TF_LOCAL = { '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000 };
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

  // Determine which timeframes to fetch. Engine requires 1h, 4h, 1d for analysis.
  // Always fetch 1h+4h+1d; add 15m only when primary is 15m; add 1w when primary is 1w.
  const tfsToFetch = primaryTf === '15m'
    ? ['15m', '1h', '4h', '1d']
    : primaryTf === '1w'
    ? ['1w', '1h', '4h', '1d']
    : ['1h', '4h', '1d'];

  let fetchedCandles = {};
  const sourceByTf = {};
  let source = 'bitget';
  let bitgetError = null;
  let krakenError = null;

  // Bitget is primary: fetch TFs sequentially to avoid rate limits
  try {
    const fetchStartTime = Date.now();
    for (const tf of tfsToFetch) {
      const elapsed = Date.now() - fetchStartTime;
      if (elapsed > PER_COIN_FETCH_TIMEOUT) throw new Error(`Timeout fetching ${coinId}-bitget (exceeded ${Math.round(PER_COIN_FETCH_TIMEOUT / 60000)} min)`);
      console.log(`[Backtest] ${coinId}: fetching ${tf} candles...`);
      const cachedOrLive = await getCandles(coinId, tf, fetchStartMs, endMs);
      fetchedCandles[tf] = cachedOrLive.candles || [];
      sourceByTf[tf] = cachedOrLive.source || 'live';
      if (tf !== tfsToFetch[tfsToFetch.length - 1]) await new Promise(r => setTimeout(r, 300));
    }
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
      console.log(`[Backtest] ${coinId}: Bitget insufficient (${fetchedCandles[primaryTf]?.length || 0} candles), trying Kraken fallback...`);
      source = 'kraken';
      for (const tf of tfsToFetch) {
        fetchedCandles[tf] = await fetchHistoricalKrakenCandles(coinId, tf, fetchStartMs, endMs);
        sourceByTf[tf] = 'kraken';
        await new Promise(r => setTimeout(r, 200));
      }
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
    '1w': fetchedCandles['1w'] && (fetchedCandles['1w'].length >= 5) ? fetchedCandles['1w'] : null,
    _sourceByTf: sourceByTf
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
  const sourceByTf = candles._sourceByTf || {};
  const primarySource = sourceByTf[primaryTf] || sourceByTf['1h'] || 'live';
  const backtestResult = await runBacktestForCoinNew(coinId, startMs, endMs, { ...options, candles, btcCandles: options.btcCandles, primaryTf });
  return {
    ...backtestResult,
    dataSource: primarySource,
    sourceByTf
  };
}

// Legacy backtest removed. Backtest uses run-backtest.js (shared engines) exclusively.
/**
 * Run backtest for all coins or a subset.
 * Coins are processed in parallel batches to stay within API rate limits.
 * Per-coin timeout allows long candle fetches (e.g. 1yr 15m = ~175 Bitget pages).
 */
const PER_COIN_BACKTEST_TIMEOUT = 900000; // 15 min per coin (1yr fetches can take 3-5 min + backtest run)
const PARALLEL_BATCH_SIZE = 1; // 1 coin at a time — avoids API rate limits that cause empty pages

async function runBacktest(startMs, endMs, options) {
  markBacktestLoad(1);
  try {
  options = options || {};
  const usedInitialBalance = options.initialBalance ?? INITIAL_BALANCE;
  const requestedRiskDollarsPerTrade = options.riskDollarsPerTrade ?? 200;
  let appliedRiskDollarsPerTrade = requestedRiskDollarsPerTrade;
  let riskWarnings = [];
  if ((options.riskMode || 'percent') === 'dollar' && usedInitialBalance > 0) {
    const maxAllowed = Math.max(1, usedInitialBalance * MAX_DOLLAR_RISK_FRACTION);
    if (requestedRiskDollarsPerTrade > maxAllowed) {
      appliedRiskDollarsPerTrade = maxAllowed;
      riskWarnings.push(`Risk per trade exceeds 10% of account — consider lowering. Auto-capped from $${requestedRiskDollarsPerTrade.toFixed(2)} to $${appliedRiskDollarsPerTrade.toFixed(2)}.`);
    }
  }
  options.riskDollarsPerTrade = appliedRiskDollarsPerTrade;
  options.startMs = startMs;
  options.endMs = endMs;
  const coins = options.coins || TRACKED_COINS;
  const results = [];
  const failed = [];
  const backtestStart = Date.now();
  const days = Math.round((endMs - startMs) / 86400000);
  const primaryTf = options.primaryTf || '1h';
  const onProgress = options.onProgress;
  console.log(`[Backtest] Starting: ${coins.length} coins, ${days} days range, TF=${primaryTf} (parallel batches of ${PARALLEL_BATCH_SIZE})`);

  // === PRE-FETCH BTC CANDLES (mirrors live system) ===
  const ft = options.features || {};
  const needBtc = ft.btcFilter !== false || ft.btcCorrelation !== false;
  let btcCandles = null;
  if (needBtc && (!coins.includes('bitcoin') || coins.length > 1)) {
    try {
      if (onProgress) onProgress('Fetching BTC candles for signal filter...');
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
    if (onProgress) onProgress(`Processing ${batch.join(', ')} (${i + batch.length}/${coins.length} coins)...`);
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
  const capitalMode = options.capitalMode || 'perCoin';

  // Compute max concurrent exposure: how many positions were open simultaneously
  let maxConcurrentPositions = 0;
  if (allTrades.length > 0) {
    const events = [];
    for (const t of allTrades) {
      const entryTime = t.exitTime ? (t.exitTime - ((t.exitBar - t.entryBar) || 1) * 3600000) : startMs;
      const exitTime = t.exitTime || endMs;
      events.push({ time: entryTime, delta: 1 });
      events.push({ time: exitTime, delta: -1 });
    }
    events.sort((a, b) => a.time - b.time || a.delta - b.delta);
    let concurrent = 0;
    for (const e of events) {
      concurrent += e.delta;
      if (concurrent > maxConcurrentPositions) maxConcurrentPositions = concurrent;
    }
  }

  let totalCapital, returnPct;
  if (capitalMode === 'shared') {
    totalCapital = usedInitialBalance;
    returnPct = usedInitialBalance > 0 ? (totalPnl / usedInitialBalance) * 100 : 0;
  } else {
    totalCapital = Math.max(1, successResults.length) * usedInitialBalance;
    returnPct = totalCapital > 0 ? (totalPnl / totalCapital) * 100 : 0;
  }

  const totalBars = successResults.reduce((s, r) => s + (r.bars || 0), 0);
  const cachedCoins = successResults.filter((r) => r.dataSource === 'cache').length;
  const liveCoins = successResults.filter((r) => r.dataSource !== 'cache').length;

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
  const maxDrawdownPctAggregateRealized = equityCurve.length > 1 ? computeMaxDrawdownPct(equityCurve) : 0;
  const maxDrawdownPctWorstCoinRealized = successResults.reduce((m, r) => {
    const dd = r.maxDrawdownPctRealized ?? r.maxDrawdownPct ?? 0;
    return dd > m ? dd : m;
  }, 0);
  const maxDrawdownPctWorstCoinMtm = successResults.reduce((m, r) => {
    const dd = r.maxDrawdownPctMtm ?? r.maxDrawdownPct ?? 0;
    return dd > m ? dd : m;
  }, 0);

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
      totalBars,
      initialBalance: usedInitialBalance,
      capitalMode,
      totalCapital,
      maxConcurrentPositions,
      cachedCoins,
      liveCoins,
      riskMode: options.riskMode || 'percent',
      riskPerTrade: options.riskPerTrade ?? 2,
      riskDollarsPerTradeRequested: requestedRiskDollarsPerTrade,
      riskDollarsPerTrade: appliedRiskDollarsPerTrade,
      riskWarnings,
      maxDrawdownPctAggregateRealized,
      maxDrawdownPctWorstCoinRealized,
      maxDrawdownPctWorstCoinMtm
    },
    equityCurve,
    regimeBreakdown,
    allTrades,
    startMs,
    endMs
  };
  } finally {
    markBacktestLoad(-1);
  }
}

module.exports = {
  runBacktest,
  runBacktestForCoin,
  fetchHistoricalCandlesMultiTF,
  MIN_SCORE,
  INITIAL_BALANCE
};
