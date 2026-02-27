#!/usr/bin/env node
// Quick test: verify Jupiter API + full token scan
require('dotenv').config();
const dexscreener = require('../services/dexscreener-api');

async function main() {
  console.log('JUPITER_API_KEY set:', !!process.env.JUPITER_API_KEY);
  console.log('Fetching Solana trendings...\n');

  const tokens = await dexscreener.fetchSolanaTrendings(500);

  console.log('\n--- RESULT ---');
  console.log('Total unique tokens with prices:', tokens.length);
  if (tokens.length > 0) {
    console.log('Sample (top 3 by 24h change):');
    tokens.slice(0, 3).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.symbol} $${t.price?.toFixed(8)} 24h: ${(t.priceChange24h || 0).toFixed(1)}% vol: $${((t.volume24h || 0) / 1000).toFixed(0)}k source: ${t.source || 'dex'}`);
    });
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
