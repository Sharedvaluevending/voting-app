# Audit: Performance Page

**Date:** 2026-03-04  
**Scope:** Performance dashboard logic, forms, API wiring, data flow

---

## 1. Route & Data Flow

### GET /performance
- **Auth:** `requireLogin`
- **Data sources:**
  - `getPerformanceStats(userId)` — paper-trading.js
  - `User.findById(userId)` — user + settings
  - `Journal` + `Trade` — journal analytics (emotion, followed/broke rules)
- **Balance auto-fix:** Calls `reconcileBalance` + `fixBalance` if discrepancy ≥ $1; re-fetches stats
- **Render vars:** `stats`, `user`, `journalAnalytics`, `balanceAudit`, `useDeepSeek`, `success`, `error`

### safeStats fallback
When `getPerformanceStats` returns null, `safeStats` provides defaults:
- `balance: 10000`, `initialBalance: 10000`, `totalPnl: 0`, `byStrategy: {}`, `byCoin: {}`, `equityCurve: []`, etc.

---

## 2. Forms & Actions

| Form Action | Method | Handler | Status |
|-------------|--------|---------|--------|
| `/account/reset` | POST | Confirm `RESET`, reset to $10k, delete trades | ✅ |
| `/account/delete` | POST | Confirm `DELETE`, delete user | ✅ |
| `/account/full-platform-reset` | POST | Confirm `RESET PLATFORM`, wipe trades/journals/learning | ✅ |
| `/account/set-balance` | POST | Set paper balance | ✅ |
| `/account/sync-balance-from-bitget` | POST | Sync from Bitget | ✅ |
| `/account/settings` | POST | Save risk, leverage, auto-trade, LLM, fees | ✅ |
| `/account/feature-toggles` | POST | Save feature toggles (TP mode, DCA, BE, TS, etc.) | ✅ |
| `/account/coin-weight-settings` | POST | Save coin weight enabled + strength | ✅ |

All forms include `_csrf` hidden input. ✅

---

## 3. Checkbox Handling

**Pattern:** Hidden input + checkbox with same name
```html
<input type="hidden" name="disableLeverage" value="false">
<input type="checkbox" name="disableLeverage" value="true" ...>
```
- Checked: both submitted; last value (`true`) used
- Unchecked: only hidden submitted; `false` used
- Server: `req.body.disableLeverage !== undefined` then `val === 'true' || ...`

**Verified:** `disableLeverage`, `useFixedLeverage`, `autoTrade`, `llmEnabled`, `llmAgentEnabled`, `paperLiveSync`, `autoExecuteActions`, and feature toggles all use this pattern or explicit `!== undefined` checks. ✅

---

## 4. API Endpoints Used by Performance Page

| Endpoint | Purpose | Status |
|----------|---------|--------|
| `/api/exchange/balance` | Bitget balance for "Bitget balance: $X" | ✅ |
| `/api/ollama/status` | Test Ollama connection | ✅ |
| `/api/auto-trade-debug` | "Why no trades?" diagnostic | ✅ |
| `/api/llm-agent/run` | "Run now" manual agent trigger | ✅ |
| `/api/load-coin-weights-from-backtest` | Load coin weights from backtest | ✅ |

All use `credentials: 'same-origin'`. API routes are CSRF-exempt. ✅

---

## 5. Load from Backtest Preset

**Backtest saves:** `btcFilter`, `btcCorrelation`, `sessionFilter`, `partialTP`, `breakeven`, `trailingStop`, `lockIn`, `scoreRecheck`, `slCap`, `minRiskRewardEnabled`, `minRiskReward`, `correlationFilterEnabled`, etc.

**Performance mapping:** Maps backtest keys → live form field names (e.g. `btcFilter` → `featureBtcFilter`).

**Fixed (2026-03-04):** Extended mapping to include:
- Numeric: `breakevenRMult`, `trailingStartR`, `trailingDistR`, `maxDailyLossPercent`, `drawdownThresholdPercent`, `minVolume24hUsd`, `trailingTpAtrMultiplier`, `trailingTpFixedPercent`, `dcaMaxAdds`, `dcaDipPercent`, `dcaAddSizePercent`, `dcaMinScore`
- Select: `trailingTpDistanceMode`
- Checkbox: `drawdownSizingEnabled`
- Special: `dca` → `dcaEnabled`, `trailingTp` → `tpMode` radio (fixed/trailing)
- UI: Show/hide `dca-opts`, `trailing-tp-opts`, `trail-atr-wrap`, `trail-fixed-wrap`, `dd-thresh-wrap`, `minRrValueWrap`

---

## 6. getPerformanceStats

**Returns:** `balance`, `totalEquity`, `totalPnl`, `totalPnlPercent`, `winRate`, `wins`, `losses`, `byStrategy`, `byCoin`, `equityCurve`, `drawdownAnalysis`, `riskByStrategyRegime`, `sharpe`, `sortino`, `calmar`, `maxDrawdown`, `maxDrawdownPct`, `openTrades`, `openMarginLocked`, `openUnrealizedPnl`, etc.

**byStrategy / byCoin:** Use `t.strategyType` and `t.symbol` from closed trades. Legacy `mean_reversion` trades appear as "mean_reversion" in By Strategy; display is correct.

---

## 7. Journal Analytics

**Condition:** `journalAnalytics.byEmotion` or `byRules.followed/broke` have data.

**Data:** Journal entries with `tradeId` → lookup trade → win/loss by emotion and followedRules.

**Fallback:** `journalAnalytics || { byEmotion: {}, byRules: { followed: { wins: 0, total: 0 }, broke: { wins: 0, total: 0 } } }` — no null refs. ✅

---

## 8. Position Sizing Calculator

**Inputs:** `calc-balance`, `calc-risk`, `calc-entry`, `calc-sl`, `calc-lev`

**Logic:** `riskAmt = balance * (risk/100)`, `stopDist = |entry - sl| / entry`, `posSize = (riskAmt / stopDist) * lev`, capped at `balance * lev * 0.95`.

**Initial balance:** `stats.totalEquity || stats.balance || 10000` — safe. ✅

**Event:** `input` on all 5 fields — `updateCalc()` runs. ✅

---

## 9. Equity Curve Chart

**Condition:** `stats.equityCurve && stats.equityCurve.length > 1`

**Data:** Inline `<%- JSON.stringify(stats.equityCurve) %>` — passed to client script.

**Error handling:** `try/catch` with fallback message. ✅

**Legend:** Uses `stats.totalEquity`, `stats.balance`, `stats.maxDrawdownPct` — all from safeStats. ✅

---

## 10. Potential Issues

| Issue | Severity | Notes |
|-------|----------|-------|
| ~~Load from Backtest doesn't map numeric fields~~ | — | Fixed: BE/TS/DCA/TP/drawdown/minVolume now mapped |
| `stats.balance` could be 0 after reset | Low | `toLocaleString` on 0 is fine; display shows $0.00 |
| `stats.totalEquity` undefined when no open trades | None | Fallback to `stats.balance` |

---

## 11. Summary

- **Route:** Correctly wired; data fetched and passed to template.
- **Forms:** All POST actions exist and have CSRF; checkbox handling is correct.
- **APIs:** Bitget balance, Ollama test, auto-trade debug, LLM run, load coin weights all wired.
- **Stats display:** Safe fallbacks; `byStrategy`/`byCoin` use `data-label` for mobile card layout.
- **Load from Backtest:** Now maps numeric values, TP mode, DCA, and risk controls (fixed 2026-03-04).
