# Sections Audit: Math, Wiring & Display

**Date:** 2026-03-05  
**Scope:** Backtest, Backtest Results, Trench Warfare, Setups, Performance, History, Dashboard, Analytics

---

## Summary

| Page | Sections Audited | Issues Found | Fixed |
|------|-----------------|--------------|-------|
| Backtest | Summary, equity curve, per-coin, trades, regime | 0 | — |
| Backtest Results | Top 10, All Coins, Strategy breakdown | 1 | ✓ |
| Trench Warfare | Open Positions, Trade History, Analytics | 1 | ✓ |
| Setups | Setup list, backtest modal, scan | 0 | — |
| Performance | Metrics, equity curve, drawdown | 0 | — |
| History | Trade table, P&L breakdown | 0 | — |
| Dashboard | Summary bar, Top 3, signal cards | 0 | — |
| Analytics | Correlation, regime, Monte Carlo | 0 | — |

---

## Fixes Applied

### 1. Backtest Results — Return % fallback

**Issue:** Fallback used `r.totalPnl/100`, which only equals Return % when `initialBalance = 10000`.

**Fix:**
- Added `returnPct` to `top10` when saving in `backtest-massive.js`
- Added `initialBalance` to saved result
- Fallback: `(r.totalPnl / (result.initialBalance || 10000)) * 100`

**Files:** `views/backtest-results.ejs`, `scripts/backtest-massive.js`

### 2. Trench Warfare — Live position PnL (USD vs SOL)

**Issue:** For live positions, `amountIn` is SOL but `currentValue` is USD. `pnl = currentValue - amountIn` mixed units.

**Fix:**
- Fetch SOL price via `getCurrentPrice('solana')` when any live positions exist
- For live: `costUsd = amountIn * solPrice`; `pnl = currentValue - costUsd`
- Return `costUsd` for display (Cost column shows USD when available)
- Frontend uses `costUsd` for Cost display when present

**Files:** `voting-app.js` (positions API), `views/trench-warfare.ejs` (Cost display)

---

## Verified Correct

- **Backtest:** `returnPct = (totalPnl / totalCapital) * 100`; win rate, PF, equity curve
- **Setups:** `totalPnlPercent`, `winRate`, `maxDrawdownPct` from SMC backtest
- **Performance:** `totalPnlPercent = (totalPnl / initialBalance) * 100`
- **History:** `trade.pnl`, `trade.pnlPercent` from DB
- **Dashboard:** Signal counts, Top 3 pass-through
- **Analytics:** Correlation, regime %, Monte Carlo pass-through
