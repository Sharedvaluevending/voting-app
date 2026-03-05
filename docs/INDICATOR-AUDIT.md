# Indicator & Advanced Indicator Audit

Audit of FVG, Order Blocks, Liquidity Clusters, and all indicators. Logic and math verified.

---

## SMC / Price-Action Indicators

### Fair Value Gap (FVG) — ✅ CORRECT
**Location:** `services/trading-engine.js` → `detectFVGs(highs, lows)`

**Standard definition:**
- **Bullish FVG:** Candle 1 high < Candle 3 low (gap between them). Zone: bottom = candle 1 high, top = candle 3 low.
- **Bearish FVG:** Candle 1 low > Candle 3 high (gap between them). Zone: bottom = candle 3 high, top = candle 1 low.

**Implementation:** Uses candles at indices `i`, `i+1`, `i+2`. Conditions and zone bounds match the standard.

---

### Order Blocks (OB) — ✅ CORRECT
**Location:** `services/trading-engine.js` → `detectOrderBlocks(opens, highs, lows, closes, atr)`

**Standard definition:**
- **Bullish OB:** Last bearish candle before a strong bullish move. Zone = high/low of that bearish candle.
- **Bearish OB:** Last bullish candle before a strong bearish move. Zone = high/low of that bullish candle.

**Implementation:**
- Bullish: `bodyPrev < 0` (bearish) and `bodyNext > atr * 0.4` (strong bullish).
- Bearish: `bodyPrev > 0` (bullish) and `bodyNext < -atr * 0.4` (strong bearish).
- Zone stored as `{ top: highs[i], bottom: lows[i] }` for the opposing candle.
- Iterates backward from the most recent candles.

---

### Liquidity Clusters — ✅ FIXED
**Location:** `services/trading-engine.js` → `detectLiquidityClusters(highs, lows, currentPrice)`

**Changes made:**
1. **Swing detection:** Switched from 3-point to 5-point swings to match `getSwingPoints` and `detectMarketStructure`.
2. **Division by zero:** Added guard when `group[group.length - 1]` is 0 for clustering.

**Logic:** Groups swing highs/lows within 0.5% into clusters, then picks the nearest cluster above (resistance) and below (support) current price.

---

## Technical Indicators

### SMA / EMA — ✅ CORRECT
- SMA: `sum(slice) / period`
- EMA: `k = 2/(period+1)`, `ema = (price - ema) * k + ema`

### RSI — ✅ CORRECT (SMA variant)
- Uses simple average of gains/losses over the period.
- Standard Wilder RSI uses smoothed averages; SMA is a common approximation.
- Formula: `100 - (100 / (1 + avgGain/avgLoss))`

### MACD — ✅ CORRECT
- MACD line = EMA(12) - EMA(26)
- Signal = EMA(9) of MACD line
- Histogram = MACD - Signal

### ATR — ✅ CORRECT
- True Range = max(high-low, |high-prevClose|, |low-prevClose|)
- ATR = SMA of last N TR values

### ADX — ⚠️ APPROXIMATION
- Uses SMA of last 14 periods for +DM, -DM, and TR.
- Standard ADX uses Wilder’s smoothing (RMA).
- Difference is small; many implementations use SMA for simplicity.

### Bollinger Bands — ✅ CORRECT
- Mid = SMA(period)
- StdDev = sqrt(variance of slice)
- Upper = mid + 2*stdDev, Lower = mid - 2*stdDev

### Stochastic — ✅ CORRECT
- %K = (close - low14) / (high14 - low14) * 100
- %D = 3-period average of %K

### VWAP — ✅ FIXED
**Location:** `services/trading-engine.js` → `calculateVWAP(candles)`

- Uses last 20 candles (rolling approximation; true VWAP is session-cumulative).
- **Fix:** Handles missing/undefined volume with `(c.volume ?? 0)` to avoid NaN.

---

## POC / Volume Profile

### calculatePOC — ✅ CORRECT (with guard)
- Buckets price by (high+low)/2, accumulates volume.
- POC = center of bucket with max volume.
- **Fix:** `idx` clamped with `Math.max(0, ...)` to avoid negative indices.

### calculateVolumeProfile — ✅ CORRECT
- Distributes volume across buckets spanned by each candle’s high-low.
- Uses `(c.volume || 0)` and skips zero-volume candles.

---

## Pivot Points — ✅ CORRECT
**Location:** `voting-app.js` (chart API)

- P = (H + L + C) / 3
- R1 = 2*P - L, R2 = P + (H - L)
- S1 = 2*P - H, S2 = P - (H - L)

---

## Divergence Detection — ✅ CORRECT
- RSI, MACD, OBV, Stochastic divergence use swing points and index alignment.
- Bullish: price lower low, indicator higher low.
- Bearish: price higher high, indicator lower high.

---

## Candlestick & Chart Patterns
- Candlestick patterns (hammer, engulfing, etc.): logic verified.
- Chart patterns (flags, wedges, H&S): use swing detection and linear regression.

---

## Trading Logic Audit

### Signal Engine — ✅ CORRECT
- Wraps `analyzeCoin`, picks best strategy by score, normalizes to decision object.
- Entry/stop/TP levels come from strategy or blended signal.

### Risk Engine — ✅ CORRECT
- **Position sizing:** `riskAmount / stopDistance * leverage` (riskAmount = balance × risk% or fixed $).
- **SL validation:** Wrong-side SL corrected; max 15% distance; min 1× ATR.
- **TP mode:** Fixed (TP1/2/3) or trailing (ATR-based).
- **Kelly blend:** 70% risk-based + 30% Kelly when strategy has 15+ trades.

### Manage Engine — ✅ CORRECT
- **Breakeven:** At 0.75R, move SL to entry + 0.3%.
- **Trailing:** Activates at 1.5R, trails 2R behind best price.
- **Partial TPs:** TP1=40%, TP2=30%, TP3=30% of original size.
- **Score recheck:** EXIT at -45 diff or signal flip; RP at -35; PP near TP1 when weakening.

### Level Computation (trading-engine) — ✅ CORRECT
- **Entry:** Current price (rounded).
- **Stop:** ATR × mult + S/R bounds; Fib refinement when level between entry and stop.
- **TPs:** R-multiples (1.5R, 2.5R, 4R default) from risk distance.
- **Strategy levels:** STRATEGY_LEVELS defines atrMult, tp1R, tp2R, tp3R per strategy.

---

## Tests Run
- `scripts/test-indicators-and-trading.js` — 12 checks (SMA, EMA, RSI, ATR, BB, FVG, OB, liquidity, analyzeOHLCV, position sizing, manage engine, risk plan).
- `npm test tests/unit/risk-engine.test.js tests/unit/scoring.test.js` — 21 tests pass.
- `scripts/test-backtest-risk-balance.js` — balance, risk %, fees, return %, dollar mode (requires API).

---

## Summary of Fixes Applied
1. **calculateVWAP:** Handle undefined volume with `(c.volume ?? 0)`.
2. **detectLiquidityClusters:** Use 5-point swings and guard against division by zero.
3. **calculatePOC:** Clamp bucket index with `Math.max(0, ...)`.
