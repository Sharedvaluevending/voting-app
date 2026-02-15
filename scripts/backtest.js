#!/usr/bin/env node
// scripts/backtest.js – Run historical backtest via CLI
// Usage: node scripts/backtest.js [coinId] [days]
// Example: node scripts/backtest.js bitcoin 30
// Example: node scripts/backtest.js (all coins, last 30 days)

const { runBacktest, runBacktestForCoin } = require('../services/backtest');

async function main() {
  const coinId = process.argv[2] || null;
  const days = parseInt(process.argv[3], 10) || 30;

  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;

  console.log('\n--- Historical Backtest ---');
  console.log('Range:', new Date(startMs).toISOString().slice(0, 10), 'to', new Date(endMs).toISOString().slice(0, 10));
  console.log('Coin:', coinId || 'all');
  console.log('');

  const options = { coins: coinId ? [coinId] : undefined, delay: 350 };
  const result = await runBacktest(startMs, endMs, options);

  if (result.results.length === 0) {
    console.log('No results (insufficient candles or errors).');
    process.exit(0);
  }

  const s = result.summary;
  console.log('--- Summary ---');
  console.log('Total Trades:', s.totalTrades);
  console.log('Wins:', s.wins, '| Losses:', s.losses);
  console.log('Win Rate:', s.winRate.toFixed(1) + '%');
  console.log('Total PnL: $' + s.totalPnl.toFixed(2));
  console.log('Return:', s.returnPct.toFixed(2) + '%');
  console.log('Profit Factor:', s.profitFactor.toFixed(2));
  console.log('');

  result.results.forEach(r => {
    if (r.error) return;
    console.log(r.symbol || r.coinId, '| Trades:', r.totalTrades, '| WR:', r.winRate.toFixed(1) + '%', '| PnL: $' + (r.totalPnl || 0).toFixed(2), '| DD:', (r.maxDrawdownPct || 0).toFixed(1) + '%');
  });

  console.log('\nOK\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
