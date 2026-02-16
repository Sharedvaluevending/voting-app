// services/crypto-api.js
// ====================================================
// CRYPTO MARKET DATA - CoinGecko + Bybit + Kraken
// CoinGecko: prices, market caps (1 call)
// Bybit: OHLCV candles, funding rates (no API key, public)
// Kraken: OHLCV fallback, prices fallback
// Uses BACKGROUND REFRESH pattern.
// ====================================================

const fetch = require('node-fetch');

const cache = {
  prices: { data: [], timestamp: 0 },
  candles: {},
  history: {},
  fundingRates: {},   // coinId -> { rate, time }
  scoreHistory: {},   // coinId -> [{ score, signal, regime, timestamp }]
  regimeTimeline: [], // [{ timestamp, counts: { trending: 5, ranging: 3, ... } }]
  lastRefresh: 0,
  refreshing: false
};

const REFRESH_INTERVAL = 60 * 1000;
const COINGECKO_DELAY = 6000;
const BYBIT_DELAY = 350;       // Bybit: 120 req/s for public, be conservative
const RETRY_DELAY = 10000;
const RATE_LIMIT_WAIT_BASE = 20000;

const TRACKED_COINS = [
  'bitcoin', 'ethereum', 'solana', 'dogecoin', 'ripple', 'cardano',
  'polkadot', 'avalanche-2', 'chainlink', 'polygon',
  'binancecoin', 'litecoin', 'uniswap', 'cosmos',
  'near', 'arbitrum', 'optimism', 'sui', 'injective-protocol', 'pepe'
];

const COIN_META = {
  bitcoin:       { symbol: 'BTC',   name: 'Bitcoin',    bybit: 'BTCUSDT' },
  ethereum:      { symbol: 'ETH',   name: 'Ethereum',   bybit: 'ETHUSDT' },
  solana:        { symbol: 'SOL',   name: 'Solana',     bybit: 'SOLUSDT' },
  dogecoin:      { symbol: 'DOGE',  name: 'Dogecoin',   bybit: 'DOGEUSDT' },
  ripple:        { symbol: 'XRP',   name: 'Ripple',     bybit: 'XRPUSDT' },
  cardano:       { symbol: 'ADA',   name: 'Cardano',    bybit: 'ADAUSDT' },
  polkadot:      { symbol: 'DOT',   name: 'Polkadot',   bybit: 'DOTUSDT' },
  'avalanche-2': { symbol: 'AVAX',  name: 'Avalanche',  bybit: 'AVAXUSDT' },
  chainlink:     { symbol: 'LINK',  name: 'Chainlink',  bybit: 'LINKUSDT' },
  polygon:       { symbol: 'POL',   name: 'Polygon',    bybit: 'POLUSDT' },
  binancecoin:   { symbol: 'BNB',   name: 'BNB',        bybit: 'BNBUSDT' },
  litecoin:      { symbol: 'LTC',   name: 'Litecoin',   bybit: 'LTCUSDT' },
  uniswap:       { symbol: 'UNI',   name: 'Uniswap',    bybit: 'UNIUSDT' },
  cosmos:        { symbol: 'ATOM',  name: 'Cosmos',     bybit: 'ATOMUSDT' },
  near:          { symbol: 'NEAR',  name: 'NEAR',       bybit: 'NEARUSDT' },
  arbitrum:      { symbol: 'ARB',   name: 'Arbitrum',   bybit: 'ARBUSDT' },
  optimism:      { symbol: 'OP',    name: 'Optimism',  bybit: 'OPUSDT' },
  sui:           { symbol: 'SUI',   name: 'Sui',       bybit: 'SUIUSDT' },
  'injective-protocol': { symbol: 'INJ', name: 'Injective', bybit: 'INJUSDT' },
  pepe:          { symbol: 'PEPE',   name: 'Pepe',       bybit: 'PEPEUSDT' }
};

// CoinCap.io uses different asset ids
const COINCAP_IDS = {
  'bitcoin': 'bitcoin', 'ethereum': 'ethereum', 'solana': 'solana', 'dogecoin': 'dogecoin',
  'ripple': 'xrp', 'cardano': 'cardano', 'polkadot': 'polkadot', 'avalanche-2': 'avalanche',
  'chainlink': 'chainlink', 'polygon': 'matic-network',
  'binancecoin': 'binance-coin', 'litecoin': 'litecoin', 'uniswap': 'uniswap', 'cosmos': 'cosmos',
  'near': 'near-protocol', 'arbitrum': 'arbitrum', 'optimism': 'optimism', 'sui': 'sui',
  'injective-protocol': 'injective-protocol', 'pepe': 'pepe'
};

let priceSourceRotation = 0;

// Max candle age before flagging stale (2 hours for 1h candles)
const MAX_CANDLE_AGE_MS = 2 * 60 * 60 * 1000;

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
// COINGECKO - Prices (single call)
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
      bybitSymbol: meta.bybit,
      price: (info.usd && info.usd > 0) ? info.usd : null, // Reject zero/negative prices
      change24h: info.usd_24h_change || 0,
      volume24h: info.usd_24h_vol || 0,
      marketCap: info.usd_market_cap || 0,
      lastUpdated: info.last_updated_at ? new Date(info.last_updated_at * 1000) : new Date()
    };
  }).filter(p => p && p.price && p.price > 0); // Filter out null entries and zero prices
}

// ====================================================
// BYBIT - Prices (v5 public ticker, no API key)
// ====================================================
async function fetchPricesFromBybit() {
  try {
    const url = 'https://api.bybit.com/v5/market/tickers?category=spot';
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 12000 });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.retCode !== 0 || !json.result || !json.result.list) return null;
    const bySymbol = {};
    json.result.list.forEach(t => { bySymbol[t.symbol] = t; });
    const results = [];
    TRACKED_COINS.forEach(coinId => {
      const meta = COIN_META[coinId];
      if (!meta || !meta.bybit) return;
      const t = bySymbol[meta.bybit];
      if (!t) return;
      const price = parseFloat(t.lastPrice);
      if (isNaN(price) || price <= 0) return;
      const prevPrice = parseFloat(t.prevPrice24h) || price;
      const change24h = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
      results.push({
        id: coinId,
        symbol: meta.symbol,
        name: meta.name,
        bybitSymbol: meta.bybit,
        price,
        change24h: isNaN(change24h) ? 0 : change24h,
        volume24h: parseFloat(t.turnover24h) || 0,
        marketCap: 0,
        lastUpdated: new Date()
      });
    });
    return results.length > 0 ? results : null;
  } catch (err) {
    console.error('[Bybit] Price fetch failed:', err.message);
    return null;
  }
}

// ====================================================
// COINCAP.IO - Free prices, no key
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
        bybitSymbol: meta.bybit,
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

// Kraken pair names
const KRAKEN_PAIRS = {
  'bitcoin': 'XXBTZUSD', 'ethereum': 'XETHZUSD', 'solana': 'SOLUSD', 'dogecoin': 'XDGUSD',
  'ripple': 'XXRPZUSD', 'cardano': 'ADAUSD', 'polkadot': 'DOTUSD', 'avalanche-2': 'AVAXUSD',
  'chainlink': 'LINKUSD', 'polygon': 'POLUSD',
  'binancecoin': 'BNBUSD', 'litecoin': 'XLTCZUSD', 'uniswap': 'UNIUSD', 'cosmos': 'ATOMUSD',
  'near': 'NEARUSD', 'arbitrum': 'ARBUSD', 'optimism': 'OPUSD', 'sui': 'SUIUSD',
  'injective-protocol': 'INJUSD', 'pepe': 'PEPEUSD'
};

// ====================================================
// KRAKEN - Free public ticker
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
      const t = result[pair] || result[pair.replace('Z', '')] || result['X' + pair] || result[pair.replace('X', '').replace('Z', '')];
      if (!t || !t.c) return;
      const price = parseFloat(t.c[0]);
      const open = t.o ? parseFloat(t.o) : price;
      const change24h = open && open > 0 ? ((price - open) / open) * 100 : 0;
      if (isNaN(price)) return;
      out.push({
        id: coinId,
        symbol: meta.symbol,
        name: meta.name,
        bybitSymbol: meta.bybit,
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
// BYBIT - OHLCV Candles (v5 public, no API key)
// Intervals: 1,3,5,15,30,60,120,240,360,720,D,W,M
// ====================================================
const BYBIT_INTERVAL_MAP = { '15m': '15', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' };

async function fetchBybitCandles(symbol, interval, limit, startMs, endMs) {
  const bybitInterval = BYBIT_INTERVAL_MAP[interval];
  if (!bybitInterval || !symbol) return [];
  try {
    let url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${bybitInterval}&limit=${Math.min(limit, 1000)}`;
    if (startMs) url += `&start=${startMs}`;
    if (endMs) url += `&end=${endMs}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 12000 });
    if (!res.ok) {
      console.warn(`[Bybit] OHLC ${symbol} ${interval}: HTTP ${res.status} ${res.statusText}`);
      return [];
    }
    const json = await res.json();
    if (json.retCode !== 0 || !json.result || !json.result.list) {
      console.warn(`[Bybit] OHLC ${symbol} ${interval}: retCode=${json.retCode}, msg=${json.retMsg}, listLen=${json.result?.list?.length || 0}`);
      return [];
    }
    // Bybit returns newest first, reverse to chronological order
    // Each entry: [startTime, open, high, low, close, volume, turnover]
    const raw = json.result.list.reverse();
    return raw.map(c => ({
      openTime: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
      closeTime: parseInt(c[0]) + (interval === '1h' ? 3600000 : interval === '4h' ? 14400000 : interval === '15m' ? 900000 : interval === '1d' ? 86400000 : 604800000),
      quoteVolume: parseFloat(c[6]) || 0,
      trades: 0,
      takerBuyVolume: 0,
      takerBuyQuoteVolume: 0
    })).filter(c =>
      Number.isFinite(c.open) && c.open > 0 &&
      Number.isFinite(c.high) && c.high > 0 &&
      Number.isFinite(c.low) && c.low > 0 &&
      Number.isFinite(c.close) && c.close > 0 &&
      Number.isFinite(c.openTime) &&
      c.high >= c.low
    );
  } catch (err) {
    console.error(`[Bybit] OHLC ${symbol} ${interval} failed:`, err.message);
    return [];
  }
}

// ====================================================
// KRAKEN - OHLCV Candles (fallback)
// ====================================================
const KRAKEN_INTERVAL_MAP = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 };

async function fetchKrakenCandles(pair, interval, limit) {
  const krakenInterval = KRAKEN_INTERVAL_MAP[interval];
  if (!krakenInterval || !pair) return [];
  try {
    const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${krakenInterval}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 12000 });
    if (!res.ok) return [];
    const json = await res.json();
    if (json.error && json.error.length > 0) return [];
    const result = json.result || {};
    const keys = Object.keys(result).filter(k => k !== 'last');
    if (keys.length === 0) return [];
    const raw = result[keys[0]];
    if (!Array.isArray(raw)) return [];
    return raw.slice(-limit).map(c => ({
      openTime: c[0] * 1000,
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[6]),
      closeTime: (c[0] + krakenInterval * 60) * 1000,
      quoteVolume: 0,
      trades: c[7] || 0,
      takerBuyVolume: 0,
      takerBuyQuoteVolume: 0
    })).filter(c =>
      Number.isFinite(c.open) && c.open > 0 &&
      Number.isFinite(c.high) && c.high > 0 &&
      Number.isFinite(c.low) && c.low > 0 &&
      Number.isFinite(c.close) && c.close > 0 &&
      c.high >= c.low
    );
  } catch (err) {
    console.error(`[Kraken] OHLC ${pair} ${interval} failed:`, err.message);
    return [];
  }
}

/**
 * Fetch historical candles from Kraken for backtesting.
 * Kraken keeps ~720 hourly candles (~30 days). Returns whatever is available.
 * The backtest warmup/trading range logic handles date filtering.
 */
async function fetchHistoricalKrakenCandles(coinId, interval, startMs, endMs) {
  const pair = KRAKEN_PAIRS[coinId];
  if (!pair) { console.warn(`[Kraken] No pair for ${coinId}`); return []; }
  const krakenInterval = KRAKEN_INTERVAL_MAP[interval];
  if (!krakenInterval) return [];
  const msPerCandle = krakenInterval * 60 * 1000;

  try {
    // Use 'since' to request from start date. Kraken returns up to 720 candles
    // from that point forward. If data doesn't go back that far, it returns
    // whatever it has (most recent ~720 candles).
    const since = Math.floor(startMs / 1000);
    const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${krakenInterval}&since=${since}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 12000 });
    if (!res.ok) {
      console.warn(`[Kraken] Historical ${coinId} ${interval}: HTTP ${res.status}`);
      return [];
    }
    const json = await res.json();
    if (json.error && json.error.length > 0) {
      console.warn(`[Kraken] Historical ${coinId} ${interval}: API error ${JSON.stringify(json.error)}`);
      return [];
    }
    const result = json.result || {};
    const keys = Object.keys(result).filter(k => k !== 'last');
    if (keys.length === 0) return [];
    const raw = result[keys[0]];
    if (!Array.isArray(raw) || raw.length === 0) return [];

    // Return ALL candles without date filtering.
    // The backtest handles warmup and trading range itself.
    const candles = raw.map(c => ({
      openTime: c[0] * 1000,
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[6]),
      closeTime: (c[0] * 1000) + msPerCandle,
      quoteVolume: 0,
      trades: c[7] || 0,
      takerBuyVolume: 0,
      takerBuyQuoteVolume: 0
    })).filter(c =>
      Number.isFinite(c.open) && c.open > 0 &&
      Number.isFinite(c.high) && c.high > 0 &&
      Number.isFinite(c.low) && c.low > 0 &&
      Number.isFinite(c.close) && c.close > 0 &&
      c.high >= c.low
    );
    console.log(`[Kraken] Historical ${coinId} ${interval}: ${candles.length} candles (${new Date(candles[0].openTime).toISOString().slice(0,10)} to ${new Date(candles[candles.length-1].openTime).toISOString().slice(0,10)})`);
    return candles;
  } catch (err) {
    console.error(`[Kraken] Historical ${coinId} ${interval} failed:`, err.message);
    return [];
  }
}

async function fetchAllKrakenCandlesForCoin(coinId) {
  const pair = KRAKEN_PAIRS[coinId];
  if (!pair) return null;
  try {
    const [candles15m, candles1h, candles4h, candles1d, candles1w] = await Promise.all([
      fetchKrakenCandles(pair, '15m', 96),
      fetchKrakenCandles(pair, '1h', 168),
      fetchKrakenCandles(pair, '4h', 100),
      fetchKrakenCandles(pair, '1d', 30),
      fetchKrakenCandles(pair, '1w', 26)
    ]);
    if (!candles1h || candles1h.length < 20) return null;
    return {
      '15m': candles15m.length >= 20 ? candles15m : null,
      '1h': candles1h,
      '4h': candles4h.length >= 5 ? candles4h : null,
      '1d': candles1d.length >= 5 ? candles1d : null,
      '1w': candles1w.length >= 3 ? candles1w : null,
      _source: 'kraken',
      _fetchedAt: Date.now()
    };
  } catch (err) {
    console.error(`[Kraken] Candles failed for ${coinId}:`, err.message);
    return null;
  }
}

// ====================================================
// FETCH CANDLES: Bybit primary, Kraken fallback
// ====================================================
async function fetchAllCandlesForCoin(coinId, retriesLeft = 1) {
  const meta = COIN_META[coinId];

  // Try Bybit first (primary OHLCV source)
  if (meta?.bybit) {
    try {
      const [candles15m, candles1h, candles4h, candles1d, candles1w] = await Promise.all([
        fetchBybitCandles(meta.bybit, '15m', 96),
        fetchBybitCandles(meta.bybit, '1h', 168),
        fetchBybitCandles(meta.bybit, '4h', 100),
        fetchBybitCandles(meta.bybit, '1d', 30),
        fetchBybitCandles(meta.bybit, '1w', 26)
      ]);
      if (candles1h && candles1h.length >= 20) {
        return {
          '15m': candles15m.length >= 20 ? candles15m : null,
          '1h': candles1h,
          '4h': candles4h.length >= 5 ? candles4h : null,
          '1d': candles1d.length >= 5 ? candles1d : null,
          '1w': candles1w.length >= 3 ? candles1w : null,
          _source: 'bybit',
          _fetchedAt: Date.now()
        };
      }
    } catch (err) {
      console.error(`[Bybit] Candles failed for ${coinId}: ${err.message}`);
      if (retriesLeft > 0) {
        console.log(`[Bybit] Retrying ${meta.symbol} in 3s...`);
        await sleep(3000);
        return fetchAllCandlesForCoin(coinId, retriesLeft - 1);
      }
    }
  }

  // Fallback: Kraken OHLCV
  try {
    const krakenCandles = await fetchAllKrakenCandlesForCoin(coinId);
    if (krakenCandles) {
      console.log(`[Kraken] Got candles for ${coinId} (fallback)`);
      return krakenCandles;
    }
  } catch (err) {
    console.error(`[Kraken] Candle fallback failed for ${coinId}: ${err.message}`);
  }
  return null;
}

// ====================================================
// HISTORICAL CANDLES (for backtesting)
// Paginates to support longer ranges (Bybit returns max 1000 per request)
// ====================================================
const MS_PER_CANDLE = { '15m': 15 * 60 * 1000, '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000 };

async function fetchHistoricalCandlesForCoin(coinId, interval, startMs, endMs) {
  const meta = COIN_META[coinId];
  if (!meta?.bybit) return [];
  const bybitInterval = BYBIT_INTERVAL_MAP[interval];
  if (!bybitInterval) return [];
  const limit = 1000;
  const msPerCandle = MS_PER_CANDLE[interval] || 3600000;
  const all = [];
  let cursor = startMs;
  let retries = 0;
  const MAX_RETRIES = 2;
  while (cursor < endMs) {
    const chunk = await fetchBybitCandles(meta.bybit, interval, limit, cursor, endMs);
    if (!chunk || chunk.length === 0) {
      // Retry once on empty response (could be transient rate limit)
      if (retries < MAX_RETRIES && all.length === 0) {
        retries++;
        console.warn(`[Historical] ${coinId} ${interval}: empty response, retry ${retries}/${MAX_RETRIES} in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      break;
    }
    retries = 0; // reset on success
    all.push(...chunk);
    const lastTs = chunk[chunk.length - 1].openTime;
    if (lastTs >= endMs || chunk.length < limit) break;
    cursor = lastTs + msPerCandle;
    await new Promise(r => setTimeout(r, 350)); // rate limit
  }
  // Deduplicate by timestamp and sort chronologically
  const seen = new Set();
  const deduped = all.filter(c => {
    if (seen.has(c.openTime)) return false;
    seen.add(c.openTime);
    return true;
  });
  deduped.sort((a, b) => a.openTime - b.openTime);
  return deduped;
}

// ====================================================
// COINGECKO HISTORY
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

async function fetchHistoryFromAPI(coinId, days = 7) {
  return fetchHistoryOnce(coinId, days);
}

let pricesReadyResolve;
const pricesReadyPromise = new Promise(function(resolve) { pricesReadyResolve = resolve; });

// ====================================================
// CANDLE FRESHNESS CHECK
// ====================================================
function isCandleFresh(candles) {
  if (!candles || !candles['1h'] || candles['1h'].length === 0) return false;
  const lastCandle = candles['1h'][candles['1h'].length - 1];
  const age = Date.now() - (lastCandle.closeTime || lastCandle.openTime || 0);
  return age < MAX_CANDLE_AGE_MS;
}

function getCandleSource(coinId) {
  const c = cache.candles[coinId];
  if (!c) return 'none';
  return c._source || 'unknown';
}

function getCandleAge(coinId) {
  const c = cache.candles[coinId];
  if (!c || !c._fetchedAt) return Infinity;
  return Date.now() - c._fetchedAt;
}

// ====================================================
// SCORE HISTORY (in-memory, per coin)
// ====================================================
function recordScoreHistory(coinId, scoreData) {
  if (!cache.scoreHistory[coinId]) cache.scoreHistory[coinId] = [];
  cache.scoreHistory[coinId].push({
    score: scoreData.score,
    signal: scoreData.signal,
    regime: scoreData.regime,
    strategy: scoreData.strategyName,
    confidence: scoreData.confidence,
    timestamp: Date.now()
  });
  // Keep last 500 entries per coin (~8 hours at 1/min)
  if (cache.scoreHistory[coinId].length > 500) {
    cache.scoreHistory[coinId] = cache.scoreHistory[coinId].slice(-500);
  }
}

function getScoreHistory(coinId) {
  return cache.scoreHistory[coinId] || [];
}

// ====================================================
// REGIME TIMELINE (how often each regime appears over time)
// ====================================================
function recordRegimeSnapshot(regimeCounts) {
  cache.regimeTimeline.push({
    timestamp: Date.now(),
    counts: { ...regimeCounts }
  });
  if (cache.regimeTimeline.length > 200) {
    cache.regimeTimeline = cache.regimeTimeline.slice(-200);
  }
}

function getRegimeTimeline() {
  return cache.regimeTimeline.slice();
}

// ====================================================
// BACKGROUND REFRESH
// ====================================================
async function refreshAllData() {
  if (cache.refreshing) return;
  cache.refreshing = true;
  let successCount = 0;
  console.log('[Refresh] Starting background data refresh...');

  try {
    if (cache.lastRefresh === 0) {
      console.log('[Refresh] Waiting 10s before first API call...');
      await sleep(10000);
    }

    // Step 1: Prices – rotate sources to spread rate limits
    priceSourceRotation = (priceSourceRotation + 1) % 3;
    const tryOrder = priceSourceRotation === 0
      ? ['coingecko', 'coincap', 'bybit', 'kraken']
      : priceSourceRotation === 1
      ? ['coincap', 'bybit', 'coingecko', 'kraken']
      : ['bybit', 'coingecko', 'coincap', 'kraken'];
    let prices = [];
    for (const source of tryOrder) {
      if (prices && prices.length > 0) break;
      try {
        let result = null;
        if (source === 'coingecko') result = await fetchCoinGeckoPricesOnce();
        else if (source === 'coincap') result = await fetchPricesFromCoinCap();
        else if (source === 'bybit') result = await fetchPricesFromBybit();
        else if (source === 'kraken') result = await fetchPricesFromKraken();
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
        console.log(`[Refresh] Skipping partial price update (got ${prices.length}, need ${minCoins}; keeping ${prevCount})`);
      }
    } else {
      console.log('[Refresh] No prices from any API – keeping previous');
    }
    if (pricesReadyResolve) {
      pricesReadyResolve();
      pricesReadyResolve = null;
    }

    // Step 2: OHLCV candles – Bybit primary, Kraken fallback
    for (const coinId of TRACKED_COINS) {
      try {
        await sleep(BYBIT_DELAY);
        const candles = await fetchAllCandlesForCoin(coinId);
        if (candles) {
          cache.candles[coinId] = candles;
          successCount++;
          console.log(`[Refresh] Candles: ${COIN_META[coinId].symbol} (${successCount}/${TRACKED_COINS.length}) [${candles._source || 'unknown'}]`);
        }
      } catch (err) {
        console.error(`[Refresh] Candles failed for ${coinId}: ${err.message}`);
      }
    }

    // Step 3: CoinGecko history as fallback for coins without candles
    const coinsNeedingHistory = TRACKED_COINS.filter(id => !cache.candles[id]);
    for (const coinId of coinsNeedingHistory) {
      try {
        await sleep(COINGECKO_DELAY);
        const history = await fetchHistoryOnce(coinId, 7);
        cache.history[coinId] = history;
        console.log(`[Refresh] CG history: ${COIN_META[coinId].symbol}`);
      } catch (err) {
        if (err.message && err.message.includes('429')) {
          console.log('[Refresh] CoinGecko rate limited – waiting 25s...');
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

    // Step 4: Funding rates from Bybit (linear perpetuals)
    await fetchFundingRates();

    cache.lastRefresh = Date.now();
    console.log(`[Refresh] Complete. ${successCount}/${TRACKED_COINS.length} coins with OHLCV candles.`);
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

/** Fetch live price for one coin. Tries WebSocket -> Bybit -> Kraken -> cache. */
async function fetchLivePrice(coinId) {
  // WebSocket (real-time, free) - try first when available
  try {
    const ws = require('./websocket-prices');
    const p = ws.getWebSocketPrice(coinId);
    if (p && Number.isFinite(p.price) && p.price > 0) return p.price;
  } catch (e) { /* WS not available */ }

  const meta = COIN_META[coinId];

  // Try Bybit REST
  if (meta && meta.bybit) {
    try {
      const url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${meta.bybit}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 8000 });
      if (res.ok) {
        const json = await res.json();
        if (json.retCode === 0 && json.result && json.result.list && json.result.list[0]) {
          const price = parseFloat(json.result.list[0].lastPrice);
          if (Number.isFinite(price) && price > 0) return price;
        }
      }
    } catch (err) { /* fall through */ }
  }

  // Fallback: Kraken
  const krakenPair = KRAKEN_PAIRS[coinId];
  if (krakenPair) {
    try {
      const url = `https://api.kraken.com/0/public/Ticker?pair=${krakenPair}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 8000 });
      if (res.ok) {
        const json = await res.json();
        const result = json.result || {};
        const t = result[krakenPair];
        if (t && t.c) {
          const price = parseFloat(t.c[0]);
          if (Number.isFinite(price) && price > 0) return price;
        }
      }
    } catch (err) { /* fall through to cache */ }
  }

  // Last resort: cache
  const cached = getCurrentPrice(coinId);
  return cached && Number.isFinite(cached.price) ? cached.price : null;
}

// ====================================================
// FUNDING RATES (Bybit Linear Perpetuals - free, no key)
// ====================================================
async function fetchFundingRates() {
  try {
    for (const coinId of TRACKED_COINS) {
      const meta = COIN_META[coinId];
      if (!meta || !meta.bybit) continue;
      try {
        const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${meta.bybit}&limit=1`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 8000 });
        if (!res.ok) continue;
        const json = await res.json();
        if (json.retCode !== 0 || !json.result || !json.result.list || json.result.list.length === 0) continue;
        const item = json.result.list[0];
        if (item.fundingRate != null) {
          cache.fundingRates[coinId] = {
            rate: parseFloat(item.fundingRate),
            time: Date.now()
          };
        }
        await sleep(100); // Small delay between calls
      } catch (err) {
        // Skip individual coin failures
      }
    }
    console.log(`[Refresh] Funding rates updated for ${Object.keys(cache.fundingRates).length} coins (Bybit)`);
  } catch (err) {
    console.error('[Refresh] Funding rates failed:', err.message);
  }
}

function getFundingRate(coinId) {
  return cache.fundingRates[coinId] || null;
}

function getAllFundingRates() {
  return { ...cache.fundingRates };
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
console.log('[CryptoAPI] Starting initial data fetch (Bybit + Kraken + CoinGecko)...');
refreshAllData().catch(err => console.error('[CryptoAPI] Initial error:', err.message));

module.exports = {
  fetchAllPrices, fetchPriceHistory, fetchAllHistory,
  fetchCandles, fetchAllCandles, fetchAllCandlesForCoin, fetchHistoricalCandlesForCoin, fetchHistoricalKrakenCandles, getCurrentPrice, fetchLivePrice, isDataReady,
  getFundingRate, getAllFundingRates,
  isCandleFresh, getCandleSource, getCandleAge,
  recordScoreHistory, getScoreHistory,
  recordRegimeSnapshot, getRegimeTimeline,
  pricesReadyPromise,
  TRACKED_COINS, COIN_META
};
