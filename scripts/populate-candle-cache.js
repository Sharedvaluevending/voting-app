#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const {
  populateAllCandles,
  getCacheStorageStats,
  formatBytes,
  CACHE_TIMEFRAMES
} = require('../services/candle-cache');
const { TRACKED_COINS } = require('../services/crypto-api');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseListArg(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    coins: null,
    timeframes: null,
    batchSize: null,
    pauseMs: 0,
    lookbackDays: 365 * 3,
    dryRun: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--coins' && argv[i + 1]) out.coins = parseListArg(argv[++i]);
    else if (a === '--timeframes' && argv[i + 1]) out.timeframes = parseListArg(argv[++i]);
    else if (a === '--batch-size' && argv[i + 1]) out.batchSize = Number(argv[++i]);
    else if (a === '--pause-ms' && argv[i + 1]) out.pauseMs = Number(argv[++i]);
    else if (a === '--lookback-days' && argv[i + 1]) out.lookbackDays = Number(argv[++i]);
  }
  return out;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/populate-candle-cache.js [options]

Options:
  --coins <c1,c2,...>          Limit to specific coin IDs (e.g. bitcoin,ethereum,solana)
  --timeframes <t1,t2,...>     Timeframes: 15m,1h,4h,1d
  --batch-size <n>             Process coins in batches (default: all selected coins)
  --pause-ms <ms>              Pause between batches (default: 0)
  --lookback-days <n>          History window in days (default: 1095)
  --dry-run                    Print selection and exit
  --help                       Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const selectedCoins = args.coins && args.coins.length > 0
    ? TRACKED_COINS.filter((c) => args.coins.includes(c))
    : TRACKED_COINS.slice();
  const invalidCoins = args.coins && args.coins.length > 0
    ? args.coins.filter((c) => !TRACKED_COINS.includes(c))
    : [];

  const tfInput = args.timeframes && args.timeframes.length > 0 ? args.timeframes : CACHE_TIMEFRAMES;
  const selectedTfs = tfInput.filter((t) => CACHE_TIMEFRAMES.includes(t));
  const invalidTfs = tfInput.filter((t) => !CACHE_TIMEFRAMES.includes(t));

  if (selectedCoins.length === 0) throw new Error('No valid coins selected');
  if (selectedTfs.length === 0) throw new Error('No valid timeframes selected');
  if (invalidCoins.length > 0) console.warn(`[Cache Populate] Ignoring unknown coins: ${invalidCoins.join(', ')}`);
  if (invalidTfs.length > 0) console.warn(`[Cache Populate] Ignoring unknown timeframes: ${invalidTfs.join(', ')}`);

  const lookbackMs = Math.max(1, Number(args.lookbackDays || 1095)) * 24 * 60 * 60 * 1000;
  const batchSize = Math.max(1, Number(args.batchSize || selectedCoins.length));
  const pauseMs = Math.max(0, Number(args.pauseMs || 0));

  console.log(`[Cache Populate] Selection: ${selectedCoins.length} coin(s), ${selectedTfs.length} timeframe(s), batch=${batchSize}, pause=${pauseMs}ms`);
  console.log(`[Cache Populate] Coins: ${selectedCoins.join(', ')}`);
  console.log(`[Cache Populate] Timeframes: ${selectedTfs.join(', ')}`);
  console.log(`[Cache Populate] Lookback: ${Math.round(lookbackMs / (24 * 60 * 60 * 1000))} days`);
  if (args.dryRun) {
    console.log('[Cache Populate] Dry run complete.');
    return;
  }

  const uri = process.env.MONGODB_URI_STANDARD || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI or MONGODB_URI_STANDARD is required');

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  });

  const startedAt = Date.now();
  const totalBatches = Math.ceil(selectedCoins.length / batchSize);
  console.log(`[Cache Populate] Starting cache warmup in ${totalBatches} batch(es)`);

  let totalStored = 0;
  let failed = [];
  for (let i = 0; i < selectedCoins.length; i += batchSize) {
    const batchIndex = Math.floor(i / batchSize) + 1;
    const batchCoins = selectedCoins.slice(i, i + batchSize);
    console.log(`\n[Cache Populate] Batch ${batchIndex}/${totalBatches}: ${batchCoins.join(', ')}`);
    const out = await populateAllCandles({
      coins: batchCoins,
      timeframes: selectedTfs,
      lookbackMs
    });
    totalStored += Number(out.totalStored || 0);
    failed = failed.concat(out.failed || []);
    if (pauseMs > 0 && batchIndex < totalBatches) {
      console.log(`[Cache Populate] Pausing ${pauseMs}ms before next batch...`);
      await sleep(pauseMs);
    }
  }

  const stats = await getCacheStorageStats();
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const failedPairs = failed;
  const failedCoins = [...new Set(failedPairs.map((f) => f.coinId))];

  console.log('\n[Cache Populate] Summary');
  console.log(`- Total coins cached: ${selectedCoins.length - failedCoins.length}/${selectedCoins.length}`);
  console.log(`- Total candles stored/updated: ${totalStored.toLocaleString()}`);
  console.log(`- Total collection size: ${formatBytes(stats.storageBytes)}`);
  console.log(`- Runtime: ${elapsedSec}s`);
  if (failedPairs.length > 0) {
    console.log(`- Failed pairs: ${failedPairs.length}`);
    failedPairs.forEach((f) => {
      console.log(`  - ${f.coinId} ${f.timeframe}: ${f.error}`);
    });
  } else {
    console.log('- Failed pairs: 0');
  }
}

main().then(async () => {
  await mongoose.connection.close();
}).catch(async (err) => {
  console.error('[Cache Populate] Failed:', err.message);
  try { await mongoose.connection.close(); } catch (e) {}
  process.exit(1);
});
