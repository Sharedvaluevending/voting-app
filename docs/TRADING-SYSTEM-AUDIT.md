# Trading System Audit Report

**Date:** 2025-03-01  
**Scope:** Main trading, Setups (SMC), Trench Warfare, Strategy Builder, Backtests, 4 Engines/Agents

---

## 1. The 4 Agents / Engines — Responsibility Split

| Agent | File | Responsibility |
|-------|------|----------------|
| **Signal Engine** | `services/engines/signal-engine.js` | Wraps `trading-engine.analyzeCoin`, returns canonical decision: side, strategy, score, entry, SL, TP1/2/3, riskReward, indicators. Picks best strategy for direction + levels. |
| **Risk Engine** | `services/engines/risk-engine.js` | Position sizing, order planning, leverage, fees, slippage, SL cap, min SL distance, confidence/Kelly sizing, TP mode (fixed vs trailing). Pure function, no DB. |
| **Manage Engine** | `services/engines/manage-engine.js` | Breakeven (0.75R), trailing stop (1.5R), lock-in (0.5/0.75/1R), score recheck (EXIT/RP/PP), TP partials, SL hit. Returns actions; caller executes. |
| **LLM Agent** | `services/llm-agent.js` | Autonomous control: settings, trades, backtests, stops, TPs. Uses Ollama. Validates and bounds all actions. |

**Note:** Only the LLM Agent is an AI agent; the others are deterministic engines.

---

## 2. Main Trading System

### 2.1 Flow
```
trading-engine.analyzeCoin → signal-engine.evaluate → risk-engine.plan → paper-trading.openTrade
                                                                       → manage-engine.update (on checkStopsAndTPs)
```

### 2.2 Long/Short Logic
- **Signal:** `STRONG_BUY`/`BUY` → LONG; `STRONG_SELL`/`SELL` → SHORT
- **Score:** 0–100; ≥55 BUY, ≤45 SELL, 45–54 HOLD
- **BTC filter:** No alt LONG when BTC STRONG_SELL; no alt SHORT when BTC STRONG_BUY
- **Top/bottom:** No BUY at potential top, no SELL at potential bottom
- **Levels:** `calculateTradeLevels` uses ATR + S/R + Fib; strategy-specific atrMult, tp1R/tp2R/tp3R

### 2.3 Indicators
- **trading-engine.js:** EMA, RSI, MACD, ADX, ATR, Bollinger, Keltner, order blocks, FVGs, liquidity clusters, divergence (RSI/MACD/OBV/Stoch)
- **ATR:** `ATR_OHLC(highs, lows, closes, 14)` — used for Keltner, order blocks, volatility, stop/TP levels

### 2.4 Stops, Take Profits, Trailing
- **SL:** ATR × atrMult + S/R + Fib refinement; capped at 15% (risk-engine); min 1× ATR when `featureMinSlDistance`
- **TP:** TP1/TP2/TP3 at 40%/30%/30% of position; R-multiples per strategy
- **Trailing TP mode:** `tpMode: 'trailing'` — trail from max/min by `trailingTpDistance` (ATR × mult or fixed %)
- **Standard trailing:** Activates at 1.5R; trails 1.5R behind max favorable price
- **Breakeven:** At 0.75R, move SL to entry + 0.3% buffer
- **Lock-in:** 0.5R at 50% progress, 0.75R at 75%, 1R at 90%

### 2.5 Feature Toggles (User.settings)
- `featureBtcFilter`, `featureBtcCorrelation`, `featureSessionFilter`
- `featurePartialTP`, `featureLockIn`, `featureScoreRecheck`
- `featureSlCap`, `featureMinSlDistance`, `featureConfidenceSizing`, `featureKellySizing`
- `autoMoveBreakeven`, `autoTrailingStop`
- `featureThemeDetector`, `featurePriceActionConfluence`, `featureVolatilityFilter`, `featureVolumeConfirmation`, `featureFundingRateFilter`

---

## 3. Setups (SMC)

### 3.1 Flow
```
smc-scanner.scanCoinForSetups → scenario-checks.evaluateScenario → scenario-definitions
smc-backtest.runSetupBacktest → evaluateScenario + ATR-based SL/TP
```

### 3.2 Logic
- **Scenarios:** fvg_liquidity_long/short, accumulation_long, distribution_short, fvg_gap_long/short, etc.
- **Phases:** Each scenario has phases; `shortVersion` defines minimal phases for entry
- **HTF bias:** 4H structure shift blocks setups against trend (LONG when 4H BEAR, SHORT when 4H BULL)
- **SL/TP:** SL = 2× ATR, TP = 4× ATR (2:1 RR); `riskDist = max(atr * 2, entry * 0.005)`

### 3.3 Auto-Trade Integration
- `evaluateSetupsForAutoTrade` returns signals with `_bestStrat` containing entry, SL, TP1/2/3
- Score = 60 + scenario score (so setups score 60+)
- Uses same ATR-based levels as scanner

---

## 4. Trench Warfare (Memecoin Scalping)

### 4.1 Flow
```
trench-auto-trading → DexScreener + Mobula → scoreCandidate → paper buy/sell or auto bot
```

### 4.2 Logic
- **Modes:** memecoin (pump-start, 1–3% TP, 2% SL) vs scalping (5m signals, 8–12% TP, 8% SL)
- **Scoring:** change5m/1h, volume velocity, buy pressure, buyer surge, liquidity, holder count
- **Rejects:** change >500, change <-25, vol <25k, liq <50k, parabolic (>60% changeShort)
- **Models:** ScalpTrade (separate from main Trade)

### 4.3 Isolation
- Completely separate from main trading: different models, APIs, scoring, SL/TP logic
- No shared engines with main/backtest

---

## 5. Strategy Builder

### 5.1 Flow
```
rule-engine.evaluateBar → lib/indicators.js → run-custom-backtest
```

### 5.2 Logic
- **Indicators:** lib/indicators.js (SMA, EMA, RSI, MACD, Bollinger, Stochastic, ATR) — standalone from trading-engine
- **Rules:** BUY/SELL/HOLD from indicator rules (crossover, threshold, etc.)
- **SL/TP:** 2× ATR SL, 3× ATR TP (different from main 2:1)

### 5.3 Auto-Trade Integration
- `evaluateStrategyForAutoTrade` returns signals when `autoTradeSignalMode === 'indicators'`
- Uses StrategyConfig entry/exit rules; does NOT use SignalEngine/RiskEngine
- **LONG only:** Currently checks `result.signal !== 'BUY'` — no SHORT support. Rule engine may emit SELL; add handling if needed.

---

## 6. Backtests

### 6.1 Main Backtest
- **File:** `services/backtest/run-backtest.js`
- **Engines:** SignalEngine, RiskEngine, ManageEngine (same as live)
- **Data:** sliceCandlesAt, buildSnapshot, execution-simulator
- **Features:** Aligned with user settings via `ft` object (btcFilter, sessionFilter, partialTP, breakeven, trailingStop, lockIn, scoreRecheck, etc.)

### 6.2 SMC Backtest
- **File:** `services/smc-backtest.js`
- **Logic:** evaluateScenario, ATR SL/TP, HTF bias gate
- **Exit:** nextBar open; SL/TP checked on nextBar low/high

### 6.3 Strategy Builder Backtest
- **File:** `services/strategy-builder/run-custom-backtest.js`
- **Logic:** rule-engine.evaluateBar, lib/indicators
- **Different path:** No SignalEngine; custom ATR SL/TP

---

## 7. Bugs & Edge Cases Found

### 7.1 BUG FIXED: Cooldown `closedAt` vs `exitTime`
- **Location:** `voting-app.js` lines 3635, 3866
- **Issue:** Cooldown query used `closedAt` but Trade model has `exitTime` only
- **Impact:** Cooldown never matched any trades → cooldownSet always empty → cooldown never enforced
- **Fix:** Changed `closedAt` to `exitTime` in both runAutoTrade and recheckTradeScores

### 7.2 Risk Engine: `indicators.atr` May Be Undefined
- **Location:** `services/engines/risk-engine.js` line 134
- **Code:** `const atr = decision.indicators?.atr;` then `if (ff.minSlDistance !== false && atr > 0)`
- **Edge case:** Strategy Builder and SMC setup signals may not pass `indicators.atr` in the same format. If `atr` is undefined, the minSlDistance block is skipped (safe). If Strategy Builder auto-trade passes a different structure, verify `indicators` is populated.

### 7.3 Paper-Trading vs Manage-Engine Duplication
- **Location:** `paper-trading.js` `_checkStopsAndTPsInner` vs `manage-engine.js`
- **Status:** Paper-trading has its own BE/TS/lock-in logic; manage-engine is used by backtest. Both should stay in sync. Constants (BE_R_MULT=0.75, TRAILING_START_R=1.5, TRAILING_DIST_R=1.5) are duplicated — consider single source.

### 7.4 Backtest: `!decision.takeProfit1` When Trailing TP
- **Location:** `run-backtest.js` line 346
- **Code:** `if (!ft.trailingTp && !decision.takeProfit1) continue;`
- **Logic:** When `ft.trailingTp` is true, TP1 can be null (trailing mode). Correct — skips the TP1 check when trailing. Verify `ft.trailingTp` is passed from backtest UI.

### 7.5 SMC Scanner: TP2/TP3 Multipliers
- **Location:** `smc-scanner.js` lines 74–80
- **Code:** `tp2 = entryPrice + rewardDist * 1.2; tp3 = entryPrice + rewardDist * 1.5`
- **Note:** SMC backtest uses single TP at 4× ATR. Scanner uses TP1/2/3 at 1×, 1.2×, 1.5× rewardDist. Consistent for scanner display; backtest is simpler (one TP).

### 7.6 Strategy Builder vs Main: Different ATR Sources
- **Main:** trading-engine `ATR_OHLC` (1h tf1h.atr)
- **Strategy Builder:** lib/indicators ATR (standalone)
- **Impact:** Slight numerical differences possible; not a bug but worth noting for consistency.

### 7.7 Manage-Engine: `getCurrentLockR` for SHORT
- **Location:** `manage-engine.js` lines 45–52
- **Code:** `const dist = isLong ? (trade.stopLoss || 0) - trade.entryPrice : trade.entryPrice - (trade.stopLoss || 0);`
- **Logic:** For SHORT, SL is above entry; `entryPrice - stopLoss` is negative. Then `dist / risk` — risk for SHORT is `stopLoss - entry` (positive). So `currentLockR` = negative dist / positive risk = negative. The lock-in loop checks `currentLockR < level.lockR` (e.g. 0.5). Negative < 0.5 is true, so it could fire too early. **Verify:** For SHORT, lockR should measure how far SL has moved in our favor. When SL is above entry (SHORT), moving SL down = locking profit. The `getLockInStopPrice` for SHORT returns `entry - risk * lockR`. So we want to move SL from (entry + risk) down toward entry. The `currentLockR` for SHORT: `(entry - stopLoss) / risk`. When SL = entry + risk (original), that's -1. When we lock in 0.5R, new SL = entry - 0.5*risk. So `currentLockR` = (entry - (entry - 0.5*risk)) / risk = 0.5. The formula `entryPrice - stopLoss` for SHORT: original SL = entry + risk, so entry - (entry+risk) = -risk, dist = -risk, currentLockR = -1. As we lock in, SL moves down: entry - 0.5*risk gives dist = entry - (entry - 0.5*risk) = 0.5*risk, currentLockR = 0.5. So the sign is correct: we want currentLockR to go from -1 (initial) toward positive as we lock in. The check `currentLockR < level.lockR` means we haven't locked that much yet. For SHORT with SL at entry+risk, currentLockR = -1, and -1 < 0.5, so we'd try to lock. getLockInStopPrice(0.5R) = entry - 0.5*risk. For SHORT, validMove is `newStop < trade.stopLoss && newStop > currentPrice`. We're in profit when price dropped, so currentPrice < entry. newStop = entry - 0.5*risk. For SHORT in profit, we want SL below current price (so we're not stopped yet). So newStop > currentPrice means entry - 0.5*risk > currentPrice, i.e. we're at least 0.5R in profit. Good. And newStop < trade.stopLoss (entry+risk) is true. So logic is correct.

### 7.8 Trench: `vol1h` Fallback in scoreCandidate
- **Location:** `trench-auto-trading.js` lines 159–164
- **Code:** `volShort = vol5m > 0 ? vol5m : vol1h`; `buyVolShort = vol5m > 0 ? buyVol5m : buyVol1h`
- **Edge case:** If both vol5m and vol1h are 0, buyDominance can be NaN. Check: `volShort > 0 ? buyVolShort / volShort : (vol1h > 0 ? buyVol1h / vol1h : buyPressure)` — safe fallback to buyPressure.

---

## 8. Wiring Verification

| Path | Status |
|------|--------|
| Main signal → paper-trading | ✅ SignalEngine → RiskEngine → openTrade |
| Main signal → backtest | ✅ Same engines, runBacktestForCoin |
| Paper-trading → checkStopsAndTPs | ✅ Uses own BE/TS/lock-in (not manage-engine in production) |
| Backtest → manage-engine | ✅ manageUpdate for BE/TS/lock-in/TP/SL |
| SMC scan → Setups page | ✅ scanMarketForSetups |
| SMC → auto-trade | ✅ evaluateSetupsForAutoTrade, _bestStrat levels |
| Strategy Builder → auto-trade | ✅ evaluateStrategyForAutoTrade when signalMode=indicators |
| Trench | ✅ Isolated, ScalpTrade model |

---

## 9. Math Verification

### 9.1 Position Sizing
- `positionSize = (riskAmount / stopDistance) * leverage`
- `stopDistance = |entry - stopLoss| / entry`
- Correct for both LONG and SHORT (absolute distance).

### 9.2 PnL
- LONG: `((exit - entry) / entry) * size`
- SHORT: `((entry - exit) / entry) * size`
- Correct.

### 9.3 Slippage
- LONG entry: pay more → `entry * (1 + slippage)`
- SHORT entry: receive less → `entry / (1 + slippage)`
- LONG exit: receive less → `exit / slippage`
- SHORT exit: pay more → `exit * slippage`
- Consistent across paper-trading, backtest, SMC backtest.

### 9.4 ATR
- `ATR_OHLC`: TR = max(H-L, |H-prevC|, |L-prevC|); ATR = SMA(TR, period)
- Standard Wilder ATR. Correct.

---

## 10. Recommendations

1. **Single source for BE/TS constants:** Extract from manage-engine or paper-trading into a shared module to avoid drift.
2. **Backtest features ↔ user settings:** Ensure backtest UI passes all `ft` flags from user settings for parity.
3. **Strategy Builder auto-trade:** Verify `indicators.atr` is passed when Strategy Builder signals feed RiskEngine (if they do).
4. **Add `exitTime` to Trade index:** If cooldown queries are frequent, index `{ userId: 1, status: 1, exitTime: -1 }` for closed trades.
5. **Trench vs main:** Document that Trench is a separate system; no shared engines.
