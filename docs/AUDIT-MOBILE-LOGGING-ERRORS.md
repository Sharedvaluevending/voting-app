# Audit: Mobile, Logging, Error Boundaries

**Date:** 2026-03-04  
**Scope:** Mobile responsiveness, production logging, frontend error handling

---

## 1. Mobile Responsiveness

### 1.1 Current State

| Area | Status | Notes |
|------|--------|-------|
| Viewport | ✅ OK | `meta name="viewport"` in `partials/header.ejs` |
| Nav | ✅ OK | Nav toggle at 600px, dropdowns collapse, 44px touch targets |
| Global CSS | ✅ OK | `style.css` @media at 768, 600, 500, 380px; `.data-table` overflow-x |
| Setups page | ✅ OK | Card-style table for mobile; `table-scroll-mobile`; modal max-width 100% |
| Chart page | ⚠️ Partial | @media 768px for sidebar; tools go horizontal; chart container not constrained |
| Trench Warfare | ⚠️ Partial | Modals max-width 480px/400px; tables overflow-x; no card layout for tables |

### 1.2 Gaps

**Charts**
- `chart.ejs`: Lightweight Charts (TradingView) embed — container has `min-width: 0` but no explicit mobile height. Drawing canvas and tool sidebar may overflow on narrow screens.
- `backtest.ejs` equity bars: `overflow-x:auto` — horizontal scroll on mobile; bars may be too narrow to tap.
- `strategy-comparison.ejs` score-history-chart: `overflow-x:auto` — same.
- TradingView iframe (from voting-app.js `/chart` route): relies on TradingView’s own responsive behavior; no explicit mobile sizing.

**Tables**
- `trades.ejs`: Uses `signals-grid` + `trade-card` — no table; cards stack. ✅
- `history.ejs`, `performance.ejs`, `exchange.ejs`, `analytics.ejs`, `llm-logs.ejs`: Use `.data-table` with `overflow-x:auto`. Horizontal scroll on mobile; no card-style fallback.
- `trench-warfare.ejs`: Tables in `overflow-x:auto` divs; no `data-label` card layout.
- `backtest.ejs` trades/coins tables: `overflow-x:auto`; many columns; poor UX on phones.

**Modals**
- `setup-backtest-modal`: `max-height: calc(100vh - 24px)`, `overflow-y: auto`, `-webkit-overflow-scrolling: touch` ✅
- `bot-key-modal`, `buy-modal` (trench-warfare): `max-width: 480px/400px`, `width: 100%`, `padding: 20px` — generally OK.
- `chart.ejs` candle-colors-panel, indicators-dropdown: `position: absolute`; may go off-screen on small viewports.

**Touch targets**
- `style.css` @media 500px: `min-height: 44px` for `.form-btn`, `.btn`, `input`, `select`, `textarea` ✅
- Some inline buttons (e.g. trade actions) may be smaller; needs spot-check.

### 1.3 Recommendations

1. **Tables**: Add `table-scroll-mobile` + `data-label` card layout (like setups) for: history, performance, exchange, analytics, llm-logs, trench-warfare, backtest.
2. **Charts**: Add `min-height: 200px` (or similar) for chart containers on mobile; ensure drawing canvas is scrollable/pannable.
3. **Modals**: Ensure all modals use `max-width: 100%`, `padding: 16px` at 768px, and `overflow-y: auto` with `-webkit-overflow-scrolling: touch`.
4. **Dropdowns**: Audit absolute-positioned panels (candle colors, indicators) for viewport overflow; add `max-width: 100%` and `right: 0` fallback.

---

## 2. Logging Audit

### 2.1 Sensitive Data in Logs

| File | Line(s) | Sensitive Data | Severity |
|------|---------|----------------|----------|
| `paper-trading.js` | 377, 566, 974, 1005–1087, etc. | Full trade details: symbol, entry, SL, TP, size, PnL, exit price, duration | High |
| `bitget.js` | 129, 185, 233, 239, 258–260, 276–278 | orderId, symbol, side, trade details, errors | High |
| `risk-engine.js` | 77, 89, 215 | symbol, entry, stopLoss, balance, required | Medium |
| `email.js` | 28 | Reset URL (dev) — contains token | High |
| `trench-auto-trading.js` | 113, 402 | userId (partial), token counts | Medium |
| `voting-app.js` | 2321 | userId, balance discrepancy | Medium |
| `services/llm-chat.js` | 88 | Message length (low risk) | Low |

### 2.2 No Production Gating

- No `process.env.NODE_ENV === 'production'` checks around `console.log`/`console.warn`/`console.error`.
- All logs run in production; trading data, errors, and API responses can appear in server logs.

### 2.3 Recommendations

1. **Gate by env**: Add `const isProd = process.env.NODE_ENV === 'production'` and wrap sensitive logs:
   ```js
   if (!isProd) console.log(`[OpenTrade] ${symbol} ...`);
   ```
2. **Error logs**: Keep `console.error` for real failures; redact or truncate sensitive fields (e.g. `symbol` only, no prices/sizes).
3. **Email**: Never log reset URLs in production; remove or gate behind `!isProd`.
4. **Bitget**: Gate order/trade logs in production; log only `symbol` and `orderId` (or hash) for audit, not full payloads.
5. **Shared helper**: `lib/logger.js` with `debug()`, `info()`, `warn()`, `error()` that respect `NODE_ENV` and log levels.

---

## 3. Error Boundaries & Unhandled Rejections

### 3.1 Stack

- **Frontend**: EJS + vanilla JS (no React). No React Error Boundaries.
- **Client-side**: Inline scripts in EJS; fetch calls with `.catch()` in many places.

### 3.2 Current Error Handling

| Location | Pattern | Status |
|----------|---------|--------|
| `exchange.ejs` | `fetch().then().catch()` — sets empty/error UI | ✅ |
| `trench-warfare.ejs` | `fetch().catch()` — statusEl.textContent, alert | ✅ |
| `chart.ejs` | `fetch().catch()` — some silent, some console.warn | ⚠️ |
| `backtest-results.ejs` | `async/await` try/catch | ✅ |
| `trench-warfare.ejs` | `fetch().catch(() => {})` — empty catch | ⚠️ |

### 3.3 Gaps

1. **No global handlers**: No `window.addEventListener('unhandledrejection', ...)` or `window.onerror`. Unhandled promise rejections can crash the app or leave it in a broken state.
2. **Silent catches**: Several `fetch().catch(() => {})` or `catch(function() {})` with no user feedback (e.g. trench-warfare positions, auto status).
3. **Chart.js / Lightweight Charts**: Chart init failures may throw; no try/catch around chart creation in `chart.ejs`.
4. **TradingView iframe**: External iframe; errors inside it don’t affect the app, but load failures are not surfaced.

### 3.4 Recommendations

1. **Global handlers** (add to `partials/footer.ejs` or a shared script):
   ```js
   window.addEventListener('unhandledrejection', function(e) {
     console.error('[App] Unhandled rejection:', e.reason);
     e.preventDefault(); // Prevent default browser console dump
     // Optionally: show a toast or inline error banner
   });
   window.addEventListener('error', function(e) {
     console.error('[App] Uncaught error:', e.message, e.filename, e.lineno);
   });
   ```
2. **User feedback**: Replace empty `catch` with at least a minimal message (e.g. “Failed to load. Refresh to try again.”).
3. **Chart init**: Wrap chart creation in try/catch and show a fallback message on failure.
4. **Optional**: Add a small error banner component that shows when a critical fetch fails; dismissible or auto-hide.

---

## Summary: Priority Actions

| Priority | Area | Action |
|----------|------|--------|
| High | Logging | Gate `paper-trading` and `bitget` trade/order logs in production |
| High | Logging | Gate `email.js` reset URL log in production |
| Medium | Mobile | Add card-style table layout for history, performance, backtest tables |
| Medium | Errors | Add global `unhandledrejection` and `error` handlers |
| Medium | Errors | Replace empty `catch` with user-visible error messages |
| Low | Mobile | Audit chart containers and dropdown panels for small screens |
| Low | Logging | Introduce shared `lib/logger.js` with env-aware levels |
