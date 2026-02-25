# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Crypto Signals Pro v3.0 is a monolithic Node.js/Express application with EJS templates, backed by MongoDB. It provides crypto trading signals, paper trading, a trading journal, and a learning engine. The entry point is `voting-app.js`.

### Running the application

1. **MongoDB must be running** before starting the app. Start with:
   ```
   mongod --dbpath /data/db --fork --logpath /tmp/mongod.log
   ```
2. **Start the app** with `npm start` (or `node voting-app.js`). It listens on port 3000.
3. The app waits up to ~140s for initial price data from external APIs before the HTTP server starts. In practice it usually takes 10-20s.

### Known environment caveats

- **Binance API is geo-blocked** (HTTP 451) from Cloud Agent VMs. The app handles this gracefully via CoinGecko/CoinCap/Kraken fallbacks. `isDataReady()` may remain `false` because it requires Binance candle data, but all pages still render and function correctly with CoinGecko history data.
- **CoinCap API** may also fail DNS resolution (`ENOTFOUND`) in some environments. This is non-blocking; the app rotates to other sources.
- **No `.env` file is needed** for local development. The app defaults to `mongodb://127.0.0.1:27017/votingApp` and has a hardcoded session secret for dev.
- **No linter or test suite** is configured in the repo. `npm test` exits with an error by design. The `scripts/test-apis.js` can be used to test API connectivity.

### Standard commands

See `package.json` for scripts: `npm start` runs the app, `npm run test:apis` tests API endpoints.
