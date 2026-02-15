// services/backtest.js
// ====================================================
// ROBUST HISTORICAL BACKTEST
// Fetches historical candles, walks bar-by-bar, simulates trades.
// ====================================================

const { analyzeCoin, ENGINE_CONFIG } = require('./trading-engine');
const { fetchHistoricalCandlesForCoin, fetchHistoricalKrakenCandles, COIN_META, TRACKED_COINS } = require('./crypto-api');
const fetch = require('node-fetch');

const MIN_SCORE = ENGINE_CONFIG.MIN_SIGNAL_SCORE || 52;
const INITIAL_BALANCE = 10000;
const RISK_PER_TRADE = 0.02;  // 2% per trade
const DEFAULT_LEVERAGE = 2;
const WARMUP_BARS = 100;      // Extra 1h bars to fetch before start date for indicator warmup

// === POSITION MANAGEMENT: mirrors live paper-trading.js ===
const TP1_PCT = 0.4;   // 40% at TP1
const TP2_PCT = 0.3;   // 30% at TP2
const TP3_PCT = 0.3;   // 30% at TP3 (remaining)
const SLIPPAGE_BPS = 5; // 0.05% slippage on entry/exit
const BREAKEVEN_R = 1;  // Move stop to breakeven at 1R profit
const TRAILING_START_R = 1.5; // Start trailing at 1.5R
const TRAILING_DIST_R = 1;   // Trail 1R behind best price

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

async function fetchHistoricalCandlesMultiTF(coinId, startMs, endMs) {
  const meta = COIN_META[coinId];
  if (!meta?.bybit) return { error: `No Bybit symbol for ${coinId}` };

  // Extend start backward to get warmup bars for indicator calculation.
  // Without warmup, short date ranges (e.g. 3 days) don't have enough candles
  // for EMA/ATR/ADX to stabilize before the first trade.
  const warmupMs = WARMUP_BARS * 3600000; // each 1h bar = 3.6M ms
  const fetchStartMs = startMs - warmupMs;

  // Kraken is primary for backtest (Bybit returns 403 from cloud servers like Render).
  // Try Kraken first, fall back to Bybit (which works locally).
  let candles1h, candles4h, candles1d;
  let source = 'kraken';
  let krakenError = null;
  let bybitError = null;

  // Try Kraken first (works from cloud servers)
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
    if (!candles1h || candles1h.length === 0) {
      krakenError = 'Kraken returned 0 candles';
    }
  } catch (err) {
    krakenError = `Kraken error: ${err.message}`;
    console.warn(`[Backtest] ${coinId}: ${krakenError}`);
  }

  // Fallback to Bybit if Kraken failed (works locally)
  if (!candles1h || candles1h.length < 50) {
    try {
      console.log(`[Backtest] ${coinId}: Kraken got ${(candles1h||[]).length} candles, trying Bybit...`);
      source = 'bybit';
      [candles1h, candles4h, candles1d] = await fetchWithTimeout(
        Promise.all([
          fetchHistoricalCandlesForCoin(coinId, '1h', fetchStartMs, endMs),
          fetchHistoricalCandlesForCoin(coinId, '4h', fetchStartMs, endMs),
          fetchHistoricalCandlesForCoin(coinId, '1d', fetchStartMs, endMs)
        ]),
        PER_COIN_FETCH_TIMEOUT,
        coinId
      );
      if (!candles1h || candles1h.length === 0) {
        bybitError = 'Bybit returned 0 candles (HTTP 403 - blocked)';
      }
    } catch (err) {
      bybitError = `Bybit error: ${err.message}`;
      console.warn(`[Backtest] ${coinId}: ${bybitError}`);
    }
  }

  const c1h = (candles1h || []).length;
  const c4h = (candles4h || []).length;
  const c1d = (candles1d || []).length;
  console.log(`[Backtest] ${coinId}: fetched 1h=${c1h}, 4h=${c4h}, 1d=${c1d} candles [${source}] (${WARMUP_BARS} warmup)`);

  if (!candles1h || c1h < 50) {
    // Build a helpful error with details about what went wrong
    const details = [bybitError, krakenError].filter(Boolean).join('; ');
    const reason = c1h === 0
      ? `No candles from either API. ${details}`
      : `Only ${c1h} candles from ${source} (need 50+). ${details}`;
    console.warn(`[Backtest] ${coinId}: ${reason}`);
    return { error: reason };
  }

  return {
    '1h': candles1h,
    '4h': candles4h && c4h >= 5 ? candles4h : null,
    '1d': candles1d && c1d >= 5 ? candles1d : null,
    '15m': null,
    '1w': null
  };
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
 * Run backtest for one coin.
 * Mirrors the live system: analyzes BTC at each bar to get btcSignal/btcDirection,
 * passes BTC candles for correlation penalty, applies the same filters.
 */
async function runBacktestForCoin(coinId, startMs, endMs, options) {
  options = options || {};
  const minScore = options.minScore ?? MIN_SCORE;
  const leverage = options.leverage ?? DEFAULT_LEVERAGE;

  const candles = await fetchHistoricalCandlesMultiTF(coinId, startMs, endMs);
  if (!candles || candles.error) return { error: candles?.error || 'Insufficient candles', trades: [], equityCurve: [] };

  // If not BTC, also fetch BTC candles for BTC signal + correlation (matches live system)
  let btcCandles = null;
  if (coinId !== 'bitcoin' && options.btcCandles) {
    btcCandles = options.btcCandles;
  }

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

  // BTC signal cache: re-analyze BTC every 4 bars (4 hours) instead of every bar.
  // Live system only runs every ~15 min, so 4h is conservative and much faster.
  const BTC_REANALYZE_INTERVAL = 4;
  let cachedBtcSignal = null;
  let cachedBtcDirection = null;
  let cachedBtcSlice = null;
  let lastBtcAnalysisBar = -999;

  for (let t = 50; t < c1h.length - 1; t++) {
    const bar = c1h[t];
    const nextBar = c1h[t + 1];
    const slice = sliceCandlesAt(candles, t);
    if (!slice) continue;

    const coinData = buildCoinData(coinId, candles, t);

    // === BTC SIGNAL: mirrors live system's buildEngineOptions ===
    // Re-analyze BTC periodically (not every bar, for performance).
    if (btcCandles && btcCandles['1h'] && (t - lastBtcAnalysisBar >= BTC_REANALYZE_INTERVAL)) {
      const btc1h = btcCandles['1h'];
      const btcIdx = btc1h.findIndex(b => b.openTime >= bar.openTime);
      const btcT = btcIdx >= 0 ? Math.min(btcIdx, btc1h.length - 1) : btc1h.length - 1;
      if (btcT >= 50) {
        const btcSlice = sliceCandlesAt(btcCandles, btcT);
        if (btcSlice) {
          const btcData = buildCoinData('bitcoin', btcCandles, btcT);
          const btcResult = analyzeCoin(btcData, btcSlice, history, {});
          cachedBtcSignal = btcResult.signal;
          cachedBtcDirection = null;
          if (btcResult.signal === 'STRONG_BUY' || btcResult.signal === 'BUY') cachedBtcDirection = 'BULL';
          else if (btcResult.signal === 'STRONG_SELL' || btcResult.signal === 'SELL') cachedBtcDirection = 'BEAR';
          cachedBtcSlice = btcSlice;
          lastBtcAnalysisBar = t;
        }
      }
    }

    const options_bt = {
      strategyWeights: options.strategyWeights || [],
      btcSignal: cachedBtcSignal,
      btcDirection: cachedBtcDirection,
      btcCandles: cachedBtcSlice ? cachedBtcSlice['1h'] : null,
      fundingRates: {},
      barTime: bar.openTime  // Use historical bar time for session filter (not current clock)
    };

    // === POSITION MANAGEMENT: mirrors live paper-trading.js ===
    // Handles: SL, TP1 (40%), TP2 (30%), TP3 (30%), breakeven, trailing stop
    if (position) {
      const high = nextBar.high;
      const low = nextBar.low;
      const isLong = position.direction === 'LONG';
      const slipMul = 1 + (SLIPPAGE_BPS / 10000);
      const origRisk = Math.abs(position.entry - position.originalSL);

      // --- Breakeven & trailing stop logic (mirrors live stopManagement) ---
      if (origRisk > 0) {
        const currentProfit = isLong
          ? (high - position.entry) / origRisk
          : (position.entry - low) / origRisk;

        // Trailing stop: at 1.5R, trail 1R behind best price
        if (currentProfit >= TRAILING_START_R) {
          const bestPrice = isLong ? high : low;
          if (isLong && (!position.bestPrice || bestPrice > position.bestPrice)) position.bestPrice = bestPrice;
          if (!isLong && (!position.bestPrice || bestPrice < position.bestPrice)) position.bestPrice = bestPrice;
          const trailStop = isLong
            ? position.bestPrice - (TRAILING_DIST_R * origRisk)
            : position.bestPrice + (TRAILING_DIST_R * origRisk);
          if (isLong && trailStop > position.stopLoss) position.stopLoss = trailStop;
          if (!isLong && trailStop < position.stopLoss) position.stopLoss = trailStop;
        }
        // Breakeven: at 1R profit, move stop to entry
        else if (currentProfit >= BREAKEVEN_R && !position.breakevenHit) {
          position.stopLoss = position.entry;
          position.breakevenHit = true;
        }
      }

      // --- Stop loss check ---
      let stopped = false;
      if (isLong && position.stopLoss && low <= position.stopLoss) stopped = true;
      if (!isLong && position.stopLoss && high >= position.stopLoss) stopped = true;

      if (stopped) {
        const exitPrice = isLong ? position.stopLoss / slipMul : position.stopLoss * slipMul;
        const pnl = isLong
          ? ((exitPrice - position.entry) / position.entry) * position.size
          : ((position.entry - exitPrice) / position.entry) * position.size;
        equity += pnl;
        trades.push({
          direction: position.direction, entry: position.entry, exit: exitPrice,
          entryBar: position.entryBar, exitBar: t + 1, reason: 'SL',
          pnl, size: position.originalSize, partials: position.partialPnl || 0
        });
        position = null;
        continue;
      }

      // --- Take profit checks: TP1 → 40%, TP2 → 30%, TP3 → 30% ---
      // TP1: close 40% of original position
      if (!position.tp1Hit && position.takeProfit1) {
        const hitTP = isLong ? high >= position.takeProfit1 : low <= position.takeProfit1;
        if (hitTP) {
          const exitPrice = isLong ? position.takeProfit1 / slipMul : position.takeProfit1 * slipMul;
          const portion = position.originalSize * TP1_PCT;
          const pnl = isLong
            ? ((exitPrice - position.entry) / position.entry) * portion
            : ((position.entry - exitPrice) / position.entry) * portion;

          // If no TP2/TP3, close entire position at TP1
          if (!position.takeProfit2 && !position.takeProfit3) {
            equity += pnl + ((exitPrice - position.entry) / position.entry * (position.size - portion) * (isLong ? 1 : -1));
            const totalPnl = isLong
              ? ((exitPrice - position.entry) / position.entry) * position.size
              : ((position.entry - exitPrice) / position.entry) * position.size;
            trades.push({
              direction: position.direction, entry: position.entry, exit: exitPrice,
              entryBar: position.entryBar, exitBar: t + 1, reason: 'TP1',
              pnl: totalPnl, size: position.originalSize, partials: 0
            });
            position = null;
            continue;
          }

          equity += pnl;
          position.partialPnl = (position.partialPnl || 0) + pnl;
          position.size -= portion;
          position.tp1Hit = true;
        }
      }

      // TP2: close 30% of original position
      if (position && !position.tp2Hit && position.takeProfit2) {
        const hitTP = isLong ? high >= position.takeProfit2 : low <= position.takeProfit2;
        if (hitTP) {
          const exitPrice = isLong ? position.takeProfit2 / slipMul : position.takeProfit2 * slipMul;
          const portion = position.originalSize * TP2_PCT;
          const pnl = isLong
            ? ((exitPrice - position.entry) / position.entry) * portion
            : ((position.entry - exitPrice) / position.entry) * portion;

          // If no TP3, close entire remaining position at TP2
          if (!position.takeProfit3) {
            const remainPnl = isLong
              ? ((exitPrice - position.entry) / position.entry) * position.size
              : ((position.entry - exitPrice) / position.entry) * position.size;
            equity += remainPnl;
            trades.push({
              direction: position.direction, entry: position.entry, exit: exitPrice,
              entryBar: position.entryBar, exitBar: t + 1, reason: 'TP2',
              pnl: (position.partialPnl || 0) + remainPnl, size: position.originalSize, partials: position.partialPnl || 0
            });
            position = null;
            continue;
          }

          equity += pnl;
          position.partialPnl = (position.partialPnl || 0) + pnl;
          position.size -= portion;
          position.tp2Hit = true;
        }
      }

      // TP3: close remaining position
      if (position && position.takeProfit3) {
        const hitTP = isLong ? high >= position.takeProfit3 : low <= position.takeProfit3;
        if (hitTP) {
          const exitPrice = isLong ? position.takeProfit3 / slipMul : position.takeProfit3 * slipMul;
          const pnl = isLong
            ? ((exitPrice - position.entry) / position.entry) * position.size
            : ((position.entry - exitPrice) / position.entry) * position.size;
          equity += pnl;
          trades.push({
            direction: position.direction, entry: position.entry, exit: exitPrice,
            entryBar: position.entryBar, exitBar: t + 1, reason: 'TP3',
            pnl: (position.partialPnl || 0) + pnl, size: position.originalSize, partials: position.partialPnl || 0
          });
          position = null;
          continue;
        }
      }

      continue;
    }

    // === TRADE ENTRY: mirrors live openTrade logic ===
    if (t < tradeStartBar) continue; // warmup period — skip trade entries
    const signal = analyzeCoin(coinData, slice, history, options_bt);
    let canLong = signal.signal === 'BUY' || signal.signal === 'STRONG_BUY';
    let canShort = signal.signal === 'SELL' || signal.signal === 'STRONG_SELL';

    // === BTC FILTER: mirrors live system's analyzeAllCoins ===
    // Block altcoin LONGs when BTC is strongly bearish, SHORTs when strongly bullish
    if (coinId !== 'bitcoin' && cachedBtcSignal) {
      if (canLong && cachedBtcSignal === 'STRONG_SELL') canLong = false;
      if (canShort && cachedBtcSignal === 'STRONG_BUY') canShort = false;
    }

    if ((canLong || canShort) && signal.score >= minScore && signal.stopLoss && signal.takeProfit1) {
      const direction = canLong ? 'LONG' : 'SHORT';
      const slipMul = 1 + (SLIPPAGE_BPS / 10000);
      const rawEntry = nextBar.open;
      // Slippage: worse entry (higher for longs, lower for shorts) — matches live
      const entry = direction === 'LONG' ? rawEntry * slipMul : rawEntry / slipMul;
      const slDist = Math.abs(entry - signal.stopLoss);
      if (slDist <= 0) continue;
      const riskAmount = equity * RISK_PER_TRADE;
      const size = (riskAmount * entry) / slDist;
      const actualSize = Math.min(size, equity * 0.95);

      // Validate TPs: for LONG, TPs must be above entry; for SHORT, below (mirrors live)
      let tp1 = signal.takeProfit1 || null;
      let tp2 = signal.takeProfit2 || null;
      let tp3 = signal.takeProfit3 || null;
      if (direction === 'LONG') {
        if (tp1 && tp1 < entry) tp1 = null;
        if (tp2 && tp2 < entry) tp2 = null;
        if (tp3 && tp3 < entry) tp3 = null;
      } else {
        if (tp1 && tp1 > entry) tp1 = null;
        if (tp2 && tp2 > entry) tp2 = null;
        if (tp3 && tp3 > entry) tp3 = null;
      }
      if (!tp1) continue; // Must have at least TP1

      position = {
        direction,
        entry,
        entryBar: t + 1,
        stopLoss: signal.stopLoss,
        originalSL: signal.stopLoss,
        takeProfit1: tp1,
        takeProfit2: tp2,
        takeProfit3: tp3,
        size: actualSize,
        originalSize: actualSize,
        tp1Hit: false,
        tp2Hit: false,
        breakevenHit: false,
        bestPrice: null,
        partialPnl: 0
      };
    }
  }

  // Close any remaining open position at last bar's close
  if (position) {
    const lastBar = c1h[c1h.length - 1];
    const exitPrice = lastBar.close;
    const isLong = position.direction === 'LONG';
    const pnl = isLong
      ? ((exitPrice - position.entry) / position.entry) * position.size
      : ((position.entry - exitPrice) / position.entry) * position.size;
    equity += pnl;
    trades.push({
      direction: position.direction, entry: position.entry, exit: exitPrice,
      entryBar: position.entryBar, exitBar: c1h.length - 1, reason: 'END',
      pnl: (position.partialPnl || 0) + pnl, size: position.originalSize, partials: position.partialPnl || 0
    });
    position = null;
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
 * Run backtest for all coins or a subset.
 * Coins are processed in parallel batches to stay within API rate limits
 * while keeping total time well under Render's 30s request timeout.
 */
const PER_COIN_BACKTEST_TIMEOUT = 20000; // 20s max per coin simulation
const PARALLEL_BATCH_SIZE = 3; // process 3 coins at a time (avoids Bybit rate limits)

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
  let btcCandles = null;
  if (!coins.includes('bitcoin') || coins.length > 1) {
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
