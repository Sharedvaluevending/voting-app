#!/usr/bin/env node
// Test all backtest timeframes (15m, 1h, 4h, 1d)
// Usage: node scripts/test-backtest-timeframes.js

const { runBacktest } = require('../services/backtest');

const COIN = 'bitcoin';
const DAYS = 7; // Short range for quick test

async function testTf(primaryTf) {
  const endMs = Date.now();
  const startMs = endMs - DAYS * 24 * 60 * 60 * 1000;
  const options = {
    coins: [COIN],
    primaryTf,
    minScore: 48,
    features: { btcFilter: false, btcCorrelation: false }
  };
  const result = await runBacktest(startMs, endMs, options);
  const success = result.results.some(r => !r.error);
  const err = result.results.find(r => r.error)?.error;
  return { success, trades: result.summary?.totalTrades ?? 0, error: err };
}

async function main() {
  const tfs = ['15m', '1h', '4h', '1d'];
  console.log('Testing backtest timeframes on', COIN, '(', DAYS, 'days)...\n');
  let allOk = true;
  for (const tf of tfs) {
    process.stdout.write(tf + '... ');
    try {
      const r = await testTf(tf);
      if (r.success) {
        console.log('OK (' + r.trades + ' trades)');
      } else {
        console.log('FAIL:', r.error);
        allOk = false;
      }
    } catch (e) {
      console.log('ERROR:', e.message);
      allOk = false;
    }
  }
  console.log(allOk ? '\nAll timeframes OK.' : '\nSome timeframes failed.');
  process.exit(allOk ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
