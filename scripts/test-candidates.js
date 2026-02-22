#!/usr/bin/env node
/**
 * Test candidate count - uses same pipeline as trench bot
 * Run: node scripts/test-candidates.js
 */
require('dotenv').config();

const dexscreener = require('../services/dexscreener-api');
const mobula = require('../services/mobula-api');
const trench = require('../services/trench-auto-trading');

const MIN_QUALITY_SCORE = 65;

async function main() {
  console.log('Fetching tokens (DexScreener 800 + GeckoTerminal + Jupiter)...');
  const trendings = await dexscreener.fetchSolanaTrendings(800);
  console.log(`  Raw from DexScreener: ${trendings.length} tokens`);

  let mobulaTokens = [];
  try {
    mobulaTokens = await (mobula.fetchMetaTrendingsMulti || mobula.fetchMetaTrendings)('solana');
    console.log(`  Mobula: ${mobulaTokens.length} tokens`);
  } catch (e) {
    console.log(`  Mobula: failed (${e.message})`);
  }

  const seen = new Map();
  for (const t of trendings) {
    if (t.tokenAddress && t.price > 0) seen.set(t.tokenAddress, t);
  }
  for (const t of mobulaTokens) {
    if (t.tokenAddress && t.price > 0 && !seen.has(t.tokenAddress)) {
      seen.set(t.tokenAddress, t);
    }
  }
  console.log(`  After merge: ${seen.size} unique tokens`);

  // Enrich non-Jupiter tokens (first 50)
  const toEnrich = Array.from(seen.values()).filter(t =>
    t.source !== 'jupiter' && !t.buyVolume1h && !t.sellVolume1h &&
    t.tokenAddress && ((t.priceChange1h != null) || (t.priceChange24h != null && (t.priceChange24h || 0) > 0)) && (t.volume24h || 0) >= 15000
  ).slice(0, 50);
  if (toEnrich.length > 0) {
    console.log(`  Enriching ${toEnrich.length} non-Jupiter tokens with Mobula...`);
    const chunkSize = 5;
    for (let i = 0; i < toEnrich.length; i += chunkSize) {
      const chunk = toEnrich.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async (t) => {
        try {
          const mk = await mobula.getTokenMarkets('solana', t.tokenAddress);
          if (mk && (mk.volumeBuy1hUSD || mk.volumeSell1hUSD)) {
            t.buyVolume1h = mk.volumeBuy1hUSD || 0;
            t.sellVolume1h = mk.volumeSell1hUSD || 0;
            if (t.priceChange1h == null && typeof mk.priceChange1hPercentage === 'number') {
              t.priceChange1h = mk.priceChange1hPercentage;
            }
          }
        } catch (e) { /* skip */ }
      }));
      if (i + chunkSize < toEnrich.length) await new Promise(r => setTimeout(r, 150));
    }
  }

  const all = Array.from(seen.values());
  const scored = all.map(t => {
    t._qualityScore = trench.scoreCandidate(t);
    return t;
  }).filter(t => t._qualityScore >= MIN_QUALITY_SCORE);

  const softPass = all.filter(t => (t._qualityScore || 0) > 0).length;
  const rejected = all.filter(t => (t._qualityScore || 0) <= 0).length;

  console.log('\n=== CANDIDATE RESULTS ===');
  console.log(`Total unique:     ${all.length}`);
  console.log(`Score > 0:        ${softPass} (pass hard filters)`);
  console.log(`Score >= ${MIN_QUALITY_SCORE}:  ${scored.length} CANDIDATES`);
  console.log(`Rejected:         ${rejected}`);

  if (scored.length > 0) {
    scored.sort((a, b) => b._qualityScore - a._qualityScore);
    console.log('\n=== TOP 20 CANDIDATES ===');
    scored.slice(0, 20).forEach((t, i) => {
      const ch = t.priceChange5m != null ? `5m:${(t.priceChange5m).toFixed(1)}%` : (t.priceChange1h != null ? `1h:${(t.priceChange1h).toFixed(1)}%` : '—');
      const bp = t.buyPressure ? (t.buyPressure * 100).toFixed(0) + '%' : 'n/a';
      console.log(`  ${String(i + 1).padStart(2)}. ${(t.symbol || '?').padEnd(12)} score:${t._qualityScore} ${ch} bp:${bp} vol:$${Math.round((t.volume24h || 0) / 1000)}k [${t.source || '?'}]`);
    });
  }

  const GOOD_THRESHOLD = 15;
  if (scored.length < GOOD_THRESHOLD) {
    console.log(`\n⚠️  Few high-quality candidates (want ${GOOD_THRESHOLD}+ with score >= ${MIN_QUALITY_SCORE})`);
  } else {
    console.log(`\n✓  ${scored.length} high-quality candidates (score >= ${MIN_QUALITY_SCORE})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
