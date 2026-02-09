// services/crypto-api.js
// ====================================================
// CRYPTO MARKET DATA - CoinGecko + Binance Integration
// CoinGecko: prices, market caps (1 call)
// Binance: OHLCV candles, volume (no API key, 1200 req/min)
// Uses BACKGROUND REFRESH pattern.
// ====================================================

const fetch = require('node-fetch');

const cache = {
  prices: { data: [], timestamp: 0 },
  candles: {},
  history: {},
  lastRefresh: 0,
  refreshing: false
};

const REFRESH_INTERVAL = 5 * 60 * 1000;
const COINGECKO_DELAY = 6000;
const BINANCE_DELAY = 200;
const RETRY_DELAY = 10000;

const TRACKED_COINS = [
  'bitcoin', 'ethereum', 'solana', 'dogecoin', 'ripple', 'cardano',
  'polkadot', 'avalanche-2', 'chainlink', 'polygon'
];

const COIN_META = {
  bitcoin:       { symbol: 'BTC',   name: 'Bitcoin',    binance: 'BTCUSDT' },
  ethereum:      { symbol: 'ETH',   name: 'Ethereum',   binance: 'ETHUSDT' },
  solana:        { symbol: 'SOL',   name: 'Solana',     binance: 'SOLUSDT' },
  dogecoin:      { symbol: 'DOGE',  name: 'Dogecoin',   binance: 'DOGEUSDT' },
  ripple:        { symbol: 'XRP',   name: 'Ripple',     binance: 'XRPUSDT' },
  cardano:       { symbol: 'ADA',   name: 'Cardano',    binance: 'ADAUSDT' },
  polkadot:      { symbol: 'DOT',   name: 'Polkadot',   binance: 'DOTUSDT' },
  'avalanche-2': { symbol: 'AVAX',  name: 'Avalanche',  binance: 'AVAXUSDT' },
  chainlink:     { symbol: 'LINK',  name: 'Chainlink',  binance: 'LINKUSDT' },
  polygon:       { symbol: 'MATIC', name: 'Polygon',    binance: 'MATICUSDT' }
};

// ====================================================
// FETCH WITH RETRY
// ====================================================
async function fetchWithRetry(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        timeout: 15000
      });
      if (response.status === 429) {
        const wait = RETRY_DELAY * (attempt + 1);
        console.log(`Rate limited on price. Waiting ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 100)}`);
      }
      const json = await response.json();
      return json;
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(RETRY_DELAY);
    }
  }
  throw new Error('Rate limited after retries');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ====================================================
// COINGECKO - Prices (single call for all coins)
// ====================================================
async function fetchPricesFromAPI() {
  const ids = TRACKED_COINS.join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true`;
  const data = await fetchWithRetry(url);

  if (!data || typeof data !== 'object') {
    throw new Error('Invalid price response from API');
  }

  return TRACKED_COINS.map(id => {
    const info = data[id];
    if (!info) return null;
    const meta = COIN_META[id];
    return {
      id,
      symbol: meta.symbol,
      name: meta.name,
      binanceSymbol: meta.binance,
      price: info.usd || 0,
      change24h: info.usd_24h_change || 0,
      volume24h: info.usd_24h_vol || 0,
      marketCap: info.usd_market_cap || 0,
      lastUpdated: info.last_updated_at ? new Date(info.last_updated_at * 1000) : new Date()
    };
  }).filter(Boolean);
}

// ====================================================
// BINANCE - OHLCV Candles (no API key needed!)
// Returns proper Open/High/Low/Close/Volume candles
// ====================================================
async function fetchBinanceCandles(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const data = await fetchWithRetry(url);

  return (data || []).map(candle => ({
    openTime: candle[0],
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[5]),
    closeTime: candle[6],
    quoteVolume: parseFloat(candle[7]),
    trades: candle[8],
    takerBuyVolume: parseFloat(candle[9]),
    takerBuyQuoteVolume: parseFloat(candle[10])
  }));
}

async function fetchAllCandlesForCoin(coinId) {
  const meta = COIN_META[coinId];
  if (!meta?.binance) return null;

  try {
    const [candles1h, candles4h, candles1d] = await Promise.all([
      fetchBinanceCandles(meta.binance, '1h', 168),
      fetchBinanceCandles(meta.binance, '4h', 100),
      fetchBinanceCandles(meta.binance, '1d', 30)
    ]);

    return {
      '1h': candles1h,
      '4h': candles4h,
      '1d': candles1d
    };
  } catch (err) {
    console.error(`Binance candles failed for ${coinId}: ${err.message}`);
    return null;
  }
}

// ====================================================
// COINGECKO HISTORY FALLBACK
// ====================================================
async function fetchHistoryFromAPI(coinId, days = 7) {
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`;
  const data = await fetchWithRetry(url);

  return {
    prices: (data.prices || []).map(([ts, price]) => ({ timestamp: ts, price })),
    volumes: (data.total_volumes || []).map(([ts, vol]) => ({ timestamp: ts, volume: vol })),
    marketCaps: (data.market_caps || []).map(([ts, mc]) => ({ timestamp: ts, marketCap: mc }))
  };
}

// ====================================================
// BACKGROUND REFRESH
// ====================================================
async function refreshAllData() {
  if (cache.refreshing) return;
  cache.refreshing = true;
  console.log('[Refresh] Starting background data refresh...');

  try {
    // Step 1: CoinGecko prices (keep previous cache if rate limited or error)
    try {
      const prices = await fetchPricesFromAPI();
      if (prices && prices.length > 0) {
        cache.prices = { data: prices, timestamp: Date.now() };
        console.log(`[Refresh] Got prices for ${prices.length} coins`);
      }
    } catch (priceErr) {
      console.error('[Refresh] Price fetch failed:', priceErr.message, '- keeping previous prices');
    }

    // Step 2: Binance candles for each coin (3 calls per coin, but Binance is generous)
    let successCount = 0;
    for (const coinId of TRACKED_COINS) {
      try {
        await sleep(BINANCE_DELAY);
        const candles = await fetchAllCandlesForCoin(coinId);
        if (candles) {
          cache.candles[coinId] = candles;
          successCount++;
          console.log(`[Refresh] Candles: ${COIN_META[coinId].symbol} (${successCount}/${TRACKED_COINS.length})`);
        }
      } catch (err) {
        console.error(`[Refresh] Candles failed for ${coinId}: ${err.message}`);
      }
    }

    // Step 3: CoinGecko history as fallback (only for coins without Binance data)
    for (const coinId of TRACKED_COINS) {
      if (!cache.candles[coinId]) {
        try {
          await sleep(COINGECKO_DELAY);
          const history = await fetchHistoryFromAPI(coinId, 7);
          cache.history[coinId] = history;
          console.log(`[Refresh] CG history fallback: ${COIN_META[coinId].symbol}`);
        } catch (err) {
          console.error(`[Refresh] CG history failed for ${coinId}: ${err.message}`);
        }
      }
    }

    cache.lastRefresh = Date.now();
    console.log(`[Refresh] Complete. ${successCount}/${TRACKED_COINS.length} coins with Binance candles.`);
  } catch (err) {
    console.error('[Refresh] Error:', err.message);
  } finally {
    cache.refreshing = false;
  }
}

// ====================================================
// PUBLIC API
// ====================================================
function fetchAllPrices() {
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

function fetchCandles(coinId) {
  triggerRefreshIfNeeded();
  return cache.candles[coinId] || null;
}

function fetchAllCandles() {
  triggerRefreshIfNeeded();
  return { ...cache.candles };
}

function getCurrentPrice(coinId) {
  const prices = cache.prices.data || [];
  return prices.find(p => p.id === coinId) || null;
}

function isDataReady() {
  return cache.lastRefresh > 0 && Object.keys(cache.candles).length > 0;
}

function triggerRefreshIfNeeded() {
  const now = Date.now();
  if ((now - cache.lastRefresh) > REFRESH_INTERVAL && !cache.refreshing) {
    refreshAllData().catch(err => console.error('[Refresh] Trigger error:', err.message));
  }
}

// Start initial refresh
console.log('[CryptoAPI] Starting initial data fetch...');
refreshAllData().catch(err => console.error('[CryptoAPI] Initial error:', err.message));

module.exports = {
  fetchAllPrices, fetchPriceHistory, fetchAllHistory,
  fetchCandles, fetchAllCandles, getCurrentPrice, isDataReady,
  TRACKED_COINS, COIN_META
};
