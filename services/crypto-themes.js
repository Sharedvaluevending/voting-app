// services/crypto-themes.js
// ====================================================
// CRYPTO THEME DETECTOR - Theme-detector skill inspired
// Fetches CoinGecko categories, computes theme heat (momentum), returns top themes.
// Used to boost signals for coins in trending sectors (featureThemeDetector).
// ====================================================

const fetch = require('node-fetch');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
let cache = { data: null, fetchedAt: 0 };

async function fetchCategoriesWithMarketData() {
  try {
    const url = 'https://api.coingecko.com/api/v3/coins/categories?order=market_cap_desc';
    const res = await fetch(url, { headers: { Accept: 'application/json' }, timeout: 15000 });
    if (res.status === 429) throw new Error('Rate limited');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[CryptoThemes] Fetch failed:', e.message);
    return [];
  }
}

/**
 * Compute theme heat (0-100) from market_cap_change_24h and volume.
 * Bullish = positive change, bearish = negative.
 */
function computeThemeHeat(cat) {
  const change = Number(cat.market_cap_change_24h) || 0;
  const vol = Number(cat.volume_24h) || 0;
  const mcap = Number(cat.market_cap) || 1;
  const volRatio = mcap > 0 ? vol / mcap : 0;
  // Heat: direction-neutral strength. Use abs(change) + volume factor
  const momentum = Math.min(100, Math.abs(change) * 2 + (volRatio > 0.1 ? 10 : 0));
  return {
    heat: Math.round(Math.min(100, momentum)),
    direction: change >= 0 ? 'bullish' : 'bearish',
    change24h: change
  };
}

/**
 * Get top crypto themes by momentum. Returns themes with heat, direction, top coins.
 */
async function getCryptoThemes(limit = 12) {
  if (cache.data && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  const raw = await fetchCategoriesWithMarketData();
  const themes = raw
    .filter(c => c.market_cap > 1e6 && ((c.top_3_coins_id || c.top_3_coins || []).length > 0))
    .map(c => {
      const { heat, direction, change24h } = computeThemeHeat(c);
      const topIds = c.top_3_coins_id || [];
      const topFromUrls = (c.top_3_coins || []).map(url => {
        const m = (url || '').match(/\/([a-z0-9-]+)\.(png|svg|webp)/i);
        return m ? m[1] : null;
      }).filter(Boolean);
      const topCoins = topIds.length > 0 ? topIds : topFromUrls;
      return {
        id: c.category_id || c.id,
        name: c.name || c.category_id,
        heat,
        direction,
        change24h,
        marketCap: c.market_cap,
        volume24h: c.volume_24h,
        topCoins
      };
    })
    .sort((a, b) => b.heat - a.heat)
    .slice(0, limit);
  cache = { data: themes, fetchedAt: Date.now() };
  return themes;
}

/**
 * Get set of coin IDs that are in top-performing (bullish) themes.
 * Used to boost signal score when featureThemeDetector is enabled.
 */
async function getHotThemeCoinIds(topN = 5) {
  const themes = await getCryptoThemes(20);
  const bullish = themes.filter(t => t.direction === 'bullish').slice(0, topN);
  const ids = new Set();
  bullish.forEach(t => {
    (t.topCoins || []).forEach(coinId => ids.add(coinId));
  });
  return ids;
}

module.exports = {
  getCryptoThemes,
  getHotThemeCoinIds,
  fetchCategoriesWithMarketData
};
