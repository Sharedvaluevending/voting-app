# Trading System Audit Report

**Date:** 2026-03-04  
**Scope:** Data Integrity, Trading Logic, API & Infrastructure, Regime & Strategy, Performance

---

## 1. Data Integrity

### 1.1 OHLCV Null/Missing Values

| Location | Status | Notes |
|----------|--------|------|
| `trading-engine.js` | ✅ Fixed | `validCandles` filter + `volumes.map(c => c.volume ?? 0)`, `calculateVWAP`, `analyzeVolume`, `resample` all use safe fallbacks |
| `crypto-api.js` | ✅ OK | Bitget/Kraken candle parsing filters invalid candles (`Number.isFinite`, `c.high >= c.low`) |
| `candlestick-patterns.js` | ✅ OK | Called after `validCandles`; `fullRange(c) \|\| 1` guards division |
| `chart-patterns.js` | ⚠️ Review | `avgVolume` checks `candles[i] && candles[i].volume`; `candles[candles.length-1].close` assumes length ≥ 20 |
| `smc-scanner.js`, `scenario-checks.js` | ⚠️ Review | May receive candles from market-scanner/CoinGecko; no explicit OHLCV validation before use |
| `mobula-api.js`, `dexscreener-api.js` | ⚠️ Review | Return raw API data; callers should validate before passing to engines |

**Recommendation:** Add a shared `validateCandle(c)` helper and apply it at all candle ingestion points (market-scanner, fetchCoinDataForDetail, etc.).

### 1.2 Timestamp / Timezone Handling

| Location | Status | Notes |
|----------|--------|------|
| Bitget | ✅ OK | Returns ms; `parseInt(c[0])` used as-is |
| Kraken | ✅ OK | Unix seconds → `c[0] * 1000` |
| CoinGecko | ✅ OK | `last_updated_at * 1000` for `Date` |
| Paper trading | ✅ OK | `setUTCHours(0,0,0,0)` for daily reset |
| Backtest session filter | ✅ OK | Uses `bar.openTime` (ms) and fixed UTC time |

**Finding:** All timestamps are epoch ms (UTC). No explicit timezone normalization needed; crypto exchanges use UTC.

### 1.3 Floating Point Precision (Price Comparisons)

| Location | Status | Notes |
|----------|--------|------|
| `strategy-builder/rule-engine.js` | ✅ OK | `price_near`: `Math.abs(currentPrice - ref) / ref < pct` (tolerance-based) |
| `scenario-checks.js` | ✅ OK | `rangeLow * 1.001`, `rangeHigh * 0.999`, `priceNearZone` uses `Math.abs(price - mid) / range < 0.5` |
| `chart-patterns.js` | ✅ OK | `Math.abs(h1.val - h2.val) <= tolerance` (ATR-based) |
| `manage-engine.js` | ⚠️ Edge case | `tp === trade.entryPrice` — strict equality; consider `Math.abs(tp - trade.entryPrice) < 1e-8` for robustness |
| `candlestick-patterns.js` | ✅ OK | Tweezer: `Math.abs(p.low - c.low) / (fullRange(c) \|\| 1) < 0.05` |

**Recommendation:** Add `PRICE_EPSILON = 1e-8` and use `Math.abs(a - b) < PRICE_EPSILON` wherever prices are compared for equality.

---

## 2. Trading Logic

### 2.1 Candle Indexing / Off-by-One

| Location | Status | Notes |
|----------|--------|------|
| `backtest/run-backtest.js` | ✅ OK | Loop `t = 50` to `t < c1h.length - 1`; `sliceCandlesAt(candles, t)` = `slice(0, t+1)` — no look-ahead |
| `backtest/market-data.js` | ✅ OK | `sliceCandlesAt`: `baseCandles.slice(0, t + 1)`; HTF uses `floor((t+1)/barsPer)` closed bars |
| `smc-scenarios/scenario-checks.js` | ✅ OK | FVG loop `i < candles.length - 2`; `candles[i+2]` valid |
| `candlestick-patterns.js` | ✅ OK | Uses `candles.length - 1`, `-2`, etc. with length guards |
| `strategy-builder/rule-engine.js` | ✅ OK | `slice(0, t + 1)`; `t >= candles.length - 1` returns HOLD |

**Finding:** No off-by-one or look-ahead bias detected. Backtest correctly uses only past + current bar for signals; `nextBar` is used only for simulating the bar’s range (SL/TP hit detection).

### 2.2 Position Sizing (Balance Zero / Near Zero)

| Location | Status | Notes |
|----------|--------|------|
| `risk-engine.js` `calculatePositionSize` | ✅ OK | `balance * 0.05 * leverage` when entry invalid; `riskAmount = balance * (riskPercent/100)`; `balance <= 0` → returns null in `plan()` |
| `risk-engine.js` `plan()` | ✅ OK | `maxSpend = Math.max(0, balance - 0.50)`; `balance <= 0 \|\| required > balance` → null |
| `paper-trading.js` | ✅ OK | Balance checked before open; `plan()` rejects when insufficient |

**Finding:** Zero/near-zero balance is handled; no division by zero.

### 2.3 Stop Loss / Take Profit (Entry Price Zero or Undefined)

| Location | Status | Notes |
|----------|--------|------|
| `risk-engine.js` | ✅ OK | `!decision.entry \|\| !decision.stopLoss` → null; `calculatePositionSize` guards `!entryPrice` |
| `manage-engine.js` | ✅ OK | `getProgressTowardTP`: `!trade.entryPrice \|\| tp === trade.entryPrice` → 0; `risk` uses `trade.entryPrice * 0.02` fallback |
| `paper-trading.js` | ⚠️ Defensive | PnL uses `trade.entryPrice`; if undefined → NaN. Trade model requires `entryPrice`; add `trade.entryPrice > 0` guard in close/partial for robustness |

**Recommendation:** In `_closeTradeInner`, add `if (!trade.entryPrice || trade.entryPrice <= 0) throw new Error('Invalid trade: missing entry price');` before PnL calculation.

---

## 3. API & Infrastructure

### 3.1 Bitget / Kraken Error Handling

| Area | Status | Notes |
|------|--------|------|
| 429 rate limit | ✅ Fixed | Both fetches retry with exponential backoff |
| Network timeout | ✅ OK | `fetch(..., { timeout: 12000 })` |
| Empty response | ✅ OK | Return `[]`; pagination breaks loop |
| Unexpected structure | ⚠️ Partial | `json.code !== '00000'` (Bitget), `json.error` (Kraken) checked; malformed `json.data` could throw in `.map()` |

**Recommendation:** Wrap `raw.map(...)` in try/catch; on parse error return `[]` and log.

### 3.2 WebSocket Reconnection

| Location | Status | Notes |
|----------|--------|------|
| `websocket-prices.js` | ✅ OK | `on('close')` → `setTimeout(connect, RECONNECT_DELAY_MS)`; ping every 20s |

**Finding:** Reconnection on disconnect is implemented. Mid-trade: `fetchLivePrice` falls back to REST if WS price stale/missing.

### 3.3 Pagination Edge Cases

| Location | Status | Notes |
|----------|--------|------|
| `fetchHistoricalCandlesForCoin` | ✅ OK | Empty chunk → retry then break; `cursor = lastTs + msPerCandle`; dedup + sort |
| Fewer results than expected | ✅ OK | Loop exits when `chunk.length === 0`; `MAX_PAGES` prevents infinite loop |

---

## 4. Regime & Strategy

### 4.1 Regime Detection State Transitions

| Location | Status | Notes |
|----------|--------|------|
| `detectRegime` | ✅ OK | Pure function; no persistent state. Each evaluation is independent |
| Mid-trade regime change | ✅ OK | Regime is evaluated at entry; manage engine does not re-evaluate regime. Trade continues with original levels |

**Finding:** No state machine; regime is point-in-time. Mid-trade regime change does not alter open trade management.

### 4.2 Confluence Scoring Division by Zero

| Location | Status | Notes |
|----------|--------|------|
| `getStratDominantDirAndConfluence` | ✅ OK | `confluence: conf \|\| 1` |
| `weightedScore` | ✅ OK | `total = (... ) \|\| 100` |
| `calculateBtcCorrelation` | ✅ OK | `den > 0 ? num / den : 0` |
| `pickStrategy` | ✅ OK | `total` guarded |

**Finding:** Division-by-zero guarded in confluence and scoring paths.

### 4.3 Backtest Look-Ahead Bias

| Location | Status | Notes |
|----------|--------|------|
| `sliceCandlesAt` | ✅ OK | `slice(0, t+1)` — only past and current bar |
| Signal evaluation | ✅ OK | Uses `slice`; no future data |
| Execution (SL/TP) | ✅ OK | `nextBar` = bar t+1; used to simulate bar range. Signal at bar t; execution simulates bar t+1. Correct. |

**Finding:** No look-ahead bias. Slice is strictly `[0..t]` for signals.

---

## 5. Performance

### 5.1 Large Array Processing

| Location | Issue | Severity |
|----------|-------|----------|
| `analyzeOHLCV` | Full array processed each call | Low |
| `detectAllPatterns` / `detectChartPatterns` | Full slice each bar | Low |
| Backtest loop | `sliceCandlesAt` + `evaluate` per bar; `slice` grows each bar | Medium |
| `buildRSIHistory`, `buildMACDHistogramHistory` | Rebuilds full history each time | Low |
| `calculatePOC` | Iterates all candles | Low |

**Recommendation:** For backtest, consider incremental indicator updates (e.g. rolling RSI) instead of recomputing from slice start each bar. For live, current behavior is acceptable (fixed window ~168 bars).

---

## 6. Follow-Up Audits (2026-03-04)

### 6.1 Rate Limiting (CoinGecko / MarketScanner)

| Location | Before | After |
|----------|--------|-------|
| `crypto-api.js` | Reactive 25s wait on 429; no queue | `lib/api-queue.js`: queue + throttler, 6s spacing, exponential backoff |
| `market-scanner.js` | Sequential sleep(1500ms); throws on 429 | Uses `marketScannerThrottler`; 1.5s spacing, exponential backoff |
| `fetchCoinGeckoPricesOnce`, `fetchHistoryOnce` | Direct fetch, throw on 429 | Wrapped with `coingeckoThrottler`; retries with backoff |

**Implementation:** `lib/api-queue.js` – `createThrottler()`, `coingeckoThrottler`, `marketScannerThrottler`. Per-throttler state (queue, lastRequestAt, consecutive429). Exponential backoff: `baseBackoffMs * 2^(n-1)` capped at `maxBackoffMs`.

### 6.2 Stale Trailing Stop

| Location | Before | After |
|----------|--------|-------|
| `paper-trading.js` | `trailingActivated = true` unconditionally in trailing TP mode | Only set when `pricePastEntry` (0.3% past entry) |
| `manage-engine.js` | Same | Same threshold gate |
| Reset | Stop at/before entry → reset | Unchanged (already correct) |

**Implementation:** `TRAIL_ACTIVATION_THRESHOLD = 0.003`. LONG: `currentPrice >= entry * 1.003`. SHORT: `currentPrice <= entry * 0.997`.

### 6.3 SMC Order Block & FVG Invalidation

| Location | Before | After |
|----------|--------|-------|
| `trading-engine.js` `detectOrderBlocks` | Returned OBs regardless of price action | `filterInvalidOrderBlocks`: remove bull OB if any low < ob.bottom; bear OB if any high > ob.top |
| `detectFVGs` | Same | `filterInvalidFVGs`: remove bull FVG if filled (low < bottom); bear FVG if filled (high > top) |

**Implementation:** After forming OB/FVG at idx, scan candles from idx+1 to end. Invalidate when price trades through zone.

### 6.4 Low Liquidity Filter

| Location | Before | After |
|----------|--------|-------|
| `market-scanner.js` | No volume filter | `MIN_VOLUME_24H_USD = 1e6`; filter `m.total_volume < minVol` |
| `smc-scanner.js` `scanMarketForSetups` | No filter | Optional `minVolume24hUsd`; skip when `volume24h < minVol` |
| `evaluateSetupsForAutoTrade` | No filter | Same; uses `prices[].volume24h` when available |
| `voting-app.js` | N/A | Passes `user.settings.minVolume24hUsd` to setup evaluation |

**Implementation:** Default 1M USD. Paper-trading and backtest already had `minVolume24hUsd` from user settings.

### 6.5 Backtest Indicator Warm-up

| Location | Before | After |
|----------|--------|-------|
| `run-backtest.js` | Loop started at t=50; minBars 20 | `INDICATOR_WARMUP_BARS = 50`; `sliceCandlesAt` minBars 50 (1h), 30 (4h) |
| `market-data.js` | minBars 20 for 1h | minBars 50 for 1h, 30 for 4h |
| `smc-backtest.js` | startBar = min(40, len/4) | `WARMUP_BARS` 50 (1h) / 25 (4h); `startBar = max(WARMUP_BARS, min(40, len/4))` |

**Implementation:** RSI(14), MACD(26+9), BB(20), ATR(14) need ~50 bars. No signals before warmup.

### 6.6 LLM Context Window

| Location | Before | After |
|----------|--------|-------|
| `llm-chat.js` | system 8k cap; last 10 messages | `trimMessagesToFit()`: keep last 6 messages when total > 14k chars |
| Context limit | No explicit token/char limit | `MAX_CONTEXT_CHARS = 14000`; log when trimming |

**Implementation:** When system + messages exceed 14k chars, keep most recent 6 messages. Log trim events.

---

## Summary: Priority Fixes

| Priority | Item | Action |
|----------|------|--------|
| High | `paper-trading.js` | Guard `trade.entryPrice` in close/partial before PnL |
| Medium | `manage-engine.js` | Replace `tp === trade.entryPrice` with tolerance check |
| Medium | Candle validation | Add `validateCandle()` at scanner/detail ingestion |
| Low | Bitget/Kraken | Wrap `.map()` in try/catch for malformed data |
| Low | Performance | Incremental indicators for backtest (future) |
