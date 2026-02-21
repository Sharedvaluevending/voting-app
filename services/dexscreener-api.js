// services/dexscreener-api.js
// ====================================================
// DEXSCREENER + GECKOTERMINAL - Broad Solana token scanning
// DexScreener: 5 endpoints (boosts, top boosts, profiles, takeovers, ads)
// GeckoTerminal: trending pools, new pools, top pools
// No API key needed, 60 req/min per DexScreener endpoint
// ====================================================

const fetch = require('node-fetch');

const DEX_BASE = 'https://api.dexscreener.com';
const GT_BASE = 'https://api.geckoterminal.com/api/v2';

// ====================================================
// DEXSCREENER ENDPOINTS
// ====================================================

async function fetchTokenBoosts(chainId = 'solana') {
  const res = await fetch(`${DEX_BASE}/token-boosts/latest/v1`, { timeout: 10000 });
  if (!res.ok) throw new Error(`DexScreener boosts: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter((t) => (t.chainId || '').toLowerCase() === chainId.toLowerCase());
}

async function fetchTopBoosts(chainId = 'solana') {
  try {
    const res = await fetch(`${DEX_BASE}/token-boosts/top/v1`, { timeout: 10000 });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((t) => (t.chainId || '').toLowerCase() === chainId.toLowerCase());
  } catch (e) {
    return [];
  }
}

async function fetchTokenProfiles(chainId = 'solana') {
  try {
    const res = await fetch(`${DEX_BASE}/token-profiles/latest/v1`, { timeout: 10000 });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((t) => (t.chainId || '').toLowerCase() === chainId.toLowerCase());
  } catch (e) {
    return [];
  }
}

async function fetchCommunityTakeovers(chainId = 'solana') {
  const res = await fetch(`${DEX_BASE}/community-takeovers/latest/v1`, { timeout: 10000 });
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter((t) => (t.chainId || '').toLowerCase() === chainId.toLowerCase());
}

async function fetchAds(chainId = 'solana') {
  try {
    const res = await fetch(`${DEX_BASE}/ads/latest/v1`, { timeout: 10000 });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((t) => (t.chainId || '').toLowerCase() === chainId.toLowerCase());
  } catch (e) {
    return [];
  }
}

async function fetchTokenPairs(chainId, tokenAddress) {
  const res = await fetch(`${DEX_BASE}/token-pairs/v1/${chainId}/${tokenAddress}`, { timeout: 8000 });
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
    volume24h: parseFloat(pair.volume?.h24) || 0,
    liquidity: parseFloat(pair.liquidity?.usd) || 0,
    trendingScore: 1,
    logo: pair.info?.imageUrl || ''
  };
}

// Bulk fetch token data - up to 30 addresses per call
async function fetchTokensBulk(chainId, tokenAddresses) {
  if (!tokenAddresses || tokenAddresses.length === 0) return [];
  const results = [];
  const chunkSize = 30;
  for (let i = 0; i < tokenAddresses.length; i += chunkSize) {
    const chunk = tokenAddresses.slice(i, i + chunkSize);
    try {
      const url = `${DEX_BASE}/tokens/v1/${chainId}/${chunk.join(',')}`;
      const res = await fetch(url, { timeout: 15000 });
      if (!res.ok) continue;
      const pairs = await res.json();
      if (!Array.isArray(pairs)) continue;
      const seen = new Set();
      for (const pair of pairs) {
        const base = pair.baseToken || {};
        const addr = base.address;
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        const priceUsd = parseFloat(pair.priceUsd);
        if (!priceUsd || priceUsd <= 0) continue;
        results.push({
          tokenAddress: addr,
          symbol: base.symbol || '?',
          name: base.name || '',
          price: priceUsd,
          priceChange24h: pair.priceChange?.h24 ?? pair.priceChange?.h6 ?? 0,
          volume24h: parseFloat(pair.volume?.h24) || 0,
          liquidity: parseFloat(pair.liquidity?.usd) || 0,
          trendingScore: 1,
          logo: pair.info?.imageUrl || ''
        });
      }
      if (i + chunkSize < tokenAddresses.length) await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn(`[DexScreener] Bulk fetch chunk error:`, e.message);
    }
  }
  return results;
}

async function fetchTokenPairsBatch(chainId, tokenAddresses, opts = {}) {
  return fetchTokensBulk(chainId, tokenAddresses);
}

// ====================================================
// GECKOTERMINAL - Trending, new, and top pools
// ====================================================

async function fetchGeckoTerminalPools(endpoint, maxPages = 3) {
  const tokens = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${GT_BASE}/networks/solana/${endpoint}?page=${page}`;
      const res = await fetch(url, { timeout: 10000 });
      if (!res.ok) break;
      const json = await res.json();
      if (json.status?.error_code) break;
      const pools = json.data || [];
      if (pools.length === 0) break;
      for (const pool of pools) {
        const a = pool.attributes || {};
        const baseToken = pool.relationships?.base_token?.data;
        if (!baseToken) continue;
        const addr = (baseToken.id || '').replace('solana_', '');
        if (!addr) continue;
        const price = parseFloat(a.base_token_price_usd);
        if (!price || price <= 0) continue;
        tokens.push({
          tokenAddress: addr,
          symbol: a.name ? a.name.split(' / ')[0] || '?' : '?',
          name: a.name || '',
          price,
          priceChange24h: parseFloat(a.price_change_percentage?.h24) || 0,
          volume24h: parseFloat(a.volume_usd?.h24) || 0,
          liquidity: parseFloat(a.reserve_in_usd) || 0,
          trendingScore: 1,
          source: 'geckoterminal'
        });
      }
      if (pools.length < 20) break;
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      break;
    }
  }
  return tokens;
}

// ====================================================
// MAIN: Fetch all Solana trending tokens from every source
// ====================================================

async function fetchSolanaTrendings(limit = 300) {
  // Phase 1: Collect token addresses from all DexScreener endpoints
  const [boosts, topBoosts, profiles, takeovers, ads] = await Promise.all([
    fetchTokenBoosts('solana').catch(() => []),
    fetchTopBoosts('solana').catch(() => []),
    fetchTokenProfiles('solana').catch(() => []),
    fetchCommunityTakeovers('solana').catch(() => []),
    fetchAds('solana').catch(() => [])
  ]);

  const seen = new Set();
  const dexAddresses = [];
  for (const t of [...boosts, ...topBoosts, ...profiles, ...takeovers, ...ads]) {
    if (t.tokenAddress && !seen.has(t.tokenAddress)) {
      seen.add(t.tokenAddress);
      dexAddresses.push(t.tokenAddress);
    }
  }

  console.log(`[DexScreener] ${dexAddresses.length} unique Solana tokens from 5 endpoints (boosts:${boosts.length} top:${topBoosts.length} profiles:${profiles.length} takeovers:${takeovers.length} ads:${ads.length})`);

  // Phase 2: Fetch GeckoTerminal trending + new pools in parallel
  const [gtTrending, gtNew, gtTop] = await Promise.all([
    fetchGeckoTerminalPools('trending_pools', 3).catch(() => []),
    fetchGeckoTerminalPools('new_pools', 3).catch(() => []),
    fetchGeckoTerminalPools('pools?sort=h24_tx_count_desc', 2).catch(() => [])
  ]);

  const gtTokens = [...gtTrending, ...gtNew, ...gtTop];
  console.log(`[GeckoTerminal] ${gtTokens.length} pools (trending:${gtTrending.length} new:${gtNew.length} top:${gtTop.length})`);

  // Phase 3: Bulk fetch prices for DexScreener tokens (fast, 30 at a time)
  const toFetch = dexAddresses.slice(0, Math.min(limit, 300));
  const dexTokens = await fetchTokensBulk('solana', toFetch);

  // Phase 4: Merge all sources, dedup by address
  const merged = new Map();
  for (const t of dexTokens) {
    if (t.tokenAddress && t.price > 0) merged.set(t.tokenAddress, t);
  }
  for (const t of gtTokens) {
    if (t.tokenAddress && t.price > 0 && !merged.has(t.tokenAddress)) {
      merged.set(t.tokenAddress, t);
    }
  }

  const result = Array.from(merged.values())
    .sort((a, b) => (b.priceChange24h || 0) - (a.priceChange24h || 0));

  console.log(`[Scanner] Total unique tokens with prices: ${result.length}`);
  return result;
}

module.exports = {
  fetchTokenBoosts,
  fetchTopBoosts,
  fetchTokenProfiles,
  fetchTokenPairs,
  fetchCommunityTakeovers,
  fetchAds,
  fetchSolanaTrendings,
  fetchTokensBulk
};
