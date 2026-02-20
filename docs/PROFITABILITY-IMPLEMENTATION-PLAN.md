# Profitability Implementation Plan

A phased plan to implement all identified improvements for CryptoSignals Pro.

---

## Phase 1: Critical Fixes (Week 1)

**Goal:** Fix bugs that cause incorrect behavior or prevent accurate backtesting.

### 1.1 Strategy ID Unification
- **Files:** `services/learning-engine.js`, `services/trading-engine.js`, `models/StrategyWeight.js`, any DB migration
- **Tasks:**
  1. Audit all references to `mean_revert` vs `mean_reversion`
  2. Standardize on `mean_revert` everywhere
  3. Add migration script to update existing StrategyWeight documents
  4. Update DEFAULT_STRATEGIES in learning-engine
- **Validation:** Run backtest, verify Mean Reversion trades appear in strategy breakdown

### 1.2 Min R:R Filter in Backtest
- **Files:** `services/backtest/run-backtest.js`, `views/backtest.ejs`, `voting-app.js`
- **Tasks:**
  1. Add `minRiskReward` and `minRiskRewardEnabled` to backtest options
  2. In run-backtest loop, before opening trade: if enabled and `decision.riskReward < minRr`, skip
  3. Add UI inputs on backtest page for min R:R toggle and value
  4. Pass from API to runBacktest
- **Validation:** Backtest with min R:R 1.5 ON vs OFF; fewer trades when ON

### 1.3 Quality Filters in Backtest
- **Files:** `services/backtest/run-backtest.js`, `views/backtest.ejs`
- **Tasks:**
  1. Add `priceActionConfluence`, `volatilityFilter`, `volumeConfirmation` to backtest features
  2. Pass to `options_bt` in run-backtest (already passed to trading engine)
  3. Add checkboxes on backtest page
  4. Map to Performance page preset load/save
- **Validation:** Backtest with all 3 ON; fewer trades, potentially higher win rate

---

## Phase 2: Risk Controls (Week 2)

**Goal:** Add safety mechanisms to limit drawdowns and protect capital.

### 2.1 Max Daily Loss Kill Switch
- **Files:** `services/paper-trading.js`, `services/backtest/run-backtest.js`, `models/User.js`, `views/performance.ejs`
- **Tasks:**
  1. Add `maxDailyLossPercent` (default 0 = off) to User.settings
  2. In paper-trading.openTrade: compute today's PnL from closed trades; if < -maxDailyLossPercent of start-of-day balance, reject
  3. In backtest: track daily equity; if day's loss exceeds threshold, set killSwitch, skip new trades until next day
  4. Add UI slider (0–20%, 0 = disabled)
- **Validation:** Backtest with 5% max daily loss; trades stop when day hits -5%

### 2.2 Drawdown-Based Position Sizing
- **Files:** `services/engines/risk-engine.js`, `services/paper-trading.js`, `services/backtest/run-backtest.js`
- **Tasks:**
  1. Add `drawdownSizingEnabled` and `drawdownThresholdPercent` to User.settings
  2. In risk-engine.plan: accept `peakEquity` in context; if `balance < peakEquity * (1 - threshold/100)`, apply multiplier (e.g. 0.5x)
  3. Paper-trading: track peak balance per user (or from stats)
  4. Backtest: track peak equity in loop, pass to plan
- **Validation:** Backtest; after 10% drawdown, position sizes halved

### 2.3 Minimum Volume Filter
- **Files:** `services/crypto-api.js`, `voting-app.js`, `services/paper-trading.js`, `services/backtest/run-backtest.js`
- **Tasks:**
  1. Add `minVolume24hUsd` (default 0 = off) to User.settings
  2. In signals flow: filter out coins where `coinData.volume24h < minVolume24hUsd`
  3. In backtest: coinData has volume24h from API or 0; skip coin if below threshold
  4. Add UI input (e.g. $10M, $50M, $100M presets)
- **Validation:** With $50M min, low-volume coins excluded from signals

---

## Phase 3: Filters & Rules (Week 3)

**Goal:** Add filters that improve signal quality and reduce bad trades.

### 3.1 Correlation Filter
- **Files:** `services/crypto-api.js` or new `services/correlation-service.js`, `voting-app.js`, `services/paper-trading.js`
- **Tasks:**
  1. Add `correlationFilterEnabled` and `maxCorrelationBetweenTrades` (e.g. 0.85)
  2. When opening trade: fetch correlation matrix (or use rolling correlation from price history) between new coin and all open-trade coins
  3. If any correlation > threshold, skip (or rank lower)
  4. Option: cache correlations per pair, refresh daily
- **Validation:** With 0.85 max, cannot open ETH + MATIC simultaneously if correlated > 0.85

### 3.2 Expectancy Filter
- **Files:** `services/engines/risk-engine.js`, `voting-app.js`, `services/paper-trading.js`
- **Tasks:**
  1. Add `expectancyFilterEnabled` and `minExpectancy` (e.g. 0.15)
  2. In plan or before open: lookup strategyStats[decision.strategy]; compute expectancy = (winRate * avgRR) - (1 - winRate)
  3. If expectancy < minExpectancy and strategy has >= 10 trades, reject
  4. Backtest: use options.strategyStats
- **Validation:** Strategies with negative expectancy blocked

### 3.3 Regime–Strategy Hard Block
- **Files:** `services/trading-engine.js`, `services/engines/signal-engine.js`
- **Tasks:**
  1. Define block matrix: e.g. mean_revert blocked in trending, breakout blocked in ranging
  2. In pickStrategy or evaluate: if regime matches block, set strategy score to 0 or exclude
  3. Add to ENGINE_CONFIG
- **Validation:** No Mean Reversion signals in trending regime

### 3.4 Score Recheck Interval Alignment
- **Files:** `services/paper-trading.js`, `services/backtest/run-backtest.js`, `models/User.js`
- **Tasks:**
  1. Add `scoreRecheckIntervalMinutes` to User.settings (default 60)
  2. Paper-trading: use this for recheck cadence instead of hardcoded SCORE_RECHECK_MINUTES
  3. Backtest: convert to bars (e.g. 60 min = 1 bar for 1h); ensure SCORE_RECHECK_INTERVAL matches
  4. Document in EDGE_CASES.md
- **Validation:** Live and backtest recheck at same logical frequency

---

## Phase 4: Logic & Risk Tuning (Week 4)

**Goal:** Make risk parameters configurable and smarter.

### 4.1 ATR-Based Trailing Distance
- **Files:** `services/engines/manage-engine.js`, `services/paper-trading.js`, `models/User.js`
- **Tasks:**
  1. Add `trailingStopMode`: 'fixed_r' | 'atr_multiple'
  2. If atr_multiple: use `trade.indicators?.atr * userSettings.trailingStopAtrMult` (default 2)
  3. Store ATR at entry in trade; use for trailing calc
  4. Backtest: pass indicators to position, use in manageUpdate
- **Validation:** In high vol, trailing distance widens

### 4.2 Configurable Lock-In Levels
- **Files:** `services/engines/manage-engine.js`, `models/User.js`, `views/performance.ejs`
- **Tasks:**
  1. Add `lockInLevels` to User.settings: array of { progress, lockR } (default current 0.5/0.5, 0.75/0.75, 0.9/1)
  2. Manage-engine reads from opts.userSettings?.lockInLevels || LOCK_IN_LEVELS
  3. UI: 3 rows, editable progress % and lock R
- **Validation:** Custom levels applied in backtest

### 4.3 Configurable TP Split
- **Files:** `services/engines/manage-engine.js`, `services/paper-trading.js`, `models/User.js`
- **Tasks:**
  1. Add `tp1Percent`, `tp2Percent`, `tp3Percent` (default 40, 30, 30; must sum to 100)
  2. Replace TP1_PCT, TP2_PCT, TP3_PCT constants with user values
  3. Risk-engine and paper-trading use same source
  4. UI: 3 inputs with validation
- **Validation:** 50/30/20 split produces correct portion sizes

### 4.4 Breakeven Buffer Adjustment
- **Files:** `services/engines/manage-engine.js`, `models/User.js`
- **Tasks:**
  1. Add `breakevenBufferPercent` (default 0.3)
  2. Replace BE_BUFFER (0.003) with user value
  3. UI: 0.2–1.0% slider
- **Validation:** Larger buffer = BE further above entry

### 4.5 Leverage Cap by Regime
- **Files:** `services/engines/risk-engine.js`
- **Tasks:**
  1. Add `maxLeverageByRegime`: e.g. { extreme: 1, high: 2, normal: default }
  2. In suggestLeverage: apply regime cap after score-based calc
  3. Document in EDGE_CASES.md
- **Validation:** In extreme vol, max leverage = 1

---

## Phase 5: Strategy & Data Expansion (Weeks 5–6)

**Goal:** Add 15m candles, scalping, swing, multi-strategy view.

### 5.1 Add 15m Candles
- **Files:** `services/crypto-api.js`, `services/backtest/market-data.js`, `services/backtest.js`
- **Tasks:**
  1. Add 15m to fetchHistoricalCandlesForCoin, fetchAllCandlesForCoin
  2. In market-data.sliceCandlesAt: support 15m
  3. Trading engine already has scores15m; ensure candles['15m'] is passed
  4. Backtest: fetch and pass 15m in options.candles
- **Validation:** 15m data present in /api/candles response

### 5.2 Scalping Strategy Wiring
- **Files:** `services/trading-engine.js`, `services/learning-engine.js`, `models/StrategyWeight.js`
- **Tasks:**
  1. Ensure scalping uses 15m + 1h (stratDirMap already has it)
  2. Add scalping to DEFAULT_STRATEGIES if missing
  3. Regime gating: scalping favored in volatile, compression
  4. Verify pickStrategy includes scalping
- **Validation:** Scalping signals appear when 15m + 1h align

### 5.3 Swing Strategy Wiring
- **Files:** Same as 5.2
- **Tasks:**
  1. Swing uses 4h + 1d (already in stratDirMap)
  2. Add to DEFAULT_STRATEGIES, pickStrategy
  3. Regime gating: swing favored in trending, compression
- **Validation:** Swing signals on 4h/1d confluence

### 5.4 Multi-Strategy View
- **Files:** `views/dashboard.ejs`, `views/coin-detail.ejs`, `voting-app.js`
- **Tasks:**
  1. API: return top 2–3 strategies per coin with score, signal, levels
  2. Dashboard: show "Trend: BUY 72 | Swing: HOLD 58 | Scalping: SELL 45"
  3. Coin detail: tabs or dropdown to switch strategy view
  4. Trade open: user picks which strategy's levels to use
- **Validation:** UI shows multiple strategies per coin

### 5.5 Add 1W Candles (Optional)
- **Files:** `services/crypto-api.js`, `services/backtest/run-backtest.js`, `services/trading-engine.js`
- **Tasks:**
  1. Fetch 1w where API supports it
  2. Add to candles object, sliceCandlesAt
  3. Position strategy uses 1d + 1w
- **Validation:** 1w data in API response

---

## Phase 6: Execution & Data (Week 7)

**Goal:** Smarter execution and data usage.

### 6.1 Slippage by Coin
- **Files:** `services/backtest/execution-simulator.js`, `services/engines/risk-engine.js`, config
- **Tasks:**
  1. Define SLIPPAGE_BPS by coin tier: majors (BTC, ETH) = 5, mid = 10, small = 20
  2. Execution-simulator: accept coinId, lookup tier
  3. Risk-engine: pass coinId for entry slippage
  4. Paper-trading: use same lookup
- **Validation:** Backtest with mixed coins; small caps have higher slippage

### 6.2 Funding Rate in Entry
- **Files:** `services/trading-engine.js`, `voting-app.js`
- **Tasks:**
  1. Add `fundingRateFilterEnabled`: if funding > 0.1% and LONG, or < -0.1% and SHORT, hard HOLD
  2. Already in scoring; add as optional gate
  3. UI toggle
- **Validation:** Extreme funding blocks counter-direction trades

### 6.3 Order Book Depth (Optional)
- **Files:** New `services/orderbook-service.js`, Bitget integration
- **Tasks:**
  1. Fetch order book for coin
  2. Compute spread, depth at 1%
  3. If spread > threshold or depth too thin, skip
  4. Requires exchange API
- **Validation:** Low liquidity coins skipped when enabled

---

## Phase 7: Backtest & Tuning (Week 8)

**Goal:** Better backtest tooling and parameter optimization.

### 7.1 Extended Parameter Sweep
- **Files:** `scripts/backtest-sweep.js`, new `scripts/backtest-optimize.js`
- **Tasks:**
  1. Add minScore, minRiskReward, cooldown, slCap to sweep matrix
  2. Output: best combo by Sharpe, profit factor, win rate
  3. Optional: grid search with early stopping
- **Validation:** Script finds better params than baseline

### 7.2 Walk-Forward Analysis
- **Files:** New `scripts/walk-forward.js`
- **Tasks:**
  1. Split history: train 70%, test 30% (or rolling windows)
  2. Run backtest on train, extract best params
  3. Run backtest on test with those params
  4. Compare to in-sample to detect overfitting
- **Validation:** Out-of-sample results reported

---

## Phase 8: UX & Monitoring (Week 9)

**Goal:** Dashboards and visibility.

### 8.1 Strategy Performance Dashboard
- **Files:** New `views/strategy-performance.ejs`, `voting-app.js`
- **Tasks:**
  1. Query closed trades by strategy
  2. Compute: win rate, avg R, expectancy, trades per regime
  3. Chart: equity by strategy overlay
  4. Link from Performance page
- **Validation:** Page shows per-strategy stats

### 8.2 Regime Distribution
- **Files:** `views/dashboard.ejs` or analytics
- **Tasks:**
  1. Store regime at signal time (or from last analysis)
  2. Aggregate: % of time in trending, ranging, etc.
  3. Display pie chart or bar
- **Validation:** Regime breakdown visible

### 8.3 Trade Journal Rules Tracking
- **Files:** `models/Journal.js`, `views/journal.ejs`, `voting-app.js`
- **Tasks:**
  1. Add `followedRules` boolean to journal entries (already exists per grep)
  2. Add `rulesFollowed` array: e.g. ["waited for confluence", "respected SL"]
  3. Analytics: correlation between followedRules and trade outcome
  4. UI: checkbox + tags when logging
- **Validation:** Can filter journal by "followed rules" and see win rate

---

## Implementation Order Summary

| Phase | Focus | Duration |
|-------|-------|----------|
| 1 | Critical fixes (ID, Min R:R, quality filters) | Week 1 |
| 2 | Risk controls (daily loss, drawdown sizing, volume) | Week 2 |
| 3 | Filters (correlation, expectancy, regime block, recheck) | Week 3 |
| 4 | Logic tuning (ATR trail, lock-in, TP split, BE buffer, leverage) | Week 4 |
| 5 | Strategy expansion (15m, scalping, swing, multi-view, 1w) | Weeks 5–6 |
| 6 | Execution (slippage, funding filter, order book) | Week 7 |
| 7 | Backtest tooling (sweep, walk-forward) | Week 8 |
| 8 | UX (strategy dashboard, regime, journal rules) | Week 9 |

---

## Dependencies

- Phase 2 depends on Phase 1 (backtest must support new options)
- Phase 3 filters can run in parallel with Phase 4
- Phase 5.1 (15m) is prerequisite for 5.2 (scalping)
- Phase 7 can start after Phase 1–2

---

## Testing Checklist (Per Phase)

- [ ] Unit tests for new risk-engine logic
- [ ] Backtest runs without error with new options
- [ ] Paper trade flow rejects/accepts correctly
- [ ] Auto-trade respects new filters
- [ ] Performance page saves/loads new settings
- [ ] EDGE_CASES.md updated

---

## Rollback Plan

- Each phase in its own branch/PR
- Feature flags for new filters (default OFF)
- DB migrations reversible where possible
