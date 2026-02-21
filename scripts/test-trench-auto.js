#!/usr/bin/env node
/**
 * Test Trench Auto - fetches trendings (DexScreener + Mobula), simulates merged scan
 * Run: node scripts/test-trench-auto.js
 */
const dexscreener = require('../services/dexscreener-api');
const mobula = require('../services/mobula-api');

async function main() {
  console.log('=== Trench Auto Test (100+ tokens in chunks) ===\n');

  console.log('1. DexScreener (boosts + takeovers + ads, limit 150)...');
  const dex = await dexscreener.fetchSolanaTrendings(150);
  console.log('   Got', dex.length, 'tokens with prices');
  if (dex.length > 0) {
    console.log('   Top 3:', dex.slice(0, 3).map((t) => t.symbol + ' $' + t.price + ' ' + (t.priceChange24h || 0) + '%').join(' | '));
  }

  console.log('\n2. Mobula (Dexscreener + LamboTrendings + CoinGecko)...');
  let mobTokens = [];
  try {
    mobTokens = await (mobula.fetchMetaTrendingsMulti || mobula.fetchMetaTrendings)('solana');
  } catch (e) {
    console.log('   Mobula failed:', e.message);
  }
  const mobSol = mobTokens.filter((t) => t.tokenAddress && t.price > 0);
  console.log('   Got', mobSol.length, 'Solana tokens with price');
  if (mobSol.length > 0) {
    console.log('   Top 3:', mobSol.slice(0, 3).map((t) => t.symbol + ' $' + t.price).join(' | '));
  }

  const seen = new Map();
  for (const t of dex) seen.set(t.tokenAddress, t);
  for (const t of mobSol) {
    if (!seen.has(t.tokenAddress)) seen.set(t.tokenAddress, { ...t, trendingScore: t.trendingScore || 1 });
  }
  const merged = Array.from(seen.values()).sort((a, b) => (b.priceChange24h || 0) - (a.priceChange24h || 0));

  console.log('\n3. Merged (DexScreener + Mobula, deduped):', merged.length, 'tokens');
  if (merged.length > 0) {
    console.log('   Would consider:', merged.slice(0, 5).map((t) => t.symbol).join(', '));
    const lowCap = merged.filter((t) => t.price > 0 && t.price < 0.01);
    console.log('   Sub-$0.01 (dev/memecoins):', lowCap.length, 'tokens');
  }

  console.log('\n=== Test OK ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
