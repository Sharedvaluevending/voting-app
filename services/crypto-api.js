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
const RATE_LIMIT_WAIT_BASE = 20000;

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

// CoinCap.io uses different asset ids – map our id to theirs
const COINCAP_IDS = {
  'bitcoin': 'bitcoin', 'ethereum': 'ethereum', 'solana': 'solana', 'dogecoin': 'dogecoin',
  'ripple': 'xrp', 'cardano': 'cardano', 'polkadot': 'polkadot', 'avalanche-2': 'avalanche',
  'chainlink': 'chainlink', 'polygon': 'matic-network'
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
      if (response.status === 451) {
        throw new Error('Service unavailable from this location (451)');
      }
      if (response.status === 429) {
        const wait = RATE_LIMIT_WAIT_BASE * (attempt + 1);
        console.log(`Rate limited. Waiting ${wait / 1000}s before retry...`);
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
// BINANCE - Prices (24hr ticker, no API key)
// Use as fallback when CoinGecko is rate limited. Returns null if 451 (restricted region).
// ====================================================
async function fetchPricesFromBinance() {
  const results = [];
  for (const coinId of TRACKED_COINS) {
    const meta = COIN_META[coinId];
    if (!meta || !meta.binance) continue;
    try {
      const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${meta.binance}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 10000 });
      if (res.status === 451) {
        console.log('[Binance] 451 – not available from this region (prices skipped)');
        return null;
      }
      if (!res.ok) continue;
      const data = await res.json();
      const price = parseFloat(data.lastPrice);
      const change24h = parseFloat(data.priceChangePercent) || 0;
      results.push({
        id: coinId,
        symbol: meta.symbol,
        name: meta.name,
        binanceSymbol: meta.binance,
        price: isNaN(price) ? 0 : price,
        change24h,
        volume24h: parseFloat(data.quoteVolume) || 0,
        marketCap: 0,
        lastUpdated: new Date()
      });
      await sleep(100);
    } catch (err) {
      if (err.message && err.message.includes('451')) return null;
      console.error(`[Binance] price ${meta.symbol}:`, err.message);
    }
  }
  return results.length > 0 ? results : null;
}

// ====================================================
// COINCAP.IO - Free prices, no key, ~200 req/min, usually not geo-blocked
// ====================================================
async function fetchPricesFromCoinCap() {
  try {
    const res = await fetch('https://api.coincap.io/v2/assets?limit=200', {
      headers: { 'Accept': 'application/json' },
      timeout: 15000
    });
    if (!res.ok) return null;
    const json = await res.json();
    const list = json.data || json;
    if (!Array.isArray(list)) return null;
    const byId = {};
    list.forEach(function(a) {
      byId[(a.id || '').toLowerCase()] = a;
    });
    const results = [];
    TRACKED_COINS.forEach(function(coinId) {
      const capId = COINCAP_IDS[coinId] || coinId;
      const a = byId[capId];
      const meta = COIN_META[coinId];
      if (!a || !meta) return;
      const price = parseFloat(a.priceUsd);
      if (isNaN(price)) return;
      results.push({
        id: coinId,
        symbol: meta.symbol,
        name: meta.name,
        binanceSymbol: meta.binance,
        price,
        change24h: parseFloat(a.changePercent24Hr) || 0,
        volume24h: parseFloat(a.volumeUsd24Hr) || 0,
        marketCap: parseFloat(a.marketCapUsd) || 0,
        lastUpdated: new Date()
      });
    });
    return results.length > 0 ? results : null;
  } catch (err) {
    console.error('[CoinCap] Price fetch failed:', err.message);
    return null;
  }
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

  if (!data || typeof data !== 'object') {
    throw new Error('Invalid history response');
  }
  const prices = Array.isArray(data.prices) ? data.prices : [];
  const totalVolumes = Array.isArray(data.total_volumes) ? data.total_volumes : [];
  const marketCaps = Array.isArray(data.market_caps) ? data.market_caps : [];

  return {
    prices: prices.map(([ts, price]) => ({ timestamp: ts, price })),
    volumes: totalVolumes.map(([ts, vol]) => ({ timestamp: ts, volume: vol })),
    marketCaps: marketCaps.map(([ts, mc]) => ({ timestamp: ts, marketCap: mc }))
  };
}

// Resolved when first price load attempt has finished (so dashboard has data or we've tried)
let pricesReadyResolve;
const pricesReadyPromise = new Promise(function(resolve) { pricesReadyResolve = resolve; });

// ====================================================
// BACKGROUND REFRESH
// ====================================================
async function refreshAllData() {
  if (cache.refreshing) return;
  cache.refreshing = true;
  console.log('[Refresh] Starting background data refresh...');

  try {
    if (cache.lastRefresh === 0) {
      console.log('[Refresh] Waiting 10s before first API call (avoids rate limit)...');
      await sleep(10000);
    }
    // Step 1: Prices – CoinGecko first, then Binance fallback (Binance returns 451 on Render)
    let prices = [];
    try {
      prices = await fetchPricesFromAPI();
    } catch (priceErr) {
      console.error('[Refresh] CoinGecko price fetch failed:', priceErr.message);
    }
    if (prices && prices.length > 0) {
      cache.prices = { data: prices, timestamp: Date.now() };
      console.log(`[Refresh] Got prices for ${prices.length} coins (CoinGecko)`);
    } else {
      const binancePrices = await fetchPricesFromBinance();
      if (binancePrices && binancePrices.length > 0) {
        cache.prices = { data: binancePrices, timestamp: Date.now() };
        console.log(`[Refresh] Got prices for ${binancePrices.length} coins (Binance)`);
      } else {
        const coincapPrices = await fetchPricesFromCoinCap();
        if (coincapPrices && coincapPrices.length > 0) {
          cache.prices = { data: coincapPrices, timestamp: Date.now() };
          console.log(`[Refresh] Got prices for ${coincapPrices.length} coins (CoinCap)`);
        } else {
          console.log('[Refresh] No prices from CoinGecko, Binance, or CoinCap – keeping previous');
        }
      }
    }
    if (pricesReadyResolve) {
      pricesReadyResolve();
      pricesReadyResolve = null;
    }

    // Step 2: Binance candles (skipped in restricted regions – 451). Use CoinGecko history fallback below.
    let binanceOk = true;
    let successCount = 0;
    for (const coinId of TRACKED_COINS) {
      if (!binanceOk) break;
      try {
        await sleep(BINANCE_DELAY);
        const candles = await fetchAllCandlesForCoin(coinId);
        if (candles) {
          cache.candles[coinId] = candles;
          successCount++;
          console.log(`[Refresh] Candles: ${COIN_META[coinId].symbol} (${successCount}/${TRACKED_COINS.length})`);
        }
      } catch (err) {
        if (err.message && err.message.includes('451')) {
          console.log('[Refresh] Binance unavailable (451) – using CoinGecko history for candles');
          binanceOk = false;
        } else {
          console.error(`[Refresh] Candles failed for ${coinId}: ${err.message}`);
        }
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
    if (pricesReadyResolve) {
      pricesReadyResolve();
      pricesReadyResolve = null;
    }
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
  pricesReadyPromise,
  TRACKED_COINS, COIN_META
};
