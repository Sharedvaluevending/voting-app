// services/dexscreener-api.js
// ====================================================
// DEXSCREENER API - Token boosts, community takeovers
// No API key, 300 req/min, Solana memecoins
// ====================================================

const fetch = require('node-fetch');

const BASE = 'https://api.dexscreener.com';

async function fetchTokenBoosts(chainId = 'solana') {
  const res = await fetch(`${BASE}/token-boosts/latest/v1`, { timeout: 10000 });
  if (!res.ok) throw new Error(`DexScreener boosts: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter((t) => (t.chainId || '').toLowerCase() === chainId.toLowerCase());
}

async function fetchTokenPairs(chainId, tokenAddress) {
  const res = await fetch(`${BASE}/token-pairs/v1/${chainId}/${tokenAddress}`, { timeout: 8000 });
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const pair = data[0];
  const base = pair.baseToken || {};
  const priceUsd = parseFloat(pair.priceUsd);
  const priceChange = pair.priceChange?.h24 ?? pair.priceChange?.h6 ?? 0;
  return {
    tokenAddress: base.address || tokenAddress,
    symbol: base.symbol || '?',
    name: base.name || '',
    price: priceUsd > 0 ? priceUsd : 0,
    priceChange24h: typeof priceChange === 'number' ? priceChange : 0,
    trendingScore: 1,
    logo: pair.info?.imageUrl || ''
  };
}

async function fetchSolanaTrendings(limit = 10) {
  const boosts = await fetchTokenBoosts('solana');
  const tokens = boosts.slice(0, limit);
  const results = [];
  for (const t of tokens) {
    try {
      const pair = await fetchTokenPairs('solana', t.tokenAddress);
      if (pair && pair.price > 0) {
        results.push(pair);
      }
    } catch (e) {
      /* skip */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return results;
}

module.exports = {
  fetchTokenBoosts,
  fetchTokenPairs,
  fetchSolanaTrendings
};
