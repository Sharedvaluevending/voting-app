# Edge Cases Documentation

Explicit documentation of edge cases for the trading engine scoring and risk logic.

## Scoring (Trading Engine)

**Location:** `services/trading-engine.js`

### Analysis Entry Points

| Condition | Behavior |
|-----------|----------|
| Candles with 20+ 1h bars | Uses `analyzeWithCandles` (full scoring) |
| No candles, history with 10+ prices | Uses `analyzeWithHistory` (simplified) |
| Neither | Uses `generateBasicSignal` (24h change only) |

### Score Modifiers (Applied After Base Score)

| Modifier | Value | Condition |
|----------|-------|-----------|
| MTF divergence | -10 | 1H and 4H disagree on direction |
| Session penalty | -5 | Outside 12–22 UTC |
| Divergence (RSI/MACD/OBV/Stoch) | ±4 to ±14 | Depends on confluence |
| Potential top/bottom | ±6 or -12 | Reversal signals |
| Funding rate | ±3 to ±8 | Contrarian to position |
| BTC correlation | up to -8 | Correlation > 0.7 and direction disagrees |
| POC proximity | +3 | Price within 0.5% of POC |
| **Penalty cap** | **25** | Total penalty cannot exceed 25 |

### Tie-Breaker

When `bullCount === bearCount`, direction uses 1D timeframe direction + score.

### BTC Filter

- **STRONG_SELL** on BTC → Alt LONG signals suppressed to HOLD
- **STRONG_BUY** on BTC → Alt SHORT signals suppressed to HOLD

### Valid Outputs

- **Signal:** STRONG_BUY, BUY, HOLD, SELL, STRONG_SELL
- **Regime:** trending, ranging, volatile, compression, mixed
- **Score:** 0–100 (clamped)

---

## Risk Engine

**Location:** `services/engines/risk-engine.js`

### Position Sizing (`calculatePositionSize`)

| Edge Case | Behavior |
|-----------|----------|
| Invalid/zero entry price | Returns `balance * 0.05 * leverage` |
| Zero or invalid stopLoss | Uses 2% stop distance fallback |
| stopDistance <= 0 | Uses 0.02 (2%) |
| Result not finite | Returns `balance * 0.1 * leverage` |
| **Cap** | `min(positionSize, balance * leverage * 0.95)` |

### Risk Modes

- **percent:** `riskAmount = balance * (riskPercent / 100)`
- **dollar:** `riskAmount = riskDollarsPerTrade` (when > 0)

### Stop Loss Validation (`plan`)

| Edge Case | Behavior |
|-----------|----------|
| SL distance > 15% | Capped to `MAX_SL_DISTANCE_PCT` (15%) |
| LONG with SL >= entry | SL set to `entry * 0.98` |
| SHORT with SL <= entry | SL set to `entry * 1.02` |
| SL < 1× ATR from entry | SL moved to `entry ± 1× ATR` (when minSlDistance enabled) |

### Leverage (`suggestLeverage`)

| Score | Max Leverage |
|-------|--------------|
| ≥85 | 10x |
| ≥75 | 7x |
| ≥65 | 5x |
| ≥55 | 3x |
| ≥45 | 2x |
| <45 | 1x |

**Reductions:**
- Ranging/mixed regime: ×0.6
- High/extreme volatility: ×0.5

### Streak Adjustment

| Streak | Position Multiplier |
|--------|---------------------|
| ≤ -3 | 0.6× |
| ≤ -2 | 0.75× |
| ≥ 3 | min(1.15, 1 + streak × 0.03) |

### Kelly Criterion

- Applied when strategy has ≥15 trades
- Blend: 70% risk-based + 30% Kelly
- **Negative Kelly (< -0.1):** 0.75× position

### Caps

- **Margin cap:** `maxBalancePercentPerTrade` (default 25%)
- **Balance cap:** `maxSpend / (1/leverage + makerFee)`
- **Fallback:** If position invalid, `balance * 0.02 * leverage`

### Plan Returns Null When

- `balance <= 0`
- `required > balance`
- No decision or missing `side`, `entry`, or `stopLoss`
