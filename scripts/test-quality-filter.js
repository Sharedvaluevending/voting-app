#!/usr/bin/env node
require('dotenv').config();
const dexscreener = require('../services/dexscreener-api');

function scoreCandidate(t) {
  const change = t.priceChange24h || 0;
  const vol = t.volume24h || 0;
  const liq = t.liquidity || 0;
  const buyPressure = t.buyPressure || 0.5;
  const organicScore = t.organicScore || 0;

  if (change > 500) return -1;
  if (change < -25) return -1;
  if (vol < 15000) return -1;
  if (liq < 8000) return -1;
  if (buyPressure < 0.35) return -1;

  let score = 0;
  if (change >= 5 && change <= 50) score += 30;
  else if (change > 50 && change <= 100) score += 25;
  else if (change > 100 && change <= 200) score += 20;
  else if (change > 200 && change <= 500) score += 10;
  else if (change >= 0 && change < 5) score += 8;

  if (vol >= 200000) score += 25;
  else if (vol >= 100000) score += 20;
  else if (vol >= 50000) score += 15;
  else if (vol >= 15000) score += 10;
  else score += 3;

  if (liq >= 100000) score += 20;
  else if (liq >= 50000) score += 16;
  else if (liq >= 25000) score += 12;
  else if (liq >= 8000) score += 8;
  else score += 2;

  if (buyPressure >= 0.6) score += 15;
  else if (buyPressure >= 0.55) score += 10;
  else if (buyPressure >= 0.5) score += 5;

  if (organicScore >= 80) score += 15;
  else if (organicScore >= 50) score += 10;
  else if (organicScore >= 20) score += 5;

  return score;
}

async function main() {
  console.log('Fetching tokens...');
  const tokens = await dexscreener.fetchSolanaTrendings(500);

  let passed = 0, rejected = 0;
  const rejectReasons = { highChange: 0, lowChange: 0, lowVol: 0, lowLiq: 0, lowBuyP: 0 };

  const scored = [];
  for (const t of tokens) {
    const change = t.priceChange24h || 0;
    const vol = t.volume24h || 0;
    const liq = t.liquidity || 0;
    const bp = t.buyPressure || 0.5;

    const s = scoreCandidate(t);
    if (s > 0) {
      passed++;
      scored.push({ ...t, _score: s });
    } else {
      rejected++;
      if (change > 500) rejectReasons.highChange++;
      else if (change < -25) rejectReasons.lowChange++;
      else if (vol < 15000) rejectReasons.lowVol++;
      else if (liq < 8000) rejectReasons.lowLiq++;
      else if (bp < 0.35) rejectReasons.lowBuyP++;
    }
  }

  scored.sort((a, b) => b._score - a._score);

  console.log(`\n=== QUALITY FILTER RESULTS ===`);
  console.log(`Total tokens:  ${tokens.length}`);
  console.log(`Passed:        ${passed}`);
  console.log(`Rejected:      ${rejected}`);
  console.log(`\nReject reasons:`);
  console.log(`  24h change > 500%: ${rejectReasons.highChange}`);
  console.log(`  24h change < -25%: ${rejectReasons.lowChange}`);
  console.log(`  Volume < $15k:     ${rejectReasons.lowVol}`);
  console.log(`  Liquidity < $8k:   ${rejectReasons.lowLiq}`);
  console.log(`  Buy pressure <35%: ${rejectReasons.lowBuyP}`);

  console.log(`\n=== TOP 15 CANDIDATES ===`);
  scored.slice(0, 15).forEach((t, i) => {
    const bp = t.buyPressure ? `bp:${(t.buyPressure * 100).toFixed(0)}%` : 'bp:n/a';
    const os = t.organicScore ? `org:${Math.round(t.organicScore)}` : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${(t.symbol || '').padEnd(12)} score:${t._score} 24h:${(t.priceChange24h || 0).toFixed(1).padStart(7)}% vol:$${Math.round((t.volume24h || 0) / 1000)}k liq:$${Math.round((t.liquidity || 0) / 1000)}k ${bp} ${os} [${t.source}]`);
  });

  // Also check how many pass the max24h=500% entry filter (now properly applied)
  const afterMax24h = scored.filter(t => (t.priceChange24h || 0) < 500);
  console.log(`\n=== AFTER maxPriceChange24h < 500% FILTER ===`);
  console.log(`Remaining: ${afterMax24h.length} (removed ${scored.length - afterMax24h.length} more)`);
}

main().catch(e => { console.error(e); process.exit(1); });
