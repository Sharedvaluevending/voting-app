#!/usr/bin/env node
// scripts/clear-backtest-cache.js
// Safely clear backtest candle cache so the next run re-fetches from the API.
// Only deletes files in data/backtest-cache/ (never touches backtest-results or anything else).
//
// Usage:
//   node scripts/clear-backtest-cache.js --dry-run              # list what would be deleted
//   node scripts/clear-backtest-cache.js --dry-run bitcoin       # list cache for bitcoin only
//   node scripts/clear-backtest-cache.js --yes                  # delete all backtest cache
//   node scripts/clear-backtest-cache.js --yes bitcoin           # delete cache for bitcoin only
//   node scripts/clear-backtest-cache.js --yes bitcoin 365      # delete bitcoin caches for 365-day range (matches typical 1yr run)

const path = require('path');
const fs = require('fs');

const CACHE_DIR = path.join(__dirname, '../data/backtest-cache');

function getMatchingFiles(coinFilter, daysFilter) {
  if (!fs.existsSync(CACHE_DIR)) return [];
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
  const now = Date.now();
  return files.filter((f) => {
    if (coinFilter && coinFilter !== 'all') {
      const prefix = coinFilter + '_';
      if (!f.startsWith(prefix)) return false;
    }
    if (daysFilter != null) {
      const match = f.match(/^(.+)_(\d+)_(\d+)\.json$/);
      if (!match) return false;
      const startMs = parseInt(match[2], 10);
      const endMs = parseInt(match[3], 10);
      const rangeDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
      if (Math.abs(rangeDays - daysFilter) > 5) return false;
    }
    return true;
  });
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes');
  const rest = args.filter((a) => a !== '--dry-run' && a !== '--yes');
  const coinFilter = rest[0] || 'all';
  const daysFilter = rest[1] ? parseInt(rest[1], 10) : null;

  if (!dryRun && !yes) {
    console.log('Backtest cache lives in:', CACHE_DIR);
    console.log('Use --dry-run to list matching files, then --yes to delete.');
    console.log('Example: node scripts/clear-backtest-cache.js --dry-run bitcoin 365');
    process.exit(0);
  }

  const matching = getMatchingFiles(coinFilter, daysFilter);
  if (matching.length === 0) {
    console.log('No cache files match.');
    process.exit(0);
  }

  console.log('Matching cache files (' + matching.length + '):');
  matching.forEach((f) => console.log('  ', path.join(CACHE_DIR, f)));

  if (dryRun) {
    console.log('\n(Dry run — no files deleted. Run with --yes to delete.)');
    process.exit(0);
  }

  let deleted = 0;
  matching.forEach((f) => {
    const full = path.join(CACHE_DIR, f);
    try {
      fs.unlinkSync(full);
      deleted++;
    } catch (e) {
      console.warn('Could not delete', full, e.message);
    }
  });
  console.log('\nDeleted', deleted, 'file(s). Next backtest will re-fetch from the API.');
}

main();
