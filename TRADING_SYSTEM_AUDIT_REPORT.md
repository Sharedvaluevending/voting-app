# Trading System Audit Report

**Date:** March 1, 2025  
**Scope:** Main engine, Setups (SMC), Trench Warfare, all 4 agents, indicators, stops, TPs, trailing, ATR, backtests, long/short logic, toggles, bugs, edge cases.

---

## 1. The 4 Agents / Engines — Responsibility Split

| Agent | File | Responsibility | Status |
|-------|------|----------------|--------|
| **Signal Engine** | `services/engines/signal-engine.js` | Evaluates market snapshot → trading decision (side, entry, SL, TP1/2/3, score). Uses `trading-engine.analyzeCoin`. Single source for signal evaluation. | ✅ Wired |
| **Risk Engine** | `services/engines/risk-engine.js` | Position sizing, order planning, leverage, fees, slippage, SL cap, min SL distance, TP mode (fixed/trailing). Pure function, no DB. | ✅ Wired |
| **Manage Engine** | `services/engines/manage-engine.js` | Trade management: breakeven, trailing stop, lock-in, score recheck (EXIT/RP/PP), SL/TP hits. Returns actions; caller executes. | ✅ Wired |
| **LLM Agent** | `services/llm-agent.js` | Autonomous agent: settings, backtests, risk, stops, TPs, feature toggles. Uses Ollama/DeepSeek. | ✅ Wired |

**Wiring:** Backtest (`run-backtest.js`) and paper-trading both use SignalEngine → RiskEngine → ManageEngine. Trench warfare and SMC setups use separate logic (by design).

---

## 2. Main Trading System (`trading-engine.js`)

### 2.1 Long / Short Logic
- **Signal mapping:** `STRONG_BUY`/`BUY` → `LONG`; `STRONG_SELL`/`SELL` → `SHORT`
- **BTC filter:** No LONG alts when BTC `STRONG_SELL`; no SHORT when BTC `STRONG_BUY`
- **Levels:** `calculateTradeLevels()` correctly handles both:
  - LONG: SL below entry, TPs above entry
  - SHORT: SL above entry, TPs below entry
- **Top/bottom gate:** No BUY at potential top, no SELL at potential bottom

### 2.2 Indicators
- **ATR:** `ATR_OHLC(highs, lows, closes, 14)` — used for SL distance, volatility classification, order blocks
- **Strategy ATR multipliers:** scalping 1.2, momentum/breakout/mean_revert 1.5, trend_follow/swing 2, position 2.5
- **TP R-multiples:** Per strategy (e.g. scalping tp1R=1, tp2R=1.5, tp3R=2)
- **Indicators returned:** `atr`, `rsi`, `macd`, etc. in `result.indicators`

### 2.3 Stops, Take Profits, Trailing
- **Fixed TP:** 40/30/30 split (TP1_PCT, TP2_PCT, TP3_PCT)
- **Trailing TP:** ATR-based or fixed % (`trailingTpDistanceMode`, `trailingTpAtrMultiplier`, `trailingTpFixedPercent`)
- **Breakeven:** 0.75R (BE_R_MULT)
- **Trailing stop:** 1.5R behind max price (TRAILING_START_R, TRAILING_DIST_R)
- **Lock-in:** 0.5R, 0.75R, 1R progress levels
- **Min SL distance:** 1× ATR floor when `featureMinSlDistance` enabled
- **SL cap:** Max 15% from entry (MAX_SL_DISTANCE_PCT)

---

## 3. Setups (SMC) — `smc-scanner.js`, `smc-backtest.js`

### 3.1 Logic
- **4h HTF bias:** No LONG when BEAR, no SHORT when BULL
- **ATR SL/TP:** 2× ATR SL, 4× ATR TP (2:1 RR)
- **LONG:** sl = entry - riskDist, tp1 = entry + rewardDist, tp2/tp3 scaled
- **SHORT:** sl = entry + riskDist, tp1 = entry - rewardDist, tp2/tp3 scaled
- **Min risk floor:** `Math.max(atr * 2, entryPrice * 0.005)` to avoid tiny stops

### 3.2 SMC Backtest
- Uses single `takeProfit` (not TP1/TP2/TP3) — simplified
- Exit price: `nextBar.open` (not intrabar SL/TP price) — acceptable simplification
- Slippage: LONG exit `/ slip`, SHORT exit `* slip` — correct
- Position size: `(riskAmount / riskDist) * adjEntry` — correct dollar sizing

---

## 4. Trench Warfare — `trench-auto-trading.js`

### 4.1 Scope
- **LONG only** — memecoin/scalping buys tokens, no shorts
- **Modes:** memecoin (pump-start) vs scalping (traditional)

### 4.2 Stops / TPs
- **TP/SL:** User-configurable % (memecoin: 1–5% TP, 2% SL; scalping: 5–50% TP, 8% SL)
- **Trailing:** Adaptive by PnL (memecoin: 1.5–3%; scalping: 4–8%)
- **Breakeven:** `breakevenAtPercent`, `useBreakevenStop`
- **Early bail:** Down at 60%/50% of hold time
- **Stale position:** Flat after 70% of hold → exit

### 4.3 Logic
- Momentum confirmation (20s memecoin, 45s scalping)
- Price acceleration check (reject fading pumps)
- Cooldown: losers 4×, big losers 8×, winners 2×
- Kelly sizing when enabled

---

## 5. Backtest Logic — `run-backtest.js`

### 5.1 Flow
1. Bar-by-bar simulation
2. SignalEngine.evaluate → RiskEngine.plan → ManageEngine.update
3. Close-based stops (configurable via `closeBasedStops`)
4. DCA, BTC filter, session filter, min R:R
5. Execution simulator: slippage (ATR-based), fees

### 5.2 Long / Short
- PnL: LONG `(adjExit - entry)/entry * size`, SHORT `(entry - adjExit)/entry * size` — correct
- Slippage: LONG exit `/ slipMul`, SHORT exit `* slipMul` — correct
- SL hit: LONG `slCheckPrice <= stopLoss`, SHORT `slCheckPrice >= stopLoss` — correct
- TP hit: LONG `tpHigh >= tp`, SHORT `tpLow <= tp` — correct

### 5.3 Edge Cases
- **Trailing TP mode:** `trailingActivated = true` on entry — standard trailing stop skipped
- **Score recheck:** Every 6 bars (SCORE_RECHECK_INTERVAL)
- **Stop grace:** 1 bar (STOP_GRACE_BARS) before BE/trailing

---

## 6. Bugs & Edge Cases Found

### 6.1 Duplicate Logic (Maintenance Risk) — FIXED
- **Paper-trading** now imports `getProgressTowardTP`, `getLockInStopPrice`, `getCurrentLockR`, `LOCK_IN_LEVELS` from ManageEngine
- Single source of truth; removed ~40 lines of duplicate logic

### 6.2 Strategy Builder — LONG Only — FIXED
- Added SHORT support: `strategy.direction === 'SHORT'` returns SELL signal
- run-custom-backtest handles both BUY (LONG) and SELL (SHORT) with correct SL/TP/slippage

### 6.3 Risk Engine — ATR for minSlDistance
- Uses `decision.indicators?.atr`
- If `indicators` or `atr` is missing, minSlDistance block is skipped (no error)
- Trading engine returns `atr` in indicators — OK when using SignalEngine

### 6.4 SMC Backtest — Single TP
- Uses one `takeProfit` level; scanner provides tp1, tp2, tp3
- Backtest does not scale out at TP1/TP2 — intentional simplification

### 6.5 Manage Engine — getCurrentLockR
- **LONG:** `dist = stopLoss - entry` — when locked in, stopLoss > entry ✓
- **SHORT:** `dist = entry - stopLoss` — when locked in, stopLoss < entry ✓
- Logic verified correct

### 6.6 Execution Simulator — Slippage
- LONG entry: `price * mult` (pay more) ✓
- SHORT entry: `price / mult` (receive less) ✓
- LONG exit: `price / mult` (receive less) ✓
- SHORT exit: `price * mult` (pay more) ✓

---

## 7. Feature Toggles — Wiring Check

| Toggle | Backtest | Paper | Risk Engine | Manage Engine |
|--------|----------|-------|-------------|---------------|
| btcFilter | ✓ | ✓ | — | — |
| breakeven | ✓ | ✓ | — | ✓ |
| trailingStop | ✓ | ✓ | — | ✓ |
| lockIn | ✓ | ✓ | — | ✓ |
| scoreRecheck | ✓ | ✓ | — | ✓ |
| partialTP | ✓ | ✓ | — | ✓ |
| slCap | — | ✓ | ✓ | — |
| minSlDistance | ✓ | ✓ | ✓ | — |
| confidenceSizing | — | ✓ | ✓ | — |
| kellySizing | — | ✓ | ✓ | — |
| trailingTp | ✓ | ✓ | ✓ | ✓ |

---

## 8. Math Verification

### 8.1 Position Sizing
```
stopDistance = |entry - stopLoss| / entry
positionSize = (riskAmount / stopDistance) * leverage
```
- Correct for both LONG and SHORT (Math.abs handles both)

### 8.2 PnL
- LONG: `(exit - entry) / entry * size`
- SHORT: `(entry - exit) / entry * size`
- Both correct

### 8.3 Risk (1R)
- LONG: `entry - stopLoss`
- SHORT: `stopLoss - entry`
- Both positive when SL is on correct side

### 8.4 Kelly (Risk Engine)
```
kellyFull = w - (1-w)/r
```
- Correct formula
- Blend: 70% risk-based + 30% kelly — reasonable

---

## 9. Recommendations

1. **Refactor paper-trading** to use ManageEngine.update() instead of duplicating logic.
2. **Add SHORT support** to Strategy Builder when needed.
3. **Document** SMC backtest’s single-TP simplification for clarity.
4. **Add unit tests** for ManageEngine SHORT paths (getProgressTowardTP, getLockInStopPrice, getCurrentLockR).
5. **Consider** intrabar path (e.g. `intrabar-path.js`) for more accurate SL/TP fill prices in backtest.

---

## 10. Summary

| Area | Status | Notes |
|------|--------|-------|
| 4 Agents split | ✅ | Clear separation, wired correctly |
| Main engine long/short | ✅ | Logic correct |
| SMC setups | ✅ | HTF bias, ATR levels correct |
| Trench warfare | ✅ | LONG only, adaptive trailing |
| Backtest | ✅ | Uses shared engines, math correct |
| Paper-trading | ⚠️ | Duplicate manage logic |
| Strategy builder | ⚠️ | LONG only |
| Indicators/ATR | ✅ | Consistent usage |
| Stops/TPs/trailing | ✅ | Logic and math verified |
