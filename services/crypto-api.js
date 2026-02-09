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

const REFRESH_INTERVAL = 60 * 1000;
const COINGECKO_DELAY = 6000;
const BINANCE_DELAY = 450;  // Stay under ~20 req/s (5 klines per coin) to avoid 429
const RETRY_DELAY = 10000;
const RATE_LIMIT_WAIT_BASE = 20000;
const BINANCE_CANDLE_RETRY_DELAY = 3500;

const TRACKED_COINS = [
  'bitcoin', 'ethereum', 'solana', 'dogecoin', 'ripple', 'cardano',
  'polkadot', 'avalanche-2', 'chainlink', 'polygon',
  'binancecoin', 'litecoin', 'uniswap', 'cosmos'
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
  polygon:       { symbol: 'MATIC', name: 'Polygon',    binance: 'MATICUSDT' },
  binancecoin:   { symbol: 'BNB',   name: 'BNB',        binance: 'BNBUSDT' },
  litecoin:      { symbol: 'LTC',   name: 'Litecoin',   binance: 'LTCUSDT' },
  uniswap:       { symbol: 'UNI',   name: 'Uniswap',    binance: 'UNIUSDT' },
  cosmos:        { symbol: 'ATOM',  name: 'Cosmos',     binance: 'ATOMUSDT' }
};

// CoinCap.io uses different asset ids – map our id to theirs
const COINCAP_IDS = {
  'bitcoin': 'bitcoin', 'ethereum': 'ethereum', 'solana': 'solana', 'dogecoin': 'dogecoin',
  'ripple': 'xrp', 'cardano': 'cardano', 'polkadot': 'polkadot', 'avalanche-2': 'avalanche',
  'chainlink': 'chainlink', 'polygon': 'matic-network',
  'binancecoin': 'binance-coin', 'litecoin': 'litecoin', 'uniswap': 'uniswap', 'cosmos': 'cosmos'
};

// Once we get 451 from Binance we skip all Binance calls for this process (e.g. on Render)
let binanceRestricted = false;
let priceSourceRotation = 0;

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
// COINGECKO - Prices (single call). NO RETRY on 429 so we can try next API immediately.
// ====================================================
async function fetchCoinGeckoPricesOnce() {
  const ids = TRACKED_COINS.join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 12000 });
  if (res.status === 429) {
    throw new Error('Rate limited (429)');
  }
  if (!res.ok) {
    throw new Error('HTTP ' + res.status);
  }
  const data = await res.json();
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid price response');
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
// Skipped if we already got 451 (binanceRestricted). Use as fallback when others rate limit.
// ====================================================
async function fetchPricesFromBinance() {
  if (binanceRestricted) return null;
  const results = [];
  for (const coinId of TRACKED_COINS) {
    const meta = COIN_META[coinId];
    if (!meta || !meta.binance) continue;
    try {
      const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${meta.binance}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 10000 });
      if (res.status === 451) {
        binanceRestricted = true;
        console.log('[Binance] 451 – not available from this region (skipping Binance for rest of session)');
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

// Kraken pair names (they use X/Z prefixes)
const KRAKEN_PAIRS = {
  'bitcoin': 'XXBTZUSD', 'ethereum': 'XETHZUSD', 'solana': 'SOLUSD', 'dogecoin': 'DOGEUSD',
  'ripple': 'XXRPZUSD', 'cardano': 'ADAUSD', 'polkadot': 'DOTUSD', 'avalanche-2': 'AVAXUSD',
  'chainlink': 'LINKUSD', 'polygon': 'MATICUSD',
  'binancecoin': 'BNBUSD', 'litecoin': 'XLTCZUSD', 'uniswap': 'UNIUSD', 'cosmos': 'ATOMUSD'
};

// ====================================================
// KRAKEN - Free public ticker, no key, good rate limits
// ====================================================
async function fetchPricesFromKraken() {
  try {
    const pairs = TRACKED_COINS.map(id => KRAKEN_PAIRS[id]).filter(Boolean);
    if (pairs.length === 0) return null;
    const url = 'https://api.kraken.com/0/public/Ticker?pair=' + pairs.join(',');
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 10000 });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json.result || json;
    if (!result || typeof result !== 'object') return null;
    const out = [];
    TRACKED_COINS.forEach(function(coinId) {
      const pair = KRAKEN_PAIRS[coinId];
      const meta = COIN_META[coinId];
      if (!pair || !meta) return;
      const t = result[pair] || result[pair.replace('Z', '')];
      if (!t || !t.c) return;
      const price = parseFloat(t.c[0]);
      const open = t.o ? parseFloat(t.o) : price;
      const change24h = open && open > 0 ? ((price - open) / open) * 100 : 0;
      if (isNaN(price)) return;
      out.push({
        id: coinId,
        symbol: meta.symbol,
        name: meta.name,
        binanceSymbol: meta.binance,
        price,
        change24h: isNaN(change24h) ? 0 : change24h,
        volume24h: t.v ? parseFloat(t.v[1]) : 0,
        marketCap: 0,
        lastUpdated: new Date()
      });
    });
    return out.length > 0 ? out : null;
  } catch (err) {
    console.error('[Kraken] Price fetch failed:', err.message);
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

async function fetchAllCandlesForCoin(coinId, retriesLeft = 1) {
  if (binanceRestricted) return null;
  const meta = COIN_META[coinId];
  if (!meta?.binance) return null;

  try {
    const [candles15m, candles1h, candles4h, candles1d, candles1w] = await Promise.all([
      fetchBinanceCandles(meta.binance, '15m', 96),   // 24h of 15m
      fetchBinanceCandles(meta.binance, '1h', 168),
      fetchBinanceCandles(meta.binance, '4h', 100),
      fetchBinanceCandles(meta.binance, '1d', 30),
      fetchBinanceCandles(meta.binance, '1w', 26)     // ~6 months weekly
    ]);

    return {
      '15m': candles15m,
      '1h': candles1h,
      '4h': candles4h,
      '1d': candles1d,
      '1w': candles1w
    };
  } catch (err) {
    if (err.message && err.message.includes('451')) binanceRestricted = true;
    if (retriesLeft > 0 && !binanceRestricted) {
      console.log(`[Binance] Retrying ${COIN_META[coinId].symbol} in ${BINANCE_CANDLE_RETRY_DELAY / 1000}s...`);
      await sleep(BINANCE_CANDLE_RETRY_DELAY);
      return fetchAllCandlesForCoin(coinId, retriesLeft - 1);
    }
    console.error(`Binance candles failed for ${coinId}: ${err.message}`);
    return null;
  }
}

// ====================================================
// COINGECKO HISTORY – one shot, no retry on 429 (so we don't block refresh)
// ====================================================
async function fetchHistoryOnce(coinId, days = 7) {
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 12000 });
  if (res.status === 429) throw new Error('Rate limited (429)');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data || typeof data !== 'object') throw new Error('Invalid history response');
  const prices = Array.isArray(data.prices) ? data.prices : [];
  const totalVolumes = Array.isArray(data.total_volumes) ? data.total_volumes : [];
  const marketCaps = Array.isArray(data.market_caps) ? data.market_caps : [];
  return {
    prices: prices.map(([ts, price]) => ({ timestamp: ts, price })),
    volumes: totalVolumes.map(([ts, vol]) => ({ timestamp: ts, volume: vol })),
    marketCaps: marketCaps.map(([ts, mc]) => ({ timestamp: ts, marketCap: mc }))
  };
}

// Used by other code paths that may need retry (e.g. coin detail page)
async function fetchHistoryFromAPI(coinId, days = 7) {
  return fetchHistoryOnce(coinId, days);
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
  let successCount = 0; // Binance candles count; in scope for completion log
  console.log('[Refresh] Starting background data refresh...');

  try {
    if (cache.lastRefresh === 0) {
      console.log('[Refresh] Waiting 10s before first API call (avoids rate limit)...');
      await sleep(10000);
    }
    // Step 1: Prices – rotate first source (CoinGecko / CoinCap) to spread rate limits, then Kraken, then Binance
    priceSourceRotation = (priceSourceRotation + 1) % 2;
    const tryOrder = priceSourceRotation === 0
      ? ['coingecko', 'coincap', 'kraken', 'binance']
      : ['coincap', 'coingecko', 'kraken', 'binance'];
    let prices = [];
    for (const source of tryOrder) {
      if (prices && prices.length > 0) break;
      try {
        let result = null;
        if (source === 'coingecko') result = await fetchCoinGeckoPricesOnce();
        else if (source === 'coincap') result = await fetchPricesFromCoinCap();
        else if (source === 'kraken') result = await fetchPricesFromKraken();
        else if (source === 'binance') result = await fetchPricesFromBinance();
        if (result && Array.isArray(result) && result.length > 0) {
          prices = result;
          console.log(`[Refresh] Got prices for ${prices.length} coins (${source})`);
        }
      } catch (err) {
        console.error(`[Refresh] ${source} failed:`, err.message);
      }
    }
    if (prices && prices.length > 0) {
      const prevCount = (cache.prices.data || []).length;
      const minCoins = Math.min(TRACKED_COINS.length, Math.max(5, Math.ceil(TRACKED_COINS.length * 0.5)));
      const accept = prices.length >= minCoins || (prevCount > 0 && prices.length >= prevCount);
      if (accept) {
        cache.prices = { data: prices, timestamp: Date.now() };
      } else {
        console.log(`[Refresh] Skipping partial price update (got ${prices.length}, need ${minCoins} or more; keeping ${prevCount} coins)`);
      }
    } else {
      console.log('[Refresh] No prices from any API – keeping previous');
    }
    if (pricesReadyResolve) {
      pricesReadyResolve();
      pricesReadyResolve = null;
    }

    // Step 2: Binance candles – skipped entirely if we already got 451 (binanceRestricted)
    if (binanceRestricted) {
      console.log('[Refresh] Skipping Binance candles (unavailable in this region)');
    } else {
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
          if (err.message && err.message.includes('451')) {
            binanceRestricted = true;
            console.log('[Refresh] Binance unavailable (451) – skipping candles for rest of session');
            break;
          } else {
            console.error(`[Refresh] Candles failed for ${coinId}: ${err.message}`);
          }
        }
        if (binanceRestricted) break;
      }
    }

    // Step 3: CoinGecko history as fallback for coins without Binance candles
    const coinsNeedingHistory = TRACKED_COINS.filter(id => !cache.candles[id]);
    for (const coinId of coinsNeedingHistory) {
      try {
        await sleep(COINGECKO_DELAY);
        const history = await fetchHistoryOnce(coinId, 7);
        cache.history[coinId] = history;
        console.log(`[Refresh] CG history: ${COIN_META[coinId].symbol}`);
      } catch (err) {
        if (err.message && err.message.includes('429')) {
          console.log('[Refresh] CoinGecko history rate limited – waiting 25s then continuing...');
          await sleep(25000);
          try {
            const history = await fetchHistoryOnce(coinId, 7);
            cache.history[coinId] = history;
            console.log(`[Refresh] CG history: ${COIN_META[coinId].symbol} (after wait)`);
          } catch (retryErr) {
            console.error(`[Refresh] CG history failed for ${coinId}: ${retryErr.message}`);
          }
        } else {
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

/** Fetch live price for one coin (e.g. for closing a trade). Tries Binance then cache. */
async function fetchLivePrice(coinId) {
  const meta = COIN_META[coinId];
  if (meta && meta.binance && !binanceRestricted) {
    try {
      const url = `https://api.binance.com/api/v3/ticker/price?symbol=${meta.binance}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 8000 });
      if (res.status === 451) { binanceRestricted = true; return null; }
      if (!res.ok) return null;
      const data = await res.json();
      const price = parseFloat(data.price);
      return Number.isFinite(price) && price > 0 ? price : null;
    } catch (err) {
      if (err.message && err.message.includes('451')) binanceRestricted = true;
    }
  }
  const cached = getCurrentPrice(coinId);
  return cached && Number.isFinite(cached.price) ? cached.price : null;
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
  fetchCandles, fetchAllCandles, getCurrentPrice, fetchLivePrice, isDataReady,
  pricesReadyPromise,
  TRACKED_COINS, COIN_META
};
