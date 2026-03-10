// lib/api-queue.js
// ====================================================
// API REQUEST QUEUE - Proactive rate limit handling
// Queues requests, spaces them with configurable delay, exponential backoff on 429.
// Use for CoinGecko, MarketScanner, and other rate-limited APIs.
// ====================================================

const DEFAULT_MIN_SPACING_MS = 1200;   // ~50 req/min for CoinGecko free tier
const DEFAULT_BASE_BACKOFF_MS = 5000;
const DEFAULT_MAX_BACKOFF_MS = 120000;

/**
 * Create a throttled + queued API caller for a given endpoint type.
 * @param {Object} opts - { minSpacingMs, baseBackoffMs, maxBackoffMs, name }
 * @returns {Function} enqueue(fn) - returns Promise that resolves when fn() completes
 */
function createThrottler(opts = {}) {
  const minSpacingMs = opts.minSpacingMs ?? DEFAULT_MIN_SPACING_MS;
  const baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const name = opts.name || 'api';

  const state = { queue: [], processing: false, lastRequestAt: 0, consecutive429: 0 };

  async function processQueue() {
    if (state.processing || state.queue.length === 0) return;
    state.processing = true;

    while (state.queue.length > 0) {
      const now = Date.now();
      const elapsed = now - state.lastRequestAt;
      if (elapsed < minSpacingMs) {
        await sleep(minSpacingMs - elapsed);
      }

      const item = state.queue.shift();
      if (!item) continue;

      let result;
      let err;
      try {
        result = await item.fn();
        state.consecutive429 = 0;
      } catch (e) {
        err = e;
        const is429 = (e.message || '').includes('429') || (e.status === 429);
        if (is429) {
          state.consecutive429++;
          const wait = Math.min(baseBackoffMs * Math.pow(2, state.consecutive429 - 1), maxBackoffMs);
          console.warn(`[ApiQueue:${name}] 429 rate limited – exponential backoff ${(wait / 1000).toFixed(0)}s (attempt ${state.consecutive429})`);
          await sleep(wait);
          state.queue.unshift(item);
          continue;
        }
      }

      state.lastRequestAt = Date.now();
      if (err) item.reject(err);
      else item.resolve(result);
    }

    state.processing = false;
  }

  return function enqueue(fn) {
    return new Promise((resolve, reject) => {
      state.queue.push({ fn, resolve, reject });
      processQueue();
    });
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** CoinGecko: ~10–12 req/min for free tier; use 6s spacing for safety. */
const coingeckoThrottler = createThrottler({
  name: 'coingecko',
  minSpacingMs: 6000,
  baseBackoffMs: 15000,
  maxBackoffMs: 120000
});

/** MarketScanner: fetches market_chart per coin; ~40/min with 1.5s spacing. */
const marketScannerThrottler = createThrottler({
  name: 'market-scanner',
  minSpacingMs: 1500,
  baseBackoffMs: 10000,
  maxBackoffMs: 60000
});

module.exports = {
  createThrottler,
  coingeckoThrottler,
  marketScannerThrottler,
  sleep
};
