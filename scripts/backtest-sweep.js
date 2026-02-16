#!/usr/bin/env node
// scripts/backtest-sweep.js – Parameter sweep using CACHED data (no API calls after first run)
// Run backtest-massive.js once first to fill cache, then this runs fast.
//
// Usage: node scripts/backtest-sweep.js [--full]
//   --full = all 14 coins × 25 months (slow first time to fill cache)
//   Default: 2 coins × 3 months (quick validation)

const fs = require('fs');
const path = require('path');
const { runBacktestForCoin } = require('../services/backtest');
const { TRACKED_COINS, COIN_META } = require('../services/crypto-api');

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;
const DELAY_MS = 1200;  // Between runs (cache hits are fast, but first run fetches)

const FULL_MODE = process.argv.includes('--full');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getMonthRanges() {
  const endMs = Date.now();
  const startMs = endMs - 2 * 365 * 24 * 60 * 60 * 1000;
  const ranges = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const monthEnd = Math.min(cursor + MS_PER_MONTH, endMs);
    ranges.push({ startMs: cursor, endMs: monthEnd });
    cursor = monthEnd;
  }
  return ranges;
}

async function runSweepForCoin(coinId, monthRanges, params) {
  const results = [];
  for (const { startMs, endMs } of monthRanges) {
    const opts = {
      features: {
        btcFilter: params.btcFilter,
        slCap: true,
        cooldown: true,
        btcCorrelation: params.btcFilter
      },
      minScore: params.minScore,
      cooldownBars: params.cooldownHours,
      maxSlDistancePct: params.slCapPct,
      useBitgetOnly: true,
      useCache: true
    };
    const r = await runBacktestForCoin(coinId, startMs, endMs, opts);
    results.push(r);
    await sleep(DELAY_MS);
  }
  const valid = results.filter(x => !x.error && x.trades);
  const totalPnl = valid.reduce((s, r) => s + (r.totalPnl || 0), 0);
  const totalTrades = valid.reduce((s, r) => s + (r.trades?.length || 0), 0);
  return { totalPnl, totalTrades, results };
}

async function main() {
  let monthRanges = getMonthRanges();
  let coins = TRACKED_COINS;

  if (!FULL_MODE) {
    coins = TRACKED_COINS.slice(0, 2);
    monthRanges = monthRanges.slice(-3);
    console.log('\n[QUICK MODE: 2 coins × 3 months]\n');
  }

  const paramSets = [
    { name: 'Baseline (52, BTC off, 4h, 15%)', minScore: 52, btcFilter: false, cooldownHours: 4, slCapPct: 0.15 },
    { name: 'BTC filter ON', minScore: 52, btcFilter: true, cooldownHours: 4, slCapPct: 0.15 },
    { name: 'Min score 54', minScore: 54, btcFilter: false, cooldownHours: 4, slCapPct: 0.15 },
    { name: 'Min score 56', minScore: 56, btcFilter: false, cooldownHours: 4, slCapPct: 0.15 },
    { name: 'Cooldown 2h', minScore: 52, btcFilter: false, cooldownHours: 2, slCapPct: 0.15 },
    { name: 'Cooldown 6h', minScore: 52, btcFilter: false, cooldownHours: 6, slCapPct: 0.15 },
    { name: 'SL cap 10%', minScore: 52, btcFilter: false, cooldownHours: 4, slCapPct: 0.10 },
    { name: 'SL cap 20%', minScore: 52, btcFilter: false, cooldownHours: 4, slCapPct: 0.20 }
  ];

  console.log('\n========================================');
  console.log('  PARAMETER SWEEP (using cache)');
  console.log('========================================');
  console.log(`Coins: ${coins.length} | Months: ${monthRanges.length} | Param sets: ${paramSets.length}`);
  console.log('========================================\n');

  const sweepResults = [];

  for (const params of paramSets) {
    console.log(`\n--- ${params.name} ---`);
    let totalPnl = 0;
    let totalTrades = 0;
    for (const coinId of coins) {
      const { totalPnl: pnl, totalTrades: trades } = await runSweepForCoin(coinId, monthRanges, params);
      totalPnl += pnl;
      totalTrades += trades;
      process.stdout.write(`  ${COIN_META[coinId]?.symbol}: $${pnl.toFixed(0)} (${trades} trades)  `);
    }
    console.log(`\n  TOTAL: $${totalPnl.toFixed(0)} | ${totalTrades} trades`);
    sweepResults.push({ ...params, totalPnl, totalTrades });
  }

  // Summary
  sweepResults.sort((a, b) => b.totalPnl - a.totalPnl);
  console.log('\n\n========================================');
  console.log('  RANKING BY TOTAL PnL');
  console.log('========================================\n');
  sweepResults.forEach((r, i) => {
    console.log(`${i + 1}. ${r.name}: $${r.totalPnl.toFixed(0)} (${r.totalTrades} trades)`);
  });

  // Save
  const outDir = path.join(__dirname, '../data/backtest-results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `sweep-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), results: sweepResults }, null, 2), 'utf8');
  console.log(`\nSaved to ${outPath}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
