#!/usr/bin/env node
// scripts/test-backtest-coins.js
// Run 1-year backtest on a few coins; verify we get ~1 year of candles and report trade counts.
// Usage: node scripts/test-backtest-coins.js [useCache] [primaryTf]
// useCache: "false" = fresh fetch. primaryTf: "4h" or "1d" for full-year (fewer API calls than 1h).
const { runBacktest, fetchHistoricalCandlesMultiTF } = require('../services/backtest');

const COINS_TO_TEST = ['bitcoin', 'ethereum', 'solana', 'chainlink'];
const DAYS = 365;

async function main() {
  const useCache = process.argv[2] !== 'false';
  const primaryTf = process.argv[3] || '1h';
  const endMs = Date.now();
  const startMs = endMs - DAYS * 24 * 60 * 60 * 1000;
  const expectedBars = primaryTf === '1h' ? 365 * 24 : primaryTf === '4h' ? 365 * 6 : primaryTf === '1d' ? 365 : 365 * 24;

  console.log('\n=== Backtest candle & trade check ===');
  console.log('Range:', new Date(startMs).toISOString().slice(0, 10), 'to', new Date(endMs).toISOString().slice(0, 10), `(${DAYS} days)`);
  console.log('Coins:', COINS_TO_TEST.join(', '), '| TF:', primaryTf);
  console.log('Cache:', useCache ? 'ON' : 'OFF (fresh fetch)');
  console.log('Expected bars for 1yr:', expectedBars);
  console.log('');

  // 1) Quick candle count check for first coin (no full backtest)
  console.log('--- Candle fetch check (first coin) ---');
  const firstCoin = COINS_TO_TEST[0];
  const candles = await fetchHistoricalCandlesMultiTF(firstCoin, startMs, endMs, { useCache, primaryTf });
  if (candles.error) {
    console.log(firstCoin, 'ERROR:', candles.error);
  } else {
    const cPrimary = candles[primaryTf] || [];
    console.log(firstCoin, primaryTf, 'bars:', cPrimary.length, '(expected ~' + expectedBars + ' for 1 year)');
    if (cPrimary.length > 0) {
      console.log('  First bar:', new Date(cPrimary[0].openTime).toISOString());
      console.log('  Last bar:', new Date(cPrimary[cPrimary.length - 1].openTime).toISOString());
    }
    console.log('  4h:', (candles['4h'] || []).length, '| 1d:', (candles['1d'] || []).length);
  }
  console.log('');

  // 2) Full backtest for all test coins
  console.log('--- Full backtest ---');
  const result = await runBacktest(startMs, endMs, {
    coins: COINS_TO_TEST,
    useCache,
    primaryTf,
    onProgress: (msg) => console.log('  ', msg)
  });

  const s = result.summary;
  console.log('\n--- Summary ---');
  console.log('Total trades:', s.totalTrades);
  console.log('Wins:', s.wins, '| Losses:', s.losses, '| Win rate:', s.winRate.toFixed(1) + '%');
  console.log('Total PnL: $' + s.totalPnl.toFixed(2), '| Return:', s.returnPct.toFixed(2) + '%');
  console.log('');

  console.log('--- Per-coin: bars & trades ---');
  result.results.forEach((r) => {
    if (r.error) {
      console.log(r.coinId || '?', '| ERROR:', r.error);
      return;
    }
    const bars = r.bars ?? 0;
    const trades = r.totalTrades ?? 0;
    const barNote = bars >= expectedBars * 0.9 ? 'OK' : bars >= expectedBars * 0.5 ? 'LOW' : 'LOW (check API/cache)';
    console.log((r.symbol || r.coinId).padEnd(6), '|', primaryTf, 'bars:', String(bars).padStart(5), barNote, '| trades:', String(trades).padStart(4));
  });

  console.log('\nTip: If 1h gives only ~30 days of bars, try: node scripts/test-backtest-coins.js false 4h');
  console.log('Done.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
