#!/usr/bin/env node
/**
 * Unit test for Trench Warfare partial TP logic
 * Simulates shouldSellPosition + executeLiveSell flow
 */
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// Inline replica of partial TP logic for testing
function shouldSellPosition(pos, currentPrice, settings) {
  const entry = pos.entryPrice || 0.0000001;
  const pnlPct = ((currentPrice - entry) / entry) * 100;
  const tp = settings.tpPercent ?? 12;
  const usePartialTP = settings.usePartialTP !== false;

  if (!settings.useTrailingTP && usePartialTP) {
    const tp1 = tp * 0.4, tp2 = tp * 0.7;
    const sold = pos.partialSoldAmount || 0;
    const orig = pos.tokenAmount || 0;
    const soldPct = orig > 0 ? (sold / orig) * 100 : 0;
    if (pnlPct >= tp && soldPct >= 69) return { sell: true, reason: 'partial_tp3', partialPercent: 0 };
    if (pnlPct >= tp2 && soldPct >= 39 && soldPct < 69) return { sell: true, reason: 'partial_tp2', partialPercent: 30 };
    if (pnlPct >= tp1 && soldPct < 1) return { sell: true, reason: 'partial_tp1', partialPercent: 40 };
  }
  if (!settings.useTrailingTP && pnlPct >= tp) return { sell: true, reason: 'take_profit', pnlPct };
  return { sell: false };
}

function computeAmountToSell(pos, decision) {
  const orig = pos.tokenAmount || 0;
  const sold = pos.partialSoldAmount || 0;
  const remaining = orig - sold;
  if (decision.partialPercent === 0 || decision.partialPercent == null) return remaining;
  if (decision.partialPercent > 0 && decision.partialPercent < 100) {
    return orig * (decision.partialPercent / 100);
  }
  return remaining;
}

function main() {
  console.log('=== Partial TP Unit Test ===\n');

  const entry = 1;
  const tokenAmount = 1000;
  const settings = { tpPercent: 2, useTrailingTP: false, usePartialTP: true };

  // TP1: 40% of 2% = 0.8%. Price = 1.008
  let pos = { entryPrice: entry, tokenAmount, partialSoldAmount: 0 };
  let price = 1.008;
  let d = shouldSellPosition(pos, price, settings);
  assert(d.sell && d.reason === 'partial_tp1' && d.partialPercent === 40, 'TP1 should fire at 0.8%');
  let amt = computeAmountToSell(pos, d);
  assert(amt === 400, 'TP1 should sell 400 (40%)');
  console.log('TP1: price +0.8%, sell 40% = 400 tokens OK');

  // After TP1: partialSoldAmount = 400
  pos = { ...pos, partialSoldAmount: 400 };
  d = shouldSellPosition(pos, price, settings);
  assert(!d.sell || d.reason !== 'partial_tp1', 'TP1 should not re-fire after sold');
  console.log('TP1 no re-fire after partial OK');

  // TP2: 70% of 2% = 1.4%. Price = 1.014
  price = 1.014;
  d = shouldSellPosition(pos, price, settings);
  assert(d.sell && d.reason === 'partial_tp2' && d.partialPercent === 30, 'TP2 should fire at 1.4%');
  amt = computeAmountToSell(pos, d);
  assert(amt === 300, 'TP2 should sell 300 (30%)');
  console.log('TP2: price +1.4%, sell 30% = 300 tokens OK');

  // After TP2: partialSoldAmount = 700
  pos = { ...pos, partialSoldAmount: 700 };
  d = shouldSellPosition(pos, price, settings);
  assert(!d.sell || d.reason !== 'partial_tp2', 'TP2 should not re-fire');
  console.log('TP2 no re-fire OK');

  // TP3: 100% of 2% = 2%. Price = 1.02
  price = 1.02;
  d = shouldSellPosition(pos, price, settings);
  assert(d.sell && d.reason === 'partial_tp3' && d.partialPercent === 0, 'TP3 should fire at 2%');
  amt = computeAmountToSell(pos, d);
  assert(amt === 300, 'TP3 should sell remaining 300 (remaining)');
  console.log('TP3: price +2%, sell remaining 300 tokens OK');

  // usePartialTP false: full TP
  pos = { entryPrice: 1, tokenAmount: 1000, partialSoldAmount: 0 };
  settings.usePartialTP = false;
  d = shouldSellPosition(pos, 1.02, settings);
  assert(d.sell && d.reason === 'take_profit', 'Full TP when usePartialTP false');
  console.log('Full TP when usePartialTP off OK');

  // useTrailingTP true: no partial
  settings.usePartialTP = true;
  settings.useTrailingTP = true;
  d = shouldSellPosition(pos, 1.02, settings);
  assert(!d.sell, 'No partial when trailing TP');
  console.log('No partial when useTrailingTP OK');

  console.log('\n=== All tests passed ===');
  process.exit(0);
}

main();
