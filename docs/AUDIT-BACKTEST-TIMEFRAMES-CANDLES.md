# Backtest Timeframes, Candles & API Audit

**Date:** 2026-03-05  
**Scope:** Main backtest (not Trench Warfare) — timeframes, candle fetching, API calls, data availability for 1 year+

---

## 1. Supported Timeframes

| Timeframe | Backtest UI | Bitget API | Kraken Fallback | Data for 1yr |
|-----------|-------------|------------|-----------------|--------------|
| 15m       | ✓           | ✓          | ~720 bars (~7.5d) | ✓ Bitget paginated |
| 1h        | ✓           | ✓          | ~720 bars (~30d)  | ✓ Bitget paginated |
| 4h        | ✓           | ✓          | ~720 bars (~120d) | ✓ Bitget paginated |
| 1d        | ✓           | ✓          | ~720 bars (~2yr)  | ✓ Bitget paginated |
| 1w        | ✓           | ✓          | ~720 bars (~14yr) | ✓ Bitget paginated |

- **Backtest UI** (`views/backtest.ejs`): 15m, 1h, 4h, 1d, 1w
- **Backend** (`voting-app.js`): `VALID_TFS = ['15m','1h','4h','1d','1w']`
- **1w** added 2026-03-05 for swing/position strategies

---

## 2. API Architecture

### 2.1 Bitget (Primary)

- **Endpoints:**
  - `/api/v2/mix/market/candles` — recent data (within CANDLES_ENDPOINT_DAYS)
  - `/api/v2/mix/market/history-candles` — older historical data
- **Window limit:** Max 7 days between `startTime` and `endTime` per request
- **Pagination:** Sequential 7-day chunks, 200 candles max per request
- **Rate limit:** ~10 req/s (IP-based); we use 200ms delay between pages

### 2.2 CANDLES_ENDPOINT_DAYS (crypto-api.js)

| Interval | Recent (candles) | Older (history-candles) |
|----------|------------------|--------------------------|
| 15m      | 50 days          | history-candles          |
| 1h       | 80 days          | history-candles          |
| 4h       | 235 days         | history-candles          |
| 1d       | 9999 (unlimited) | either                   |
| 1w       | 9999 (unlimited) | either                   |

- When `cursor < Date.now() - recentLimitDays`, use `history-candles`
- Both endpoints use same 7-day window cap

### 2.3 Pagination Logic (fetchHistoricalCandlesForCoin)

```
cursor = startMs
while cursor < endMs:
  chunk = fetch(cursor, min(endMs, cursor + 7 days))
  all.push(...chunk)
  cursor = lastTs + msPerCandle
  delay 200ms
```

- **MAX_PAGES:** 500 (safety limit)
- **1 year 1h:** ~8,760 bars → ~52 pages → ~11s fetch time
- **1 year 15m:** ~35,040 bars → ~175 pages → ~35s fetch time

---

## 3. Kraken Fallback

- Used when Bitget returns &lt; 50 candles
- **Limit:** ~720 candles per interval (Kraken OHLC API)
- **1h:** 720 bars = 30 days — **not sufficient for 1 year**
- Kraken is suitable for short ranges only; Bitget is required for 1yr+

---

## 4. Timeouts & Performance

| Setting | Value | Location |
|---------|-------|----------|
| PER_COIN_FETCH_TIMEOUT | 240s (4 min) | services/backtest.js |
| PER_COIN_BACKTEST_TIMEOUT | 240s (4 min) | services/backtest.js |
| BITGET_DELAY | 200ms | services/crypto-api.js |
| fetch timeout | 12s per request | crypto-api.js |

- **1 year, 1 coin, 1h:** ~52 pages × 200ms ≈ 11s + network
- **1 year, 1 coin, 15m:** ~175 pages × 200ms ≈ 35s + network
- **Multi-coin:** 2 coins in parallel; 240s timeout should cover 1yr × 3 TFs

---

## 5. Multi-TF Fetch (fetchHistoricalCandlesMultiTF)

- **Primary 15m:** Fetches 15m, 1h, 4h, 1d (4 TFs in parallel)
- **Primary 1h/4h/1d:** Fetches 1h, 4h, 1d (3 TFs in parallel)
- **Warmup:** 100 bars of primary TF before start date
- **Cache:** `backtest-cache.js` — keyed by (coinId, fetchStartMs, endMs)

---

## 6. Date Range

- **UI default:** Last 90 days
- **No server-side cap** on date range — user can pick any start/end
- **Backend default** (if no dates): `Date.now() - 90 days` to `Date.now()`

---

## 7. Findings & Recommendations

### ✓ Working

1. **Bitget pagination** — 7-day chunks correctly implemented
2. **Endpoint selection** — candles vs history-candles based on data age
3. **Timeframes 15m, 1h, 4h, 1d** — all support 1 year+ via Bitget
4. **Timeout** — 240s sufficient for 1yr single-coin
5. **Cache** — avoids re-fetch when same range requested

### ⚠ Considerations

1. **Kraken fallback** — Only ~30 days for 1h; 1yr will fail if Bitget down
2. **Long ranges** — 1yr 15m can take 1–2 min; use 1h/4h for faster 1yr runs

### Implemented (2026-03-05)

1. **1w timeframe** — Added to backtest UI, backend, market-data, run-backtest
2. **Timeout message** — Updated to "1yr+ supported; try 1h/4h TF or fewer coins if slow"
3. **Date presets** — 6m and 1yr buttons next to Start Date for quick 1-year backtests
