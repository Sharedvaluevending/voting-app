// services/market-scanner.js
// ====================================================
// WHOLE-MARKET SCANNER - Main app (not Trench Warfare)
// Scans top coins by market cap, scores with same engine as 20 tracked coins.
// Returns top 3 coins from the whole market (excluding tracked 20).
// Uses CoinGecko /coins/markets + market_chart for full scoring.
// ====================================================

const fetch = require('node-fetch');
const { TRACKED_COINS } = require('./crypto-api');
const { analyzeCoin } = require('./trading-engine');

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const COINGECKO_DELAY_MS = 1500;     // Rate limit: ~40/min
const TOP_MARKET_LIMIT = 80;          // Scan top 80 by market cap
const TOP_PICKS = 3;

const STABLECOINS = [
  'tether', 'usd-coin', 'dai', 'binance-usd', 'true-usd', 'first-digital-usd',
  'paxos-standard', 'frax', 'usdd', 'gemini-dollar', 'paypal-usd', 'ethena-usde'
];
const STABLECOIN_SYMBOLS = ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD', 'USDP', 'FRAX', 'USDD', 'GUSD', 'PYUSD', 'USDE'];

let cache = { top3: [], top3Full: [], fetchedAt: 0, scanning: false, marketHoldState: false };

/** Build engine options for background scan (strategy weights + BTC signal from market data). */
async function buildScannerOptions(marketCoins) {
  const opts = { strategyWeights: [], strategyStats: {}, fundingRates: {} };
  try {
    const StrategyWeight = require('../models/StrategyWeight');
    const sw = await StrategyWeight.find({ active: true }).lean();
    opts.strategyWeights = sw || [];
    sw.forEach(s => { opts.strategyStats[s.strategyId] = { totalTrades: s.performance?.totalTrades || 0 }; });
  } catch (e) { /* DB may be unavailable */ }

  const btcMarket = marketCoins.find(m => m.id === 'bitcoin');
  if (btcMarket) {
    try {
      const btcHistory = await fetchMarketChart('bitcoin', 7);
      const btcData = marketToCoinData(btcMarket);
      const btcSig = analyzeCoin(btcData, null, btcHistory || { prices: [], volumes: [] }, opts);
      opts.btcSignal = btcSig.signal;
      opts.btcDirection = (btcSig.signal === 'STRONG_BUY' || btcSig.signal === 'BUY') ? 'BULL'
        : (btcSig.signal === 'STRONG_SELL' || btcSig.signal === 'SELL') ? 'BEAR' : null;
    } catch (e) { /* ignore */ }
  }
  return opts;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch top coins from CoinGecko /coins/markets (by market cap).
 */
async function fetchTopMarketCoins(limit = TOP_MARKET_LIMIT) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, timeout: 15000 });
  if (res.status === 429) throw new Error('Rate limited');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch CoinGecko market_chart for a coin (prices + volumes for analyzeWithHistory).
 */
async function fetchMarketChart(coinId, days = 7) {
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, timeout: 12000 });
  if (res.status === 429) throw new Error('Rate limited');
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || typeof data !== 'object') return null;
  const prices = Array.isArray(data.prices) ? data.prices : [];
  const totalVolumes = Array.isArray(data.total_volumes) ? data.total_volumes : [];
  return {
    prices: prices.map(([ts, price]) => ({ timestamp: ts, price })),
    volumes: totalVolumes.map(([ts, vol]) => ({ timestamp: ts, volume: vol }))
  };
}

/**
 * Convert CoinGecko market item to coinData format for analyzeCoin.
 */
function marketToCoinData(m) {
  return {
    id: m.id,
    symbol: (m.symbol || '').toUpperCase(),
    name: m.name || m.id,
    price: m.current_price || 0,
    change24h: m.price_change_percentage_24h ?? 0,
    volume24h: m.total_volume || 0,
    marketCap: m.market_cap || 0
  };
}

/**
 * Scan whole market, score with same engine as tracked coins, return top 3.
 * Excludes TRACKED_COINS. Uses user options (strategyWeights, btcSignal, etc.) when provided.
 */
async function scanMarket(options = {}) {
  if (cache.scanning) {
    return cache.top3;
  }
  if (cache.top3.length > 0 && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.top3;
  }

  cache.scanning = true;
  try {
    const marketCoins = await fetchTopMarketCoins();
    const opts = (options && options.strategyWeights) ? options : await buildScannerOptions(marketCoins);
    const outsideTracked = marketCoins.filter(m => {
      if (TRACKED_COINS.includes(m.id)) return false;
      if (STABLECOINS.includes(m.id)) return false;
      if (STABLECOIN_SYMBOLS.includes((m.symbol || '').toUpperCase())) return false;
      return true;
    });
    if (outsideTracked.length === 0) {
      cache.top3 = [];
      cache.top3Full = [];
      cache.fetchedAt = Date.now();
      return [];
    }

    // Limit to top 30 by market cap for history fetch (rate limit friendly)
    const toScore = outsideTracked.slice(0, 30);
    const scored = [];

    for (let i = 0; i < toScore.length; i++) {
      const m = toScore[i];
      const coinData = marketToCoinData(m);
      let history = null;
      try {
        history = await fetchMarketChart(m.id, 7);
        await sleep(COINGECKO_DELAY_MS);
      } catch (e) {
        // Fall through to basic signal
      }

      const sig = analyzeCoin(coinData, null, history || { prices: [], volumes: [] }, opts);
      scored.push({ ...sig, coinData });
    }

    // BTC regime filter: suppress alt longs when BTC STRONG_SELL, alt shorts when BTC STRONG_BUY
    if (opts.btcSignal) {
      scored.forEach(sig => {
        if ((sig.coin?.id || sig.coinData?.id) === 'bitcoin') return;
        if (opts.btcSignal === 'STRONG_SELL' && (sig.signal === 'BUY' || sig.signal === 'STRONG_BUY')) {
          sig.signal = 'HOLD';
          sig.reasoning = (sig.reasoning || []).concat(['BTC strongly bearish – alt longs suppressed']);
        } else if (opts.btcSignal === 'STRONG_BUY' && (sig.signal === 'SELL' || sig.signal === 'STRONG_SELL')) {
          sig.signal = 'HOLD';
          sig.reasoning = (sig.reasoning || []).concat(['BTC strongly bullish – alt shorts suppressed']);
        }
      });
    }

    // Sort by score desc
    scored.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Only pick actionable signals (BUY/SELL/STRONG_BUY/STRONG_SELL) — not HOLD
    const ACTIONABLE = ['BUY', 'SELL', 'STRONG_BUY', 'STRONG_SELL'];
    const actionable = scored.filter(s => ACTIONABLE.includes(s.signal));

    let picks, isMarketHold = false;
    if (actionable.length > 0) {
      picks = actionable.slice(0, TOP_PICKS);
    } else {
      isMarketHold = true;
      picks = scored.slice(0, TOP_PICKS);
      console.log('[MarketScanner] No actionable signals found – whole market in HOLD state');
    }

    const top3 = picks.map(s => ({
      coin: s.coin || s.coinData,
      signal: s.signal,
      score: s.score,
      strategyName: s.strategyName,
      regime: s.regime,
      confluenceLevel: s.confluenceLevel,
      riskReward: s.riskReward
    }));
    const top3Full = picks;

    cache.top3 = top3;
    cache.top3Full = top3Full;
    cache.fetchedAt = Date.now();
    cache.marketHoldState = isMarketHold;
    console.log(`[MarketScanner] Top ${picks.length}: ${top3.map(t => `${t.coin?.symbol}(${t.signal})`).join(', ')}${isMarketHold ? ' [MARKET HOLD]' : ''}`);
    return top3;
  } catch (err) {
    console.error('[MarketScanner] Error:', err.message);
    return cache.top3 || [];
  } finally {
    cache.scanning = false;
  }
}

/**
 * Get cached top 3, or trigger scan if stale/empty.
 */
function getTop3MarketPicks(options) {
  if (cache.top3.length > 0 && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return Promise.resolve(cache.top3);
  }
  return scanMarket(options);
}

/** Sync: return cached top 3 (never blocks; background job keeps it fresh). */
function getTop3Cached() {
  return cache.top3;
}

/** Sync: return full signals for top 3 (for strategy comparison). */
function getTop3FullCached() {
  return cache.top3Full || [];
}

/** Sync: is the entire market in a hold state (no actionable signals found)? */
function isMarketHoldState() {
  return cache.marketHoldState || false;
}

/** Sync: return full signal for top 1 (for auto-trade). Null if empty or top 1 is in TRACKED_COINS. */
function getTop1ForAutoTrade() {
  const full = cache.top3Full || [];
  if (full.length === 0) return null;
  const pick = full[0];
  if (!pick || TRACKED_COINS.includes(pick.coin?.id || pick.coinData?.id)) return null;
  return pick;
}

module.exports = {
  scanMarket,
  getTop3MarketPicks,
  getTop3Cached,
  getTop3FullCached,
  getTop1ForAutoTrade,
  isMarketHoldState,
  TOP_PICKS
};
