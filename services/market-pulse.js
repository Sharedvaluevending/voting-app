// services/market-pulse.js
// ====================================================
// MARKET PULSE - Market-news-analyst skill inspired
// Fear & Greed Index, BTC dominance, market overview.
// ====================================================

const fetch = require('node-fetch');

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 min
let cache = { data: null, fetchedAt: 0 };

async function fetchFearGreed() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1', { timeout: 8000 });
    if (!res.ok) return null;
    const json = await res.json();
    const d = json.data && json.data[0];
    if (!d) return null;
    return {
      value: parseInt(d.value, 10) || 0,
      classification: d.value_classification || 'Unknown',
      timestamp: d.timestamp ? parseInt(d.timestamp, 10) * 1000 : null
    };
  } catch (e) {
    console.warn('[MarketPulse] Fear & Greed fetch failed:', e.message);
    return null;
  }
}

async function fetchGlobalData() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/global', { timeout: 10000 });
    if (res.status === 429) return null;
    if (!res.ok) return null;
    const json = await res.json();
    const d = json.data;
    if (!d) return null;
    const btcPct = d.market_cap_percentage && d.market_cap_percentage.btc;
    const ethPct = d.market_cap_percentage && d.market_cap_percentage.eth;
    return {
      btcDominance: btcPct != null ? Number(btcPct) : null,
      ethDominance: ethPct != null ? Number(ethPct) : null,
      marketCapChange24h: d.market_cap_change_percentage_24h_usd != null ? Number(d.market_cap_change_percentage_24h_usd) : null,
      volumeChange24h: d.volume_change_percentage_24h_usd != null ? Number(d.volume_change_percentage_24h_usd) : null,
      totalMarketCapUsd: d.total_market_cap && d.total_market_cap.usd ? Number(d.total_market_cap.usd) : null
    };
  } catch (e) {
    console.warn('[MarketPulse] Global fetch failed:', e.message);
    return null;
  }
}

async function getMarketPulse() {
  if (cache.data && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  const [fearGreed, global] = await Promise.all([
    fetchFearGreed(),
    fetchGlobalData()
  ]);
  const data = {
    fearGreed: fearGreed || { value: null, classification: 'N/A' },
    global: global || {},
    fetchedAt: Date.now()
  };
  cache = { data, fetchedAt: Date.now() };
  return data;
}

module.exports = { getMarketPulse, fetchFearGreed, fetchGlobalData };
