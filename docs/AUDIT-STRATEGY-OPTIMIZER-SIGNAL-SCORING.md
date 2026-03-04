# Audit: Strategy Optimizer Page & Signal/Scoring Consistency

**Date:** 2026-03-04  
**Scope:** Strategy Optimizer (Learning) page wiring, signal evaluation, scoring logic consistency across app

---

## 1. Strategy Optimizer Page (Learning)

### 1.1 Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /learning` | Public | Renders strategy performance, weights, regime breakdown |
| `POST /api/learning/optimize/:strategyId` | requireLogin | Runs weight optimization, optionally applies |

### 1.2 Data Flow

**GET /learning**
- `StrategyWeight.find({})` → all strategies
- Maps to: `id`, `name`, `winRate`, `avgRR`, `totalTrades`, `wins`, `losses`, `weights`, `byRegime`
- `userTradeCounts`: counts closed trades per strategy for logged-in user (uses `mean_reversion` → `mean_revert` alias)
- Renders: Strategy Performance table, Current Scoring Weights table, Performance by Regime table

**POST /api/learning/optimize/:strategyId**
- Fetches: `Trade.find({ userId, status: { $ne: 'OPEN' } })`, `StrategyWeight.findOne({ strategyId })`
- Calls: `optimizeWeights(strategyId, closedTrades, strategy.weights, { maxIterations: 30 })`
- On `apply === 'true'` and `result.improved`: `StrategyWeight.updateOne({ strategyId }, { $set: { weights: result.weights } })`
- Returns: `{ success, weights, fitness, baseFitness, improved, applied }`

### 1.3 Optimize Button Wiring

- **Visibility:** `userTradeCounts[s.id] >= 10` (user-specific)
- **Hint:** "X/10 trades" when 1–9 trades
- **Fetch:** `POST /api/learning/optimize/${sid}`, body `{ apply: 'true'|'false' }`
- **CSRF:** `document.getElementById('learning-csrf')?.value` — input `#learning-csrf` with `csrfToken` (from `res.locals.csrfToken` via middleware)
- **Error handling:** `if (!r.ok) throw new Error(data.error || 'Request failed')`

### 1.4 Strategy ID Consistency

- **DB/API:** `strategyId` (e.g. `trend_follow`, `mean_revert`)
- **Trades:** `strategyType` (may be legacy `mean_reversion`)
- **Alias:** `mean_reversion` → `mean_revert` in weight-optimizer, learning-engine, voting-app userTradeCounts

### 1.5 Verification

- [x] Optimize button shows only when user has 10+ closed trades for that strategy
- [x] Optimize API uses user's trades, not global
- [x] Weight optimizer uses `STRATEGY_ID_ALIASES` for `mean_reversion` → `mean_revert`
- [x] Weights display uses fallbacks for missing keys
- [x] CSRF token available via `#learning-csrf` (res.locals set by middleware)

---

## 2. Signal & Scoring Architecture

### 2.1 Single Source of Truth

| Component | Role |
|-----------|------|
| `trading-engine.analyzeCoin` | Core scoring and strategy selection |
| `signal-engine.evaluate` | Wraps analyzeCoin; normalizes to canonical decision |
| `buildEngineOptions` | Fetches StrategyWeight, builds strategyWeights + strategyStats |

**Consumers:** Dashboard, paper-trading, backtest, market-scanner, LLM agent, API /api/signals

### 2.2 Scoring Dimensions (6 categories)

| Dimension | Max Points | Used In |
|-----------|------------|---------|
| trend | 20 | All strategies |
| momentum | 20 | All strategies |
| volume | 20 | All strategies |
| structure | 20 | All strategies |
| volatility | 10 | All strategies |
| riskQuality | 10 | All strategies |

**Total raw:** 0–100 per timeframe. `scoreCandles()` in trading-engine.js produces these.

### 2.3 Weighted Strategy Score

```
displayScore = weightedScore(timeframeScores, strategyWeights)
```

- `weightedScore`: `(s.trend/20)*(w.trend/total) + ...` for each dimension
- Weights from: `StrategyWeight.weights` (DB) or `DEFAULT_WEIGHTS` (trading-engine fallback)
- Output: 0–100

### 2.4 Signal Mapping (scoreToSignal)

| adjScore | dominantDir | Signal |
|----------|-------------|--------|
| 45–54 | any | HOLD |
| ≥75 | BULL | STRONG_BUY |
| 55–74 | BULL | BUY |
| ≥75 | BEAR | STRONG_SELL |
| 55–74 | BEAR | SELL |
| else | NEUTRAL/other | HOLD |

**Confluence bonus:** +10 (3 TF agree), +5 (2 TF agree)

### 2.5 Quality Gates

- `MIN_SIGNAL_SCORE`: 52
- `MIN_CONFLUENCE_FOR_SIGNAL`: 2 (relaxed to 1 when score ≥ 58)
- Top/bottom protection: no BUY at potential top, no SELL at potential bottom

### 2.6 Regime Consistency

**Valid regimes:** `trending`, `ranging`, `volatile`, `compression`, `mixed`

Used identically in:
- trading-engine (detectRegime, REGIME_STRATEGY_BLOCK, REGIME_FIT_BONUS)
- learning-engine (byRegime, VALID_REGIMES)
- weight-optimizer (REGIME_DIM_MAP, byRegime filter)
- paper-trading, risk-engine, backtest

---

## 3. Strategy Weights Flow

```
StrategyWeight (DB) 
  → buildEngineOptions() 
  → options.strategyWeights, options.strategyStats 
  → analyzeCoin(options) 
  → pickStrategy(..., strategyWeights, strategyStats)
  → getWeights(stratId) = byId[stratId]?.weights || DEFAULT_WEIGHTS[stratId]
```

- **Learning init:** `initializeStrategies()` uses `DEFAULT_STRATEGIES` (learning-engine.js)
- **Trading fallback:** `DEFAULT_WEIGHTS` (trading-engine.js) when strategy not in strategyWeights
- **Note:** Learning and trading default weights differ slightly; DB init uses learning's. Once strategies exist in DB, trading uses DB weights.

---

## 4. Strategy IDs (Canonical)

| ID | Name |
|----|------|
| trend_follow | Trend Following |
| breakout | Breakout |
| mean_revert | Mean Reversion |
| momentum | Momentum |
| scalping | Scalping |
| swing | Swing |
| position | Position |

**Legacy alias:** `mean_reversion` → `mean_revert` (trades, optimizer, learning)

---

## 5. Backtest Consistency

- Uses `evaluate()` from signal-engine (same as live)
- Passes `strategyWeights`, `strategyStats` from options
- Regime from trading-engine's `detectRegime`
- Same scoreToSignal, quality gates, strategy selection

---

## 6. Potential Issues

| Issue | Severity | Notes |
|-------|----------|-------|
| Learning page doesn't explicitly pass csrfToken | Low | csrfToken comes from res.locals via middleware; should be present |
| learning DEFAULT_STRATEGIES ≠ trading DEFAULT_WEIGHTS | Low | Only matters if strategy missing from DB; init uses learning's |
| strategyStats uses totalTrades only | Info | Min 5 trades gate; regime win-rate adjustment in selectBestStrategy (learning) not in pickStrategy |

---

## 7. Summary

- **Strategy Optimizer:** Correctly wired; Optimize uses user trades, strategy ID alias applied, weights/CSRF/errors handled.
- **Signal/Scoring:** Single source (trading-engine → signal-engine); 6 dimensions, regime set, scoreToSignal consistent.
- **Weights:** DB → buildEngineOptions → trading engine; backtest and live use same path.
- **Regimes:** Consistent across trading, learning, optimizer, backtest.
