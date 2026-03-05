# Backtest Page Audit — "Just Loads" Investigation

## Summary

Full end-to-end audit of the backtest page flow. The backtest **does work** when run directly (completes in ~90–105s for 1 coin, 7–10 days, 1h TF). Several fixes were applied to improve reliability and UX.

## Flow

1. **Client** (`views/backtest.ejs`): Form submit → `runOneBacktest(baseBody)` → POST `/api/backtest` → poll GET `/api/backtest/status/:jobId` every 2–5s
2. **Server** (`voting-app.js`): POST creates job, starts `runBacktest()` in background, returns `{ jobId, status: 'running', coins }` immediately
3. **Backtest** (`services/backtest.js`): Fetches candles (Bitget/Kraken), runs simulation per coin, returns `{ summary, results, equityCurve, ... }`

## Root Causes for "Just Loads"

| Cause | Fix |
|-------|-----|
| **POST hangs** when MongoDB is slow/unreachable (User.findById, StrategyWeight.find block) | 5s timeout via `Promise.race` on DB calls |
| **Client fetch** has no timeout — hangs indefinitely if server never responds | 60s AbortController timeout; user sees clear error |
| **getFeatureFlags()** can throw if any toggle element is missing | Optional chaining (`?.`) and defaults for all elements |
| **Progress** stays at "Backtest started..." for 90s+ | `onProgress` callback updates job.progress during run |

## Fixes Applied

### 1. Backend (`voting-app.js`)

- **DB timeout**: `User.findById` and `StrategyWeight.find` wrapped in `Promise.race` with 5s timeout. On timeout, use defaults (empty excludedCoins, default strategyWeights).
- **Progress callback**: Pass `onProgress: (msg) => { job.progress = msg; }` to `runBacktest` so status polls show live progress.

### 2. Backtest service (`services/backtest.js`)

- **Progress callback**: Call `options.onProgress(msg)` when fetching BTC and when processing each coin batch.

### 3. Frontend (`views/backtest.ejs`)

- **Fetch timeout**: 60s AbortController; on abort, show "Server took too long to start. Try fewer coins or check your connection."
- **getFeatureFlags()**: All `document.getElementById(...)` wrapped with `?.` and sensible defaults. Prevents null reference errors if DOM structure changes.

## Verification

- Direct `runBacktest()` call: **OK** (bitcoin, 10 days, 1h → 12 trades in ~104s)
- POST returns `jobId` immediately: **OK**
- Status poll returns `{ status: 'running', progress: '...' }` during run: **OK**
- Progress updates during run: **OK** ("Fetching BTC...", "Processing bitcoin (1/1 coins)...")

## Deployment Notes

- **Multi-instance**: If the app runs multiple workers (e.g. Render), each has its own `backtestJobs` Map. A POST on worker A and a status poll on worker B → 404 "Job not found". Use sticky sessions or a shared store (Redis) for job state if scaling horizontally.
- **Cold start**: First request after idle may be slow (crypto-api warmup). The 60s POST timeout should cover this.
- **Long runs**: 1 coin ~90s; 3 coins ~3–4 min. Poll interval backs off (2s → 5s). Max wait 10 min before client times out.
