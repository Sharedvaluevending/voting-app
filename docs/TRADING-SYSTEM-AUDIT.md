# Trading System Audit Report

**Date:** 2025-03-01  
**Scope:** All pages, trading systems (main, setups, trench warfare), 4 signal agents, indicators, toggles, stops, TPs, trailing, ATR, backtests.

---

## 1. The 4 Signal Agents (autoTradeSignalMode)

| Agent | Mode Value | Source | LONG | SHORT | Wired In |
|-------|------------|--------|------|-------|----------|
| **1. Original** | `original` | `trading-engine.js` via `analyzeAllCoins` / SignalEngine | ✅ | ✅ | `voting-app.js` ~3762 |
| **2. Indicators** | `indicators` | `evaluateStrategyForAutoTrade` (Strategy Builder rule engine) | ✅ | ✅ | `voting-app.js` ~3786 |
| **3. Setups** | `setups` | `evaluateSetupsForAutoTrade` (SMC scenarios) | ✅ | ✅ | `voting-app.js` ~3810 |
| **4. Both** | `both` | Combines Original + Setups OR Original + Indicators (OR/AND via `autoTradeBothLogic`) | ✅ | ⚠️ | `voting-app.js` ~3797, ~3817 |

**Wiring:** All 4 modes are correctly wired in `voting-app.js` around lines 3782–3828. When `both` is selected:
- If indicators config exists: stratSignals replace/merge with signals
- If setupIds exist: setupSignals merge with signals
- `autoTradeBothLogic`: `or` = union of coins; `and` = intersection

---

## 2. Trading Systems Overview

### 2.1 Main Trading Engine (`trading-engine.js`)

- **Timeframes:** 15m, 1h, 4h, 1d, 1w
- **Scoring:** 6 categories (trend, momentum, volume, structure, volatility, riskQuality)
- **LONG/SHORT:** Via `dominantDir` (BULL/BEAR), `topStrategies`, blended signal
- **BTC filter:** No LONG when BTC STRONG_SELL, no SHORT when BTC STRONG_BUY
- **Stops/TPs:** ATR-based by regime + strategy (scalping 1.2×, position 2.5× ATR)
- **Indicators:** ATR_OHLC, EMA, VWAP, order blocks, FVGs, volatility state

### 2.2 Setups (SMC) (`smc-scanner.js`, `smc-scenarios/`)

- **Scenarios:** 14 setups (fvg_liquidity_long/short, accumulation_long, distribution_short, etc.)
- **Direction:** Each scenario has `direction: 'LONG' | 'SHORT'`
- **4h HTF bias:** Blocks LONG when 4h BEAR, blocks SHORT when 4h BULL
- **SL/TP:** SL = 2× ATR, TP = 4× ATR (2:1 RR); TP2 = 1.2× reward, TP3 = 1.5× reward

### 2.3 Trench Warfare (`trench-auto-trading.js`)

- **Modes:** Memecoin (pump-start) vs Scalping
- **Direction:** LONG only (buy memecoins/scalps)
- **TP/SL:** Memecoin 1–3% TP, 2% SL; Scalping 8–12% TP, 8% SL
- **Trailing:** Adaptive by PnL (memecoin: 1.5–3%; scalping: 4–8%)
- **Breakeven:** `breakevenAtPercent` (memecoin 1%, scalping 3%)

---

## 3. Long/Short Logic Summary

| System | LONG | SHORT | Notes |
|--------|------|-------|-------|
| Main engine | ✅ | ✅ | SignalEngine picks best strategy direction |
| Setups | ✅ | ✅ | Scenario direction + HTF bias filter |
| Strategy Builder | ✅ | ❌ | `evaluateBar` returns BUY only; no SELL/short |
| Trench | ✅ | ❌ | By design (memecoin/scalping) |

---

## 4. Indicators & ATR

| Location | ATR Source | Period | Usage |
|----------|------------|--------|-------|
| `trading-engine.js` | `ATR_OHLC(highs, lows, closes, 14)` | 14 | Stops, order blocks, volatility |
| `lib/indicators.js` | `ATR(highs, lows, closes, 14)` | 14 | Strategy Builder |
| `smc-scanner.js` | `ATR_OHLC` from trading-engine | 14 | SL/TP for setups |
| `smc-backtest.js` | `ATR_OHLC` | 14 | Backtest SL/TP |
| `strategy-builder/run-custom-backtest.js` | `ind.ATR` from lib | 14 | Backtest + auto-trade |

**ATR implementations:** `ATR_OHLC` (trading-engine) and `ind.ATR` (lib/indicators) use the same TR formula; results should match.

---

## 5. Stops, Take Profits, Trailing

### 5.1 Risk Engine (`risk-engine.js`)

- **Slippage:** 5 bps (LONG pay more, SHORT receive less)
- **SL cap:** Max 15% from entry
- **Min SL distance:** 1× ATR when `minSlDistance` enabled
- **TP mode:** `fixed` (TP1/2/3) or `trailing` (ATR or fixed %)
- **Trailing TP:** `trailingTpDistanceMode: 'atr' | 'fixed'`, `trailingTpAtrMultiplier` default 1.5

### 5.2 Manage Engine (`manage-engine.js`)

- **Breakeven:** At 0.75R (`BE_R_MULT`), move to entry + 0.3% buffer
- **Trailing stop:** At 1.5R (`TRAILING_START_R`), trail 1.5R behind max price
- **Lock-in:** 0.5R at 50% progress, 0.75R at 75%, 1R at 90%
- **Score recheck:** EXIT at -45 diff or flipped signal + -40; RP at -35/-30; PP near TP1

### 5.3 Trench Warfare

- **Trailing:** Adaptive by peak PnL (memecoin: 1.5–3%; scalping: 4–8%)
- **Breakeven:** Triggered at `breakevenAtPercent`, then sell if price drops to entry

---

## 6. Backtests

| Backtest | File | Uses | LONG | SHORT |
|----------|------|------|------|-------|
| Main | `backtest/run-backtest.js` | SignalEngine, RiskEngine, ManageEngine | ✅ | ✅ |
| SMC Setups | `smc-backtest.js` | Scenario checks, ATR SL/TP | ✅ | ✅ |
| Strategy Builder | `strategy-builder/run-custom-backtest.js` | Rule engine | ✅ | ❌ |

---

## 7. Feature Toggles (User.settings)

| Toggle | Default | Purpose |
|--------|---------|---------|
| `autoMoveBreakeven` | ON | Breakeven at 0.75R |
| `autoTrailingStop` | ON | Trailing at 1.5R |
| `featureLockIn` | ON | Stepped profit lock-in |
| `featureScoreRecheck` | ON | EXIT/RP/PP on score collapse |
| `featureSlCap` | ON | Max 15% SL distance |
| `featureMinSlDistance` | ON | Min 1× ATR |
| `featureConfidenceSizing` | ON | Score-weighted size |
| `featureKellySizing` | ON | Kelly blend with risk-based |
| `featureBtcFilter` | ON | No LONG when BTC bearish |
| `featurePartialTP` | ON | 40/30/30 TP split |

---

## 8. Bugs & Edge Cases Found

### 8.1 FIXED: Cooldown Query Wrong Field

**Location:** `voting-app.js` lines 3635, 3866  
**Issue:** Cooldown used `closedAt` but Trade model has `exitTime`. Cooldown never matched, so re-entry was never blocked.  
**Fix:** Replaced `closedAt` with `exitTime`.

### 8.2 Strategy Builder: SHORT Support (FIXED)

**Location:** `run-custom-backtest.js`, `evaluateStrategyForAutoTrade`, `rule-engine.js`  
**Fix:** Added `side: 'long' | 'short'` to StrategyConfig. When `side === 'short'`, entry signals return SELL; backtest and auto-trade handle SHORT positions with correct SL/TP.

### 8.3 Risk Engine: ATR Fallback (FIXED)

**Location:** `risk-engine.js`  
**Fix:** When ATR is missing or 0, use `entryPrice * 0.005` (0.5%) as fallback for min SL distance. Trailing TP in `atr` mode falls through to fixed % when ATR unavailable.

### 8.4 SMC TP2/TP3 Scaling

**Location:** `smc-scanner.js` lines 72–80, 169–180  
**Note:** TP2 = entry + rewardDist×1.2, TP3 = entry + rewardDist×1.5. With 2:1 RR, TP1 = 2R, TP2 = 2.4R, TP3 = 3R. TP split 40/30/30 is consistent.

### 8.5 Trailing TP Mode vs Breakeven

**Location:** `manage-engine.js`  
**Note:** When `tpMode === 'trailing'`, `trailingActivated` is set immediately, so breakeven logic is skipped. Trailing starts from best price minus distance. Intentional.

### 8.6 Both Mode: Indicators + Setups Order

**Location:** `voting-app.js` ~3786–3828  
**Note:** When `both` with indicators config and setupIds, indicators run first (replace signals), then setups merge. So "both" = indicators + setups. Order is correct.

---

## 9. Logic & Math Verification

| Check | Status |
|-------|--------|
| LONG: SL below entry, TP above | ✅ risk-engine, manage-engine |
| SHORT: SL above entry, TP below | ✅ risk-engine, manage-engine |
| Slippage: LONG pays more, SHORT receives less | ✅ risk-engine |
| ATR TR formula | ✅ Same in trading-engine and lib/indicators |
| SMC backtest: SL/TP on correct side | ✅ smc-backtest.js |
| Manage-engine lock-in R calculation | ✅ getCurrentLockR, getLockInStopPrice |
| Trench PnL: (slippedPrice - entry) / entry * 100 | ✅ trench-auto-trading.js |

---

## 10. Recommendations

1. ~~**Strategy Builder SHORT:**~~ Fixed: Added `side: 'short'` support.
2. ~~**ATR fallback:**~~ Fixed: Use 0.5% of price when ATR missing.
3. ~~**Cooldown field:**~~ Fixed: Use `exitTime` instead of `closedAt`.
4. **Tests:** Add unit tests for manage-engine lock-in, risk-engine SL/TP validation, and SMC scenario direction.
