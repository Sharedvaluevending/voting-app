#!/usr/bin/env node
require('dotenv').config();
const dexscreener = require('../services/dexscreener-api');

function scoreCandidate(t) {
  const change = t.priceChange24h || 0;
  const change1h = t.priceChange1h || 0;
  const vol = t.volume24h || 0;
  const liq = t.liquidity || 0;
  const buyPressure = t.buyPressure || 0.5;
  const organicScore = t.organicScore || 0;
  const numBuyers1h = t.numBuyers1h || 0;
  const holderCount = t.holderCount || 0;
  const volLiqRatio = liq > 0 ? vol / liq : 0;
  const sourceCount = t._sourceCount || 1;

  if (change > 500) return { score: -1, reason: '24h>500%' };
  if (change < -25) return { score: -1, reason: '24h<-25%' };
  if (vol < 15000) return { score: -1, reason: 'vol<15k' };
  if (liq < 8000) return { score: -1, reason: 'liq<8k' };
  if (buyPressure < 0.35) return { score: -1, reason: 'bp<35%' };
  if (change1h < -10) return { score: -1, reason: '1h<-10%' };
  if (holderCount > 0 && holderCount < 50) return { score: -1, reason: 'holders<50' };
  if (volLiqRatio > 25) return { score: -1, reason: 'vol/liq>25x' };

  let score = 0;
  if (change1h >= 5 && change1h <= 30) score += 25;
  else if (change1h > 30 && change1h <= 60) score += 15;
  else if (change1h >= 1 && change1h < 5) score += 12;
  else if (change1h >= -2 && change1h < 1) score += 5;
  if (change >= 5 && change <= 50) score += 20;
  else if (change > 50 && change <= 100) score += 18;
  else if (change > 100 && change <= 200) score += 12;
  else if (change > 200 && change <= 500) score += 5;
  else if (change >= 0 && change < 5) score += 3;
  if (vol >= 200000) score += 25;
  else if (vol >= 100000) score += 20;
  else if (vol >= 50000) score += 15;
  else if (vol >= 15000) score += 10;
  if (liq >= 100000) score += 20;
  else if (liq >= 50000) score += 16;
  else if (liq >= 25000) score += 12;
  else if (liq >= 8000) score += 8;
  if (volLiqRatio >= 3 && volLiqRatio <= 15) score += 10;
  else if (volLiqRatio >= 1.5 && volLiqRatio < 3) score += 6;
  else if (volLiqRatio >= 0.5 && volLiqRatio < 1.5) score += 3;
  if (buyPressure >= 0.6) score += 15;
  else if (buyPressure >= 0.55) score += 10;
  else if (buyPressure >= 0.5) score += 5;
  if (organicScore >= 80) score += 15;
  else if (organicScore >= 50) score += 10;
  else if (organicScore >= 20) score += 5;
  if (numBuyers1h >= 50) score += 10;
  else if (numBuyers1h >= 20) score += 6;
  else if (numBuyers1h >= 5) score += 3;
  if (holderCount >= 1000) score += 10;
  else if (holderCount >= 500) score += 7;
  else if (holderCount >= 200) score += 4;
  else if (holderCount >= 50) score += 1;
  if (t.isVerified) score += 5;
  if (sourceCount >= 3) score += 8;
  else if (sourceCount >= 2) score += 4;
  return { score, reason: null };
}

async function main() {
  const tokens = await dexscreener.fetchSolanaTrendings(500);
  const rejects = {};
  const passed = [];
  for (const t of tokens) {
    const r = scoreCandidate(t);
    if (r.score > 0) { t._score = r.score; passed.push(t); }
    else { rejects[r.reason] = (rejects[r.reason] || 0) + 1; }
  }
  passed.sort((a, b) => b._score - a._score);

  console.log(`\n=== FILTER RESULTS ===`);
  console.log(`Total scanned: ${tokens.length}`);
  console.log(`Passed:        ${passed.length}`);
  console.log(`Rejected:      ${tokens.length - passed.length}`);
  console.log(`\nReject breakdown:`);
  Object.entries(rejects).sort((a, b) => b[1] - a[1]).forEach(([r, c]) => console.log(`  ${r}: ${c}`));

  const multiSrc = passed.filter(t => (t._sourceCount || 1) >= 2).length;
  const verified = passed.filter(t => t.isVerified).length;
  const withHolders = passed.filter(t => (t.holderCount || 0) > 0).length;
  console.log(`\nQuality signals in passed:`);
  console.log(`  Multi-source (2+):  ${multiSrc}`);
  console.log(`  Verified:           ${verified}`);
  console.log(`  Has holder data:    ${withHolders}`);

  console.log(`\n=== TOP 10 CANDIDATES ===`);
  passed.slice(0, 10).forEach((t, i) => {
    const bp = t.buyPressure ? `bp:${(t.buyPressure * 100).toFixed(0)}%` : '';
    const os = t.organicScore ? `org:${Math.round(t.organicScore)}` : '';
    const h1 = t.priceChange1h ? `1h:${t.priceChange1h.toFixed(1)}%` : '';
    const hc = t.holderCount ? `hldr:${t.holderCount}` : '';
    const vlr = t.liquidity > 0 ? `v/l:${(t.volume24h / t.liquidity).toFixed(1)}x` : '';
    const src = (t._sourceCount || 1) > 1 ? `src:${t._sourceCount}` : '';
    const ver = t.isVerified ? 'VERIFIED' : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${(t.symbol || '').padEnd(12)} score:${t._score} 24h:${(t.priceChange24h || 0).toFixed(1).padStart(7)}% ${h1.padEnd(12)} vol:$${Math.round((t.volume24h || 0) / 1000)}k liq:$${Math.round((t.liquidity || 0) / 1000)}k ${vlr} ${bp} ${os} ${hc} ${src} ${ver}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
