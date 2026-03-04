# Backtest Logic & Math Audit

**Date:** 2026-03-04  
**Scope:** Position sizing, risk mode, PnL, fees, return %, capital aggregation

---

## 1. Risk Mode (Percent vs Dollar)

### 1.1 Data Flow

| Step | Location | Behavior |
|------|----------|----------|
| Form | `views/backtest.ejs` | Sends `riskMode`, `riskPerTrade`, `riskDollarsPerTrade` in JSON body |
| API | `voting-app.js` ~3346 | Builds options: `riskMode`, `riskPerTrade`, `riskDollarsPerTrade` from `req.body` |
| Orchestrator | `services/backtest.js` | Passes options to `runBacktestForCoin` |
| Per-coin | `services/backtest/run-backtest.js` | Reads options, passes to `plan()` via `userSettings` |
| Risk engine | `services/engines/risk-engine.js` | `calculatePositionSize()` uses `riskDollarsPerTrade` when `riskMode === 'dollar'` |

### 1.2 Position Sizing Formula

```
riskAmount = riskMode === 'dollar' && riskDollarsPerTrade > 0
  ? riskDollarsPerTrade
  : balance * (riskPercent / 100)

positionSize = (riskAmount / stopDistance) * leverage
capped = min(positionSize, balance * leverage * 0.95)
```

- **Percent mode:** `riskAmount = balance × 0.02` (2% default)
- **Dollar mode:** `riskAmount = riskDollarsPerTrade` (e.g. $1000)

### 1.3 Verification

- Unit test `risk-engine.test.js`: dollar mode with $50 risk produces smaller size than 2% mode.
- With $10k balance, 2% = $200 risk; $1000 fixed = 5× larger positions.
- Return % is always `(totalPnl / totalCapital) × 100` — based on account, not risk capital.

---

## 2. PnL & Fees

### 2.1 Per-Trade PnL

```
rawPnl = direction === 'LONG'
  ? ((exitPrice - entry) / entry) * size
  : ((entry - exitPrice) / entry) * size

totalPnl = rawPnl - entryFees - exitFees
```

- Entry fees: `size × TAKER_FEE` (0.1%)
- Exit fees: same
- Slippage: applied to entry (LONG pays more) and exit (LONG receives less)

### 2.2 Partial TPs

- TP1/TP2: portion of size closed; PnL prorated; fees deducted.
- Equity updated after each partial; remaining size tracked.

---

## 3. Return % & Capital Aggregation

### 3.1 Single-Coin

```
returnPct = (totalPnl / initialBalance) × 100
```

### 3.2 Multi-Coin

Each coin runs with its own `initialBalance`. Per-coin runs are independent.

```
totalCapital = coinsProcessed × initialBalance
returnPct = (totalPnl / totalCapital) × 100
```

- `totalPnl` = sum of all per-coin PnL.
- `totalCapital` = aggregate starting capital (e.g. 3 coins × $10k = $30k).

---

## 4. Equity Curve

- Built from trades sorted by exit time.
- Start: `equity = totalCapital`.
- After each trade: `equity += trade.pnl`.
- Max drawdown: peak-to-trough from this curve.

---

## 5. Edge Cases & Safeguards

| Case | Handling |
|------|----------|
| `riskMode === 'dollar'` but `riskDollarsPerTrade` invalid | Falls back to `balance * (riskPercent/100)` |
| Zero balance | `plan()` returns null; no new trades |
| Stop loss on wrong side | Corrected in risk-engine (LONG: SL < entry; SHORT: SL > entry) |
| SL distance > 15% | Capped at `MAX_SL_DISTANCE_PCT` |
| Position size > 95% of margin | Capped at `balance * leverage * 0.95` |

---

## 6. Recommendations

1. **Risk mode:** When `riskMode === 'dollar'`, ensure `riskDollarsPerTrade` is always > 0 before running; otherwise fallback to percent may surprise users.
2. **Return display:** Consider adding a tooltip: "Return % = (total PnL / initial balance) × 100".
3. **Dollar mode:** If user expects "return on risk capital," that's a different metric; add optional display if desired.

---

## 7. Files Verified

- `services/engines/risk-engine.js` — `calculatePositionSize`, `plan`
- `services/backtest/run-backtest.js` — `userSettings` for `plan`, equity updates
- `services/backtest/analytics.js` — `buildSummary`, `computeMaxDrawdown`, `computeMaxDrawdownPct`
- `services/backtest.js` — `runBacktest`, capital aggregation, `returnPct`
- `views/backtest.ejs` — form submission, `riskMode`, `riskDollarsPerTrade`
