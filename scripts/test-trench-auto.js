#!/usr/bin/env node
/**
 * Test Trench Auto - fetches trendings and simulates run (no DB)
 * Run: node scripts/test-trench-auto.js
 */
const dexscreener = require('../services/dexscreener-api');
const mobula = require('../services/mobula-api');

async function main() {
  console.log('=== Trench Auto Test ===\n');

  console.log('1. DexScreener trendings...');
  const dex = await dexscreener.fetchSolanaTrendings(5);
  console.log('   Got', dex.length, 'tokens');
  if (dex.length > 0) {
    console.log('   Top:', dex[0].symbol, 'price=$' + dex[0].price);
  }

  console.log('\n2. Mobula trendings (fallback)...');
  const mob = await mobula.fetchMetaTrendings('solana');
  const mobSol = mob.filter((t) => t.tokenAddress && t.price > 0);
  console.log('   Got', mobSol.length, 'Solana tokens with price');
  if (mobSol.length > 0) {
    console.log('   Top:', mobSol[0].symbol, 'price=$' + mobSol[0].price);
  }

  console.log('\n3. Combined: Using DexScreener first,', dex.length, 'tokens');
  const valid = dex.length > 0 ? dex : mobSol;
  console.log('   Valid for trading:', valid.length);
  if (valid.length > 0) {
    console.log('   Would buy:', valid.slice(0, 3).map((t) => t.symbol).join(', '));
  }

  console.log('\n=== Test OK ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
