# Analytics Page Sections Audit

**Date:** 2026-03-05  
**Scope:** Advanced Analytics page — Correlation Matrix, Regime Timeline, Monte Carlo, Drawdown Analysis, Risk Metrics by Strategy & Regime

---

## 1. Correlation Matrix

**Data source:** `computeCorrelationMatrix(allCandles)` in `services/analytics.js`  
**Input:** `fetchAllCandles()` — cached candles from Bitget/Kraken

| Item | Formula / Logic | Status |
|------|-----------------|--------|
| Pearson correlation | `num/√(denX·denY)` where num=Σdx·dy, denX=Σdx², denY=Σdy² | ✓ Correct |
| Returns | `(price[i] - price[i-1]) / price[i-1]` | ✓ Correct |
| Timeframe | 1d if BTC 1d has ≥20 bars, else 1h | ✓ Correct |
| Display | `correlation.timeframe` in subtitle | ✓ Wired |
| Color thresholds | >0.7 green, >0.3 blue, >-0.3 gray, etc. | ✓ Correct |

---

## 2. Regime Timeline

**Data source:** `getRegimeTimeline()` from `services/crypto-api.js`  
**Population:** `recordRegimeSnapshot(regimeCounts)` on each dashboard load

| Item | Formula / Logic | Status |
|------|-----------------|--------|
| Total coins | `sum(latest.counts)` | ✓ Correct |
| Percentage | `(count / total) * 100` | ✓ Correct |
| Regimes | trending, ranging, compression, volatile, mixed | ✓ Correct |
| Display | "X coins", "Y% of coins" | ✓ Wired |

---

## 3. Monte Carlo Simulation

**Data source:** `runMonteCarlo(closedTrades, initialBalance, { paths: 500, horizonTrades: 50 })` in `services/monte-carlo.js`

| Item | Formula / Logic | Status |
|------|-----------------|--------|
| Trade return | `(pnl / margin)` per trade | ✓ Correct |
| Simulated PnL | `(equity * 0.02) * ret` — 2% risk per trade | ✓ Correct |
| Equity percentiles | P5, P50, P95 of final equity across 500 paths | ✓ Correct |
| Max DD distribution | P50, P95 of max drawdown % per path | ✓ Correct |
| Risk of Ruin | `(paths with DD ≥ threshold) / paths * 100` | ✓ Correct |
| Keys | "20%", "50%" from ruinThresholds [0.2, 0.5] | ✓ Correct |
| Display | "20% DD", "50% DD" with probability % | ✓ Wired |

---

## 4. Drawdown Analysis

**Data source:** `computeDrawdownAnalysis(equityCurve)` in `services/analytics.js`  
**Input:** Equity curve from `getPerformanceStats()` (paper-trading)

| Item | Formula / Logic | Status |
|------|-----------------|--------|
| Max drawdown $ | `peak - trough` (peak before trough) | ✓ Correct |
| Max drawdown % | `(peak - trough) / peak * 100` | ✓ Correct |
| Recovery time | Time from drawdown entry to recovery (hours) | ✓ Correct |
| Avg recovery | Mean of all recovery times | ✓ Correct |
| Longest underwater | Max of (end - start) per completed underwater period | ✓ Correct |
| Underwater entry | `eq < drawdownPeak * 0.99` | ✓ Correct |
| Underwater exit | `eq >= drawdownPeak` | ✓ Correct |
| Display | $ and %, hours | ✓ Wired |

**Note:** Only completed underwater periods are counted. An ongoing drawdown is not included in "longest underwater."

---

## 5. Risk Metrics by Strategy & Regime

**Data source:** `computeRiskMetricsByStrategyAndRegime(closedTrades, initialBalance, equityCurve)` in `services/analytics.js`

| Item | Formula / Logic | Status |
|------|-----------------|--------|
| Sharpe | `meanRet / stdRet` | ✓ Correct |
| Sortino | `meanRet / downsideStd` | ✓ Correct |
| Calmar | `(totalReturn * 100) / maxDrawdownPct` | ✓ Correct |
| Profit Factor | `grossProfit / grossLoss` | ✓ Correct |
| Min trades | 2 per bucket | ✓ Correct |
| Display | By strategy and by regime tables | ✓ Wired |

---

## 6. Equity Curve (Canvas)

**Data source:** `stats.equityCurve` from `getPerformanceStats()`

| Item | Logic | Status |
|------|-------|--------|
| Y-axis | `(equity - minE) / range * plotH` | ✓ Correct |
| Drawdown shading | `data[i].drawdown > 0` | ✓ Correct |
| DPR scaling | `devicePixelRatio` applied | ✓ Correct |

---

## Summary

All sections use correct math and are wired to the right data sources. No bugs found. The Analytics page displays:

- **Correlation Matrix** — Pearson correlation vs BTC (1d or 1h returns)
- **Regime Timeline** — Regime counts and % from dashboard snapshots
- **Monte Carlo** — Bootstrap simulation, equity percentiles, max DD distribution, risk of ruin
- **Drawdown Analysis** — Max DD, avg recovery time, longest underwater
- **Risk Metrics** — Sharpe, Sortino, Calmar, PF by strategy and regime
