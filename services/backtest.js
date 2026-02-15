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

// === POSITION MANAGEMENT: mirrors live paper-trading.js 1:1 ===
const TP1_PCT = 0.4;   // 40% at TP1
const TP2_PCT = 0.3;   // 30% at TP2
const TP3_PCT = 0.3;   // 30% at TP3 (remaining)
const SLIPPAGE_BPS = 5; // 0.05% slippage on entry/exit
const TAKER_FEE = 0.001; // 0.1% taker fee on entry and exit (matches live DEFAULT_TAKER_FEE)
const BREAKEVEN_R = 1;  // Move stop to breakeven at 1R profit
const TRAILING_START_R = 1.5; // Start trailing at 1.5R
const TRAILING_DIST_R = 1;   // Trail 1R behind best price
const MAX_SL_DISTANCE_PCT = 0.15; // Cap SL at 15% from entry (matches live)
const COOLDOWN_BARS = 4; // 4h cooldown: no same-direction re-entry (matches live DEFAULT_COOLDOWN_HOURS=4)
const SCORE_RECHECK_INTERVAL = 4; // Re-analyze signal every 4 bars while in a trade (matches live 5-min check scaled to 1h bars)

// Stepped profit lock-in levels (mirrors live LOCK_IN_LEVELS)
const LOCK_IN_LEVELS = [
  { progress: 0.5, lockR: 0.5 },
  { progress: 0.75, lockR: 0.75 },
  { progress: 0.9, lockR: 1 }
];

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

    // === POSITION MANAGEMENT: mirrors live paper-trading.js 1:1 ===
    // Handles: SL, TP1-3, breakeven, trailing, lock-in, score re-check, actions
    if (position) {
      const high = nextBar.high;
      const low = nextBar.low;
      const currentPrice = nextBar.close;
      const isLong = position.direction === 'LONG';
      const slipMul = 1 + (SLIPPAGE_BPS / 10000);
      const origRisk = Math.abs(position.entry - position.originalSL);

      // Track max/min prices (mirrors live trade.maxPrice/minPrice)
      if (high > (position.maxPrice || 0)) position.maxPrice = high;
      if (low < (position.minPrice || Infinity)) position.minPrice = low;

      // --- Breakeven at 1R (mirrors live autoBE) ---
      if (origRisk > 0 && !position.breakevenHit && !position.trailingActivated) {
        const at1R = isLong
          ? currentPrice >= position.entry + origRisk
          : currentPrice <= position.entry - origRisk;
        if (at1R) {
          position.stopLoss = position.entry;
          position.breakevenHit = true;
          position.actions.push({ type: 'BE', bar: t + 1 });
        }
      }

      // --- Trailing stop at 1.5R+ (mirrors live autoTrail) ---
      if (origRisk > 0) {
        const stopPastEntry = isLong ? position.stopLoss >= position.entry : position.stopLoss <= position.entry;
        if (stopPastEntry || position.trailingActivated) {
          const at1_5R = isLong
            ? currentPrice >= position.entry + origRisk * TRAILING_START_R
            : currentPrice <= position.entry - origRisk * TRAILING_START_R;
          if (at1_5R) {
            position.trailingActivated = true;
            const bestP = isLong ? position.maxPrice : position.minPrice;
            const trailSL = isLong
              ? bestP - (TRAILING_DIST_R * origRisk)
              : bestP + (TRAILING_DIST_R * origRisk);
            const validMove = isLong ? trailSL > position.stopLoss && trailSL < currentPrice
              : trailSL < position.stopLoss && trailSL > currentPrice;
            if (validMove) {
              position.stopLoss = trailSL;
              if (!position.actions.some(a => a.type === 'TS')) {
                position.actions.push({ type: 'TS', bar: t + 1 });
              }
            }
          }
        }
      }

      // --- Stepped profit lock-in (mirrors live LOCK_IN_LEVELS) ---
      if (origRisk > 0 && position.stopLoss != null) {
        const tp2 = position.takeProfit2 || position.takeProfit1;
        let progress = 0;
        if (tp2 && tp2 !== position.entry) {
          progress = isLong ? (currentPrice - position.entry) / (tp2 - position.entry)
            : (position.entry - currentPrice) / (position.entry - tp2);
          progress = Math.min(1, progress);
        }
        // PnL-based fallback (mirrors live)
        if (progress <= 0 && position.entry > 0) {
          const pnlPct = (isLong ? (currentPrice - position.entry) : (position.entry - currentPrice)) / position.entry * 100 * leverage;
          if (pnlPct >= 5) progress = 0.9;
          else if (pnlPct >= 2) progress = 0.5;
        }
        const currentLockR = position.stopLoss && origRisk > 0
          ? (isLong ? position.stopLoss - position.entry : position.entry - position.stopLoss) / origRisk
          : 0;
        for (const level of LOCK_IN_LEVELS) {
          if (progress >= level.progress && currentLockR < level.lockR) {
            const newStop = isLong
              ? position.entry + origRisk * level.lockR
              : position.entry - origRisk * level.lockR;
            const validMove = isLong ? newStop > position.stopLoss && newStop < currentPrice
              : newStop < position.stopLoss && newStop > currentPrice;
            if (validMove) {
              position.stopLoss = newStop;
              position.actions.push({ type: 'LOCK', bar: t + 1, lockR: level.lockR });
            }
            break;
          }
        }
      }

      // --- Score Re-check (mirrors live recheckTradeScores + executeScoreCheckAction) ---
      // Every SCORE_RECHECK_INTERVAL bars, re-analyze the coin. If score dropped severely
      // against the trade, take action: reduce position or exit.
      if ((t - position.entryBar) >= SCORE_RECHECK_INTERVAL &&
          (t - (position.lastScoreCheckBar || position.entryBar)) >= SCORE_RECHECK_INTERVAL) {
        position.lastScoreCheckBar = t;
        const recheckSignal = analyzeCoin(coinData, slice, history, options_bt);
        const scoreDiff = (recheckSignal.score || 0) - (position.entryScore || 0);
        const signalFlipped = isLong
          ? (recheckSignal.signal === 'SELL' || recheckSignal.signal === 'STRONG_SELL')
          : (recheckSignal.signal === 'BUY' || recheckSignal.signal === 'STRONG_BUY');
        let effectiveDiff = scoreDiff;
        if (signalFlipped) effectiveDiff = Math.min(effectiveDiff, -15);
        else if (recheckSignal.signal === 'HOLD') effectiveDiff -= 4;

        const pnlPct = (isLong ? (currentPrice - position.entry) : (position.entry - currentPrice))
          / position.entry * 100 * leverage;

        // Consider exit: score collapsed AND signal flipped AND not in profit (mirrors live logic)
        const wouldExit = effectiveDiff <= -45 || (signalFlipped && effectiveDiff <= -40);
        const blockExit = pnlPct >= 0 || (pnlPct > -5); // Don't exit on small losses
        if (wouldExit && !blockExit && pnlPct <= -8) {
          // Score-check EXIT (mirrors live SCORE_CHECK_EXIT)
          const exitPrice = isLong ? currentPrice / slipMul : currentPrice * slipMul;
          const exitFees = position.size * TAKER_FEE;
          let pnl = isLong
            ? ((exitPrice - position.entry) / position.entry) * position.size
            : ((position.entry - exitPrice) / position.entry) * position.size;
          pnl -= exitFees;
          equity += pnl;
          position.actions.push({ type: 'EXIT', bar: t + 1 });
          trades.push({
            direction: position.direction, entry: position.entry, exit: exitPrice,
            entryBar: position.entryBar, exitBar: t + 1, reason: 'SCORE_EXIT',
            pnl: (position.partialPnl || 0) + pnl, size: position.originalSize,
            partials: position.partialPnl || 0, actions: [...position.actions]
          });
          position = null;
          continue;
        }

        // Reduce position by 50% (mirrors live SCORE_CHECK_REDUCE)
        const wouldReduce = effectiveDiff <= -25 || (signalFlipped && effectiveDiff <= -20);
        if (wouldReduce && pnlPct < 0 && !position.reducedByScore) {
          const portion = position.size * 0.5;
          if (portion > 1) {
            const exitPrice = isLong ? currentPrice / slipMul : currentPrice * slipMul;
            const exitFees = portion * TAKER_FEE;
            let pnl = isLong
              ? ((exitPrice - position.entry) / position.entry) * portion
              : ((position.entry - exitPrice) / position.entry) * portion;
            pnl -= exitFees;
            equity += pnl;
            position.partialPnl = (position.partialPnl || 0) + pnl;
            position.size -= portion;
            position.reducedByScore = true;
            position.actions.push({ type: 'RP', bar: t + 1 });
          }
        }
      }

      // --- Stop loss check ---
      let stopped = false;
      if (isLong && position.stopLoss && low <= position.stopLoss) stopped = true;
      if (!isLong && position.stopLoss && high >= position.stopLoss) stopped = true;

      if (stopped) {
        const exitPrice = isLong ? position.stopLoss / slipMul : position.stopLoss * slipMul;
        const exitFees = position.size * TAKER_FEE;
        let pnl = isLong
          ? ((exitPrice - position.entry) / position.entry) * position.size
          : ((position.entry - exitPrice) / position.entry) * position.size;
        pnl -= exitFees;
        equity += pnl;
        trades.push({
          direction: position.direction, entry: position.entry, exit: exitPrice,
          entryBar: position.entryBar, exitBar: t + 1, reason: 'SL',
          pnl: (position.partialPnl || 0) + pnl, size: position.originalSize,
          partials: position.partialPnl || 0, actions: [...position.actions]
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
          const exitFees = portion * TAKER_FEE;
          let pnl = isLong
            ? ((exitPrice - position.entry) / position.entry) * portion
            : ((position.entry - exitPrice) / position.entry) * portion;
          pnl -= exitFees;

          // If no TP2/TP3, close entire position at TP1
          if (!position.takeProfit2 && !position.takeProfit3) {
            const totalFees = position.size * TAKER_FEE;
            const totalPnl = (isLong
              ? ((exitPrice - position.entry) / position.entry) * position.size
              : ((position.entry - exitPrice) / position.entry) * position.size) - totalFees;
            equity += totalPnl;
            position.actions.push({ type: 'PP', bar: t + 1, label: 'TP1' });
            trades.push({
              direction: position.direction, entry: position.entry, exit: exitPrice,
              entryBar: position.entryBar, exitBar: t + 1, reason: 'TP1',
              pnl: totalPnl, size: position.originalSize, partials: 0,
              actions: [...position.actions]
            });
            position = null;
            continue;
          }

          equity += pnl;
          position.partialPnl = (position.partialPnl || 0) + pnl;
          position.size -= portion;
          position.tp1Hit = true;
          position.actions.push({ type: 'PP', bar: t + 1, label: 'TP1' });
        }
      }

      // TP2: close 30% of original position
      if (position && !position.tp2Hit && position.takeProfit2) {
        const hitTP = isLong ? high >= position.takeProfit2 : low <= position.takeProfit2;
        if (hitTP) {
          const exitPrice = isLong ? position.takeProfit2 / slipMul : position.takeProfit2 * slipMul;
          const portion = position.originalSize * TP2_PCT;
          const exitFees = portion * TAKER_FEE;
          let pnl = isLong
            ? ((exitPrice - position.entry) / position.entry) * portion
            : ((position.entry - exitPrice) / position.entry) * portion;
          pnl -= exitFees;

          // If no TP3, close entire remaining at TP2
          if (!position.takeProfit3) {
            const remainFees = position.size * TAKER_FEE;
            const remainPnl = (isLong
              ? ((exitPrice - position.entry) / position.entry) * position.size
              : ((position.entry - exitPrice) / position.entry) * position.size) - remainFees;
            equity += remainPnl;
            position.actions.push({ type: 'PP', bar: t + 1, label: 'TP2' });
            trades.push({
              direction: position.direction, entry: position.entry, exit: exitPrice,
              entryBar: position.entryBar, exitBar: t + 1, reason: 'TP2',
              pnl: (position.partialPnl || 0) + remainPnl, size: position.originalSize,
              partials: position.partialPnl || 0, actions: [...position.actions]
            });
            position = null;
            continue;
          }

          equity += pnl;
          position.partialPnl = (position.partialPnl || 0) + pnl;
          position.size -= portion;
          position.tp2Hit = true;
          position.actions.push({ type: 'PP', bar: t + 1, label: 'TP2' });
        }
      }

      // TP3: close remaining position
      if (position && position.takeProfit3) {
        const hitTP = isLong ? high >= position.takeProfit3 : low <= position.takeProfit3;
        if (hitTP) {
          const exitPrice = isLong ? position.takeProfit3 / slipMul : position.takeProfit3 * slipMul;
          const exitFees = position.size * TAKER_FEE;
          let pnl = isLong
            ? ((exitPrice - position.entry) / position.entry) * position.size
            : ((position.entry - exitPrice) / position.entry) * position.size;
          pnl -= exitFees;
          equity += pnl;
          position.actions.push({ type: 'PP', bar: t + 1, label: 'TP3' });
          trades.push({
            direction: position.direction, entry: position.entry, exit: exitPrice,
            entryBar: position.entryBar, exitBar: t + 1, reason: 'TP3',
            pnl: (position.partialPnl || 0) + pnl, size: position.originalSize,
            partials: position.partialPnl || 0, actions: [...position.actions]
          });
          position = null;
          continue;
        }
      }

      continue;
    }

    // === TRADE ENTRY: mirrors live openTrade 1:1 ===
    if (t < tradeStartBar) continue; // warmup period — skip trade entries
    const signal = analyzeCoin(coinData, slice, history, options_bt);
    let canLong = signal.signal === 'BUY' || signal.signal === 'STRONG_BUY';
    let canShort = signal.signal === 'SELL' || signal.signal === 'STRONG_SELL';

    // === BTC FILTER: mirrors live system's analyzeAllCoins ===
    if (coinId !== 'bitcoin' && cachedBtcSignal) {
      if (canLong && cachedBtcSignal === 'STRONG_SELL') canLong = false;
      if (canShort && cachedBtcSignal === 'STRONG_BUY') canShort = false;
    }

    if (!canLong && !canShort) continue;
    if (signal.score < minScore || !signal.stopLoss || !signal.takeProfit1) continue;

    const direction = canLong ? 'LONG' : 'SHORT';

    // === COOLDOWN: no same-direction re-entry within COOLDOWN_BARS (mirrors live) ===
    if (trades.length > 0) {
      const lastTrade = trades[trades.length - 1];
      if (lastTrade.direction === direction && (t + 1 - lastTrade.exitBar) < COOLDOWN_BARS) {
        continue; // Still in cooldown
      }
    }

    const slipMul = 1 + (SLIPPAGE_BPS / 10000);
    const rawEntry = nextBar.open;
    const entry = direction === 'LONG' ? rawEntry * slipMul : rawEntry / slipMul;

    // === SL DISTANCE CAP: max 15% from entry (mirrors live MAX_SL_DISTANCE_PCT) ===
    let stopLoss = signal.stopLoss;
    if (entry > 0) {
      const slDistance = Math.abs(entry - stopLoss) / entry;
      if (slDistance > MAX_SL_DISTANCE_PCT) {
        stopLoss = direction === 'LONG'
          ? entry * (1 - MAX_SL_DISTANCE_PCT)
          : entry * (1 + MAX_SL_DISTANCE_PCT);
      }
    }

    const slDist = Math.abs(entry - stopLoss);
    if (slDist <= 0) continue;

    // === POSITION SIZING: risk-based + confidence-weighted (mirrors live) ===
    const riskAmount = equity * RISK_PER_TRADE;
    let size = (riskAmount * entry) / slDist;
    // Confidence multiplier: higher score = slightly larger size (mirrors live)
    const score = Math.min(100, Math.max(0, signal.score || 50));
    const confidenceMult = Math.min(1.2, 0.5 + score / 100);
    size *= confidenceMult;
    // Cap at 95% of equity
    const actualSize = Math.min(size, equity * 0.95);

    // Entry fees (mirrors live maker fee)
    const entryFees = actualSize * TAKER_FEE;
    if (entryFees + (actualSize / leverage) > equity) continue; // Can't afford

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

    // Deduct entry fees from equity (mirrors live margin + fees deduction)
    equity -= entryFees;

    position = {
      direction,
      entry,
      entryBar: t + 1,
      entryScore: signal.score,
      stopLoss,
      originalSL: stopLoss,
      takeProfit1: tp1,
      takeProfit2: tp2,
      takeProfit3: tp3,
      size: actualSize,
      originalSize: actualSize,
      tp1Hit: false,
      tp2Hit: false,
      breakevenHit: false,
      trailingActivated: false,
      reducedByScore: false,
      bestPrice: null,
      maxPrice: entry,
      minPrice: entry,
      partialPnl: 0,
      lastScoreCheckBar: t + 1,
      actions: []  // Track all badges: BE, TS, PP, RP, EXIT, LOCK
    };
  }

  // Close any remaining open position at last bar's close
  if (position) {
    const lastBar = c1h[c1h.length - 1];
    const exitPrice = lastBar.close;
    const isLong = position.direction === 'LONG';
    const exitFees = position.size * TAKER_FEE;
    let pnl = isLong
      ? ((exitPrice - position.entry) / position.entry) * position.size
      : ((position.entry - exitPrice) / position.entry) * position.size;
    pnl -= exitFees;
    equity += pnl;
    trades.push({
      direction: position.direction, entry: position.entry, exit: exitPrice,
      entryBar: position.entryBar, exitBar: c1h.length - 1, reason: 'END',
      pnl: (position.partialPnl || 0) + pnl, size: position.originalSize,
      partials: position.partialPnl || 0, actions: [...(position.actions || [])]
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

  // Count action badges across all trades (mirrors live trade actions)
  const allActions = trades.flatMap(t => (t.actions || []).map(a => a.type));
  const actionCounts = {
    BE: allActions.filter(a => a === 'BE').length,
    TS: allActions.filter(a => a === 'TS').length,
    PP: allActions.filter(a => a === 'PP').length,
    RP: allActions.filter(a => a === 'RP').length,
    EXIT: allActions.filter(a => a === 'EXIT').length,
    LOCK: allActions.filter(a => a === 'LOCK').length
  };

  // Exit reason breakdown
  const exitReasons = {};
  trades.forEach(t => { exitReasons[t.reason] = (exitReasons[t.reason] || 0) + 1; });

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
    maxDrawdownPct: computeMaxDrawdownPct(equityCurve),
    actionCounts,
    exitReasons
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
