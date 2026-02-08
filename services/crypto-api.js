// services/crypto-api.js
// ====================================================
// CRYPTO MARKET DATA - CoinGecko API Integration
// Free API, no key required. Caching to respect rate limits.
// ====================================================

const fetch = require('node-fetch');

// Cache stores
const cache = {
  prices: { data: null, timestamp: 0 },
  history: {},  // keyed by coinId_days
  details: {}   // keyed by coinId
};
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes
const HISTORY_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const TRACKED_COINS = [
  'bitcoin', 'ethereum', 'solana', 'dogecoin', 'cardano',
  'polkadot', 'chainlink', 'avalanche-2', 'ripple', 'matic-network',
  'litecoin', 'uniswap', 'stellar', 'cosmos', 'near'
];

const COIN_META = {
  bitcoin:        { symbol: 'BTC',   name: 'Bitcoin' },
  ethereum:       { symbol: 'ETH',   name: 'Ethereum' },
  solana:         { symbol: 'SOL',   name: 'Solana' },
  dogecoin:       { symbol: 'DOGE',  name: 'Dogecoin' },
  cardano:        { symbol: 'ADA',   name: 'Cardano' },
  polkadot:       { symbol: 'DOT',   name: 'Polkadot' },
  chainlink:      { symbol: 'LINK',  name: 'Chainlink' },
  'avalanche-2':  { symbol: 'AVAX',  name: 'Avalanche' },
  ripple:         { symbol: 'XRP',   name: 'Ripple' },
  'matic-network':{ symbol: 'MATIC', name: 'Polygon' },
  litecoin:       { symbol: 'LTC',   name: 'Litecoin' },
  uniswap:        { symbol: 'UNI',   name: 'Uniswap' },
  stellar:        { symbol: 'XLM',   name: 'Stellar' },
  cosmos:         { symbol: 'ATOM',  name: 'Cosmos' },
  near:           { symbol: 'NEAR',  name: 'NEAR' }
};

/**
 * Fetch current prices for all tracked coins.
 */
async function fetchAllPrices() {
  const now = Date.now();
  if (cache.prices.data && (now - cache.prices.timestamp) < CACHE_TTL) {
    return cache.prices.data;
  }

  try {
    const ids = TRACKED_COINS.join(',');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true`;

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 10000
    });

    if (!response.ok) throw new Error(`CoinGecko API: ${response.status}`);
    const data = await response.json();

    const prices = TRACKED_COINS.map(id => {
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

    cache.prices = { data: prices, timestamp: now };
    return prices;
  } catch (err) {
    console.error('fetchAllPrices error:', err.message);
    return cache.prices.data || [];
  }
}

/**
 * Fetch price history for a single coin (for technical analysis).
 * Returns hourly data points for the given number of days.
 */
async function fetchPriceHistory(coinId, days = 7) {
  const cacheKey = `${coinId}_${days}`;
  const now = Date.now();

  if (cache.history[cacheKey] && (now - cache.history[cacheKey].timestamp) < HISTORY_CACHE_TTL) {
    return cache.history[cacheKey].data;
  }

  try {
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currencies=usd&days=${days}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 15000
    });

    if (!response.ok) throw new Error(`CoinGecko history: ${response.status}`);
    const data = await response.json();

    const result = {
      prices: (data.prices || []).map(([ts, price]) => ({ timestamp: ts, price })),
      volumes: (data.total_volumes || []).map(([ts, vol]) => ({ timestamp: ts, volume: vol })),
      marketCaps: (data.market_caps || []).map(([ts, mc]) => ({ timestamp: ts, marketCap: mc }))
    };

    cache.history[cacheKey] = { data: result, timestamp: now };
    return result;
  } catch (err) {
    console.error(`fetchPriceHistory(${coinId}) error:`, err.message);
    return cache.history[cacheKey]?.data || { prices: [], volumes: [], marketCaps: [] };
  }
}

/**
 * Fetch all history data for all tracked coins in sequence (with delays to avoid rate limits).
 */
async function fetchAllHistory(days = 7) {
  const results = {};
  for (const coinId of TRACKED_COINS) {
    results[coinId] = await fetchPriceHistory(coinId, days);
    // Small delay between requests to respect CoinGecko rate limits
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return results;
}

module.exports = { fetchAllPrices, fetchPriceHistory, fetchAllHistory, TRACKED_COINS, COIN_META };
