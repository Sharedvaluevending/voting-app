# Audit: Learning Page (Strategy Optimizer)

**Date:** 2026-03-04  
**Scope:** Learning page logic, Optimize button, data display, API wiring

---

## 1. Issues Found & Fixed

### 1.1 Optimize Button Logic (Critical)

**Problem:** The Optimize button appeared when `s.totalTrades >= 10`, but `totalTrades` comes from `StrategyWeight.performance` which aggregates **all users'** trades. The optimizer API uses only the **current user's** closed trades. Result: button could show when the user had 0 trades for that strategy, causing "Need 10+ trades for this strategy" error.

**Fix:** Added `userTradeCounts` to the GET `/learning` route — counts closed trades per strategy for the logged-in user. The Optimize button now shows only when `userTradeCounts[s.id] >= 10`. Added "X/10 trades" hint when user has 1–9 trades.

### 1.2 Strategy ID Alias in Weight Optimizer

**Problem:** Trades may store `strategyType: 'mean_reversion'` (legacy) while the DB uses `mean_revert`. The optimizer filtered `(t.strategyType || t.strategy) === strategyId`, so `mean_reversion` trades never matched `mean_revert` strategy.

**Fix:** Added `STRATEGY_ID_ALIASES = { mean_reversion: 'mean_revert' }` in `weight-optimizer.js` and used it when filtering trades.

### 1.3 Performance Object Initialization

**Problem:** `recordTradeOutcome` could fail if `strategy.performance` was undefined (e.g. from an upsert that didn't set performance). `initializeStrategies` did not set `performance` on insert.

**Fix:** Added defensive checks in `recordTradeOutcome`, and `$setOnInsert: { performance: defaultPerformance }` in `initializeStrategies`.

### 1.4 Weights Display Fallback

**Problem:** If `s.weights` or any weight key was missing, the view could show `undefined` or throw.

**Fix:** Route now passes `weights: s.weights || {}`. View uses `(s.weights && s.weights.trend) != null ? s.weights.trend : '-'` for each column.

### 1.5 CSRF Token

**Problem:** The Optimize fetch used `meta[name="csrf-token"]` which does not exist on the learning page.

**Fix:** Added hidden input `#learning-csrf` with `csrfToken` value. Fetch now uses `document.getElementById('learning-csrf')?.value || document.querySelector('input[name="_csrf"]')?.value || ''`. (Note: API routes are CSRF-exempt, but having the token is consistent.)

### 1.6 Error Handling

**Problem:** Non-2xx responses (e.g. 401, 500) were not handled; the user could see a generic "Request failed" or a parse error.

**Fix:** Added `if (!r.ok) throw new Error(data.error || 'Request failed')` before processing, so server error messages are surfaced to the user.

---

## 2. Data Flow

| Component | Data Source | Notes |
|-----------|-------------|-------|
| Strategy Performance table | `StrategyWeight.performance` | Global (all users) |
| Strategy Weights table | `StrategyWeight.weights` | Global |
| Regime Breakdown | `StrategyWeight.performance.byRegime` | Global |
| Optimize button visibility | `userTradeCounts` | User-specific |
| Optimize API | `Trade.find({ userId })` | User-specific |

---

## 3. Files Modified

- `voting-app.js` — GET `/learning`: added `userTradeCounts`, `weights: s.weights || {}`
- `views/learning.ejs` — Optimize button logic, weights fallbacks, CSRF input, error handling
- `services/weight-optimizer.js` — `STRATEGY_ID_ALIASES`, trade filter
- `services/learning-engine.js` — `recordTradeOutcome` performance init, `initializeStrategies` performance on insert

---

## 4. Verification Checklist

- [ ] Optimize button shows only when user has 10+ closed trades for that strategy
- [ ] "X/10 trades" appears when user has 1–9 trades
- [ ] Optimize runs successfully when user has 10+ trades
- [ ] Mean Reversion trades (if any use `mean_reversion`) are correctly counted
- [ ] Weights display correctly even when some keys are missing
- [ ] Error messages from API are shown to the user
