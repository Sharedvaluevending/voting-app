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

async function fetchCommunityTakeovers(chainId = 'solana') {
  const res = await fetch(`${BASE}/community-takeovers/latest/v1`, { timeout: 10000 });
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter((t) => (t.chainId || '').toLowerCase() === chainId.toLowerCase());
}

async function fetchAds(chainId = 'solana') {
  try {
    const res = await fetch(`${BASE}/ads/latest/v1`, { timeout: 10000 });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((t) => (t.chainId || '').toLowerCase() === chainId.toLowerCase());
  } catch (e) {
    return [];
  }
}

async function fetchTokenPairsBatch(chainId, tokenAddresses, opts = {}) {
  const results = [];
  const batchSize = opts.batchSize ?? 5;
  const delayMs = opts.delayMs ?? 200;
  for (let i = 0; i < tokenAddresses.length; i += batchSize) {
    const chunk = tokenAddresses.slice(i, i + batchSize);
    const pairs = await Promise.all(chunk.map((addr) => fetchTokenPairs(chainId, addr)));
    for (const p of pairs) {
      if (p && p.price > 0) results.push(p);
    }
    if (i + batchSize < tokenAddresses.length) await new Promise((r) => setTimeout(r, delayMs));
  }
  return results;
}

async function fetchSolanaTrendings(limit = 150) {
  const [boosts, takeovers, ads] = await Promise.all([
    fetchTokenBoosts('solana'),
    fetchCommunityTakeovers('solana'),
    fetchAds('solana')
  ]);
  const seen = new Map();
  const tokens = [];
  for (const t of [...boosts, ...takeovers, ...ads]) {
    if (t.tokenAddress && !seen.has(t.tokenAddress)) {
      seen.set(t.tokenAddress, true);
      tokens.push(t);
    }
  }
  const toFetch = tokens.slice(0, Math.min(limit, 200));
  const withPrices = await fetchTokenPairsBatch('solana', toFetch.map((t) => t.tokenAddress));
  return withPrices.sort((a, b) => (b.priceChange24h || 0) - (a.priceChange24h || 0));
}

module.exports = {
  fetchTokenBoosts,
  fetchTokenPairs,
  fetchCommunityTakeovers,
  fetchAds,
  fetchSolanaTrendings
};
