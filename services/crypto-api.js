// services/crypto-api.js
// ====================================================
// CRYPTO MARKET DATA - CoinGecko API Integration
// Free API, no key required.
// Uses BACKGROUND REFRESH pattern to avoid rate limits.
// Data is fetched every 5 minutes in background, served from cache instantly.
// ====================================================

const fetch = require('node-fetch');

// Cache stores - data lives here, served to all requests instantly
const cache = {
  prices: { data: [], timestamp: 0 },
  history: {},        // keyed by coinId
  signals: null,      // pre-computed signals
  lastRefresh: 0,
  refreshing: false   // lock to prevent concurrent refreshes
};

const REFRESH_INTERVAL = 5 * 60 * 1000;   // Refresh every 5 minutes
const REQUEST_DELAY = 2000;                // 2 seconds between API calls
const RETRY_DELAY = 10000;                 // 10 seconds retry on 429

// Top 8 coins for full analysis (reduces API calls from 16 to 9 total)
const TRACKED_COINS = [
  'bitcoin', 'ethereum', 'solana', 'dogecoin', 'cardano',
  'ripple', 'chainlink', 'avalanche-2'
];

const COIN_META = {
  bitcoin:        { symbol: 'BTC',   name: 'Bitcoin' },
  ethereum:       { symbol: 'ETH',   name: 'Ethereum' },
  solana:         { symbol: 'SOL',   name: 'Solana' },
  dogecoin:       { symbol: 'DOGE',  name: 'Dogecoin' },
  cardano:        { symbol: 'ADA',   name: 'Cardano' },
  ripple:         { symbol: 'XRP',   name: 'Ripple' },
  chainlink:      { symbol: 'LINK',  name: 'Chainlink' },
  'avalanche-2':  { symbol: 'AVAX',  name: 'Avalanche' }
};

// ====================================================
// SINGLE API CALL WITH RETRY
// ====================================================
async function fetchWithRetry(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        timeout: 15000
      });

      if (response.status === 429) {
        console.log(`Rate limited (429). Waiting ${RETRY_DELAY / 1000}s before retry ${attempt + 1}/${retries}...`);
        await sleep(RETRY_DELAY * (attempt + 1));
        continue;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(RETRY_DELAY);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ====================================================
// FETCH FUNCTIONS (called by background refresh only)
// ====================================================

async function fetchPricesFromAPI() {
  const ids = TRACKED_COINS.join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true`;

  const data = await fetchWithRetry(url);

  return TRACKED_COINS.map(id => {
    const info = data[id];
    if (!info) return null;
    const meta = COIN_META[id];
    return {
      id,
      symbol: meta.symbol,
      name: meta.name,
      price: info.usd || 0,
      change24h: info.usd_24h_change || 0,
      volume24h: info.usd_24h_vol || 0,
      marketCap: info.usd_market_cap || 0,
      lastUpdated: info.last_updated_at ? new Date(info.last_updated_at * 1000) : new Date()
    };
  }).filter(Boolean);
}

async function fetchHistoryFromAPI(coinId, days = 7) {
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currencies=usd&days=${days}`;
  const data = await fetchWithRetry(url);

  return {
    prices: (data.prices || []).map(([ts, price]) => ({ timestamp: ts, price })),
    volumes: (data.total_volumes || []).map(([ts, vol]) => ({ timestamp: ts, volume: vol })),
    marketCaps: (data.market_caps || []).map(([ts, mc]) => ({ timestamp: ts, marketCap: mc }))
  };
}

// ====================================================
// BACKGROUND REFRESH - fetches all data sequentially
// ====================================================
async function refreshAllData() {
  if (cache.refreshing) {
    console.log('Refresh already in progress, skipping...');
    return;
  }

  cache.refreshing = true;
  console.log('Starting background data refresh...');

  try {
    // Step 1: Fetch all prices (single API call)
    const prices = await fetchPricesFromAPI();
    cache.prices = { data: prices, timestamp: Date.now() };
    console.log(`Fetched prices for ${prices.length} coins`);

    // Step 2: Fetch history for each coin with generous delays
    await sleep(REQUEST_DELAY);

    for (const coinId of TRACKED_COINS) {
      try {
        const history = await fetchHistoryFromAPI(coinId, 7);
        cache.history[coinId] = history;
        console.log(`Fetched history for ${COIN_META[coinId].symbol}`);
      } catch (err) {
        console.error(`History fetch failed for ${coinId}: ${err.message}`);
        // Keep old cache data if available
      }
      await sleep(REQUEST_DELAY);
    }

    cache.lastRefresh = Date.now();
    console.log('Background refresh complete.');
  } catch (err) {
    console.error('Background refresh error:', err.message);
  } finally {
    cache.refreshing = false;
  }
}

// ====================================================
// PUBLIC API - returns cached data instantly
// ====================================================

function fetchAllPrices() {
  // Trigger background refresh if stale (non-blocking)
  triggerRefreshIfNeeded();
  return Promise.resolve(cache.prices.data || []);
}

function fetchPriceHistory(coinId) {
  triggerRefreshIfNeeded();
  return Promise.resolve(cache.history[coinId] || { prices: [], volumes: [], marketCaps: [] });
}

function fetchAllHistory() {
  triggerRefreshIfNeeded();
  const results = {};
  for (const coinId of TRACKED_COINS) {
    results[coinId] = cache.history[coinId] || { prices: [], volumes: [], marketCaps: [] };
  }
  return Promise.resolve(results);
}

function triggerRefreshIfNeeded() {
  const now = Date.now();
  if ((now - cache.lastRefresh) > REFRESH_INTERVAL && !cache.refreshing) {
    // Fire and forget - don't await
    refreshAllData().catch(err => console.error('Refresh trigger error:', err.message));
  }
}

// ====================================================
// START INITIAL REFRESH ON MODULE LOAD
// ====================================================
console.log('Crypto API: Starting initial data fetch (this takes ~20 seconds)...');
refreshAllData().catch(err => console.error('Initial refresh error:', err.message));

module.exports = { fetchAllPrices, fetchPriceHistory, fetchAllHistory, TRACKED_COINS, COIN_META };
