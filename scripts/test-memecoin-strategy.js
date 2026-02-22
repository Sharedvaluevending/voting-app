#!/usr/bin/env node
/**
 * Test Memecoin Strategy - fetches trendings, runs memecoin scoring, reports candidate count
 * Run: node scripts/test-memecoin-strategy.js
 * Requires: .env with MONGODB_URI (optional - for fetchTrendingsCached), JUPITER_API_KEY helps
 */
require('dotenv').config();

const dexscreener = require('../services/dexscreener-api');

// Inline the memecoin scoring logic (same as trench-auto-trading)
function scoreCandidatePumpStart(t) {
  const change5m = t.priceChange5m;
  const change1h = t.priceChange1h || 0;
  const vol = t.volume24h || 0;
  const liq = t.liquidity || 0;
  const buyPressure = t.buyPressure || 0.5;
  const buyVol5m = t.buyVolume5m || 0;
  const sellVol5m = t.sellVolume5m || 0;
  const buyVol1h = t.buyVolume1h || 0;
  const sellVol1h = t.sellVolume1h || 0;
  const vol5m = buyVol5m + sellVol5m;
  const vol1h = buyVol1h + sellVol1h;
  const volShort = vol5m > 0 ? vol5m : vol1h;
  const buyDominance = volShort > 0 ? (vol5m > 0 ? buyVol5m : buyVol1h) / volShort : buyPressure;

  if (vol < 1000) return { score: -1, reason: 'vol<1k' };
  if (liq < 3000) return { score: -1, reason: 'liq<3k' };
  if (liq > 0 && vol / liq > 150) return { score: -1, reason: 'vol/liq>150' };
  if (volShort > 0 && buyDominance < 0.25) return { score: -1, reason: 'buyDom<25%' };

  const changeShort = (typeof change5m === 'number' && change5m !== undefined) ? change5m
    : (typeof change1h === 'number' && change1h !== undefined) ? change1h / 12 : 0;
  if (changeShort > 150) return { score: -1, reason: 'change>150%' };
  if (changeShort < -40) return { score: -1, reason: 'change<-40%' };

  let score = 25;
  if (changeShort >= 0.5 && changeShort <= 10) score += 30;
  else if (changeShort > 10 && changeShort <= 25) score += 20;
  else if (changeShort >= 0 && changeShort < 0.5) score += 15;
  else if (changeShort > 25 && changeShort <= 40) score += 10;
  else if (changeShort >= -5 && changeShort < 0) score += 5;

  const avgHourlyVol = vol / 24;
  const volSurge = avgHourlyVol > 0 ? vol1h / avgHourlyVol : 0;
  if (volSurge >= 1.5) score += 15;
  else if (volSurge >= 1) score += 10;
  else if (volSurge >= 0.5) score += 5;

  if (buyDominance >= 0.55) score += 15;
  else if (buyDominance >= 0.48) score += 10;
  else if (buyDominance >= 0.40) score += 5;

  const volVelocity = liq > 0 ? volShort / liq : 0;
  if (volVelocity >= 0.5) score += 10;
  else if (volVelocity >= 0.2) score += 5;

  if (t.source === 'geckoterminal' || (t._sourceCount || 1) <= 1) score += 5;
  const numBuyers = (t.numBuyers5m || 0) > 0 ? t.numBuyers5m : t.numBuyers1h || 0;
  if (numBuyers >= 5) score += 5;
  if (liq >= 50000) score += 5;

  return { score };
}

async function main() {
  console.log('=== Memecoin Strategy Test ===\n');

  console.log('1. Fetching trendings (DexScreener 800)...');
  let trendings = [];
  try {
    trendings = await dexscreener.fetchSolanaTrendings(800);
  } catch (e) {
    console.error('   Failed:', e.message);
    process.exit(1);
  }
  console.log('   Total tokens:', trendings.length);

  const MIN_SCORE = 5;
  const results = [];
  const rejectReasons = {};

  for (const t of trendings) {
    const r = scoreCandidatePumpStart(t);
    if (r.score >= 0) {
      results.push({ ...t, _qualityScore: r.score });
    } else if (r.reason) {
      rejectReasons[r.reason] = (rejectReasons[r.reason] || 0) + 1;
    }
  }

  const passed = results.filter(r => r._qualityScore >= MIN_SCORE);
  passed.sort((a, b) => (b._qualityScore || 0) - (a._qualityScore || 0));

  console.log('\n2. Memecoin scoring (min score', MIN_SCORE + '):');
  console.log('   PASS:', passed.length, 'candidates');
  console.log('   REJECT reasons:', rejectReasons);

  if (passed.length > 0) {
    console.log('\n3. Top 10 candidates:');
    passed.slice(0, 10).forEach((t, i) => {
      const ch = t.priceChange5m ?? t.priceChange1h ?? t.priceChange24h ?? 0;
      const src = t.source || '?';
      console.log(`   ${i + 1}. ${(t.symbol || '?').padEnd(12)} score:${(t._qualityScore || 0).toString().padStart(3)} ch:${ch.toFixed(1)}% src:${src} vol:$${Math.round(t.volume24h || 0)} liq:$${Math.round(t.liquidity || 0)}`);
    });
  }

  if (passed.length < 50) {
    console.log('\n4. LOW CANDIDATE COUNT - check:');
    console.log('   - JUPITER_API_KEY set? (adds 5m data, buy/sell volume)');
    console.log('   - Reject reasons above show which filters are tight');
  }

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
