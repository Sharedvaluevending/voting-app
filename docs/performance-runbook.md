# Performance Runbook

## New Runtime Signals

- Slow HTTP request logs: `[HTTP-SLOW] ...`
- Slow DB query logs: `[DB-SLOW] ...`
- Protected metrics API: `GET /api/ops/metrics` (requires login)

Thresholds are configurable:

- `SLOW_HTTP_MS` (default `1200`)
- `SLOW_DB_MS` (default `300`)

## Load Test (Smoke)

Run against local:

```bash
BASE_URL=http://127.0.0.1:3000 CONCURRENCY=200 DURATION_SEC=60 PATHS=/api/health node scripts/loadtest-smoke.js
```

Run against deployed:

```bash
BASE_URL=https://your-app-url CONCURRENCY=500 DURATION_SEC=120 PATHS=/api/health,/ node scripts/loadtest-smoke.js
```

Use scripted npm alias:

```bash
npm run loadtest:smoke
```

## What "good" looks like (initial target)

- Success rate >= 99%
- p95 <= 1000ms on light routes (`/api/health`, `/`)
- No sustained growth in `[HTTP-SLOW]` / `[DB-SLOW]`
- No PM2 forced SIGKILL restarts

## PM2 Startup

Use the tuned config:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## Quick Tuning Levers

- If API providers are timing out during backtests:
  - increase `REFRESH_INTERVAL_MS` (e.g. `240000`)
  - keep `MAX_RUNNING_BACKTEST_JOBS=1`
- If DB wait queues spike:
  - increase `MONGO_MAX_POOL_SIZE` gradually (60 -> 80)
  - inspect `/api/ops/metrics` top DB ops before raising further
