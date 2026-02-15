#!/usr/bin/env node
// scripts/backtest-massive.js — Run 2-year backtest on all coins and save to DB
// Results persist through platform resets. Also writes to data/backtest-results/ for legacy.
// Usage: node scripts/backtest-massive.js [months]
// Example: node scripts/backtest-massive.js 24

require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const months = parseInt(process.argv[2], 10) || 24;
const endMs = Date.now();
const startMs = endMs - months * 30 * 24 * 60 * 60 * 1000;

async function main() {
  const { runBacktest } = require('../services/backtest');
  const { saveBacktestResult, transformBacktestToResultFormat } = require('../services/backtest-results');

  console.log('\n--- Massive Backtest ---');
  console.log('Months:', months);
  console.log('Range:', new Date(startMs).toISOString().slice(0, 10), 'to', new Date(endMs).toISOString().slice(0, 10));
  console.log('');

  const result = await runBacktest(startMs, endMs, { delay: 350 });
  const successResults = (result.results || []).filter(r => !r.error);

  if (successResults.length === 0) {
    console.log('No results. Check candle fetch.');
    process.exit(1);
  }

  const formatted = transformBacktestToResultFormat(result);
  console.log('Summary:', formatted.summary?.totalTrades || 0, 'trades, PnL $' + (formatted.summary?.totalPnl || 0).toFixed(2));

  // Save to DB (persists through resets)
  const mongoURI = process.env.MONGODB_URI || process.env.MONGODB_URI_STANDARD || 'mongodb://127.0.0.1:27017/votingApp';
  try {
    await mongoose.connect(mongoURI);
    await saveBacktestResult(formatted);
    console.log('Saved to database. Results will persist through platform resets.');
  } catch (e) {
    console.warn('DB save failed (non-fatal):', e.message);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }

  // Also write to file for legacy compatibility
  const resultsDir = path.join(__dirname, '..', 'data', 'backtest-results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  const filename = `massive-${Date.now()}.json`;
  const filepath = path.join(resultsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify({ ...formatted, startMs: result.startMs, endMs: result.endMs }, null, 2));
  console.log('Wrote', filepath);

  console.log('\nDone.\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
