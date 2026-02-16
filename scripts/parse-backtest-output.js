#!/usr/bin/env node
// Parse backtest terminal output and aggregate results
// Usage: node scripts/parse-backtest-output.js <path-to-terminal-output.txt>

const fs = require('fs');
const path = process.argv[2] || require('path').join(process.env.USERPROFILE || '', '.cursor/projects/c-Users-mekal-clone-voting-app/terminals/718461.txt');

const COIN_ORDER = ['BTC','ETH','SOL','DOGE','XRP','ADA','DOT','AVAX','LINK','POL','BNB','LTC','UNI','ATOM'];

const raw = fs.readFileSync(path, 'utf8');
const lines = raw.split('\n');

const coinData = {};
let currentCoin = null;

for (const line of lines) {
  const header = line.match(/^--- ([A-Z]+) ---$/);
  if (header) {
    currentCoin = header[1];
    coinData[currentCoin] = { trades: [], pnls: [] };
    continue;
  }
  const match = line.match(/\s+(\d{4}-\d{2})\s+(\d+)\s+trades,\s+\$(-?\d+)/);
  if (match && currentCoin) {
    const [, month, trades, pnl] = match;
    coinData[currentCoin].trades.push(parseInt(trades, 10));
    coinData[currentCoin].pnls.push(parseInt(pnl, 10));
  }
}

// Aggregate
const results = [];
for (const [symbol, data] of Object.entries(coinData)) {
  if (data.trades.length === 0) continue;
  const totalTrades = data.trades.reduce((a, b) => a + b, 0);
  const totalPnl = data.pnls.reduce((a, b) => a + b, 0);
  const grossProfit = data.pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(data.pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const returnPct = (totalPnl / 10000) * 100;
  const monthsWithTrades = data.trades.filter(t => t > 0).length;
  // Approximate win rate: we don't have wins/losses per trade, use profit factor as proxy
  results.push({
    symbol,
    totalTrades,
    totalPnl,
    returnPct,
    profitFactor,
    grossProfit,
    grossLoss,
    monthsWithTrades,
    monthsTotal: data.trades.length
  });
}

// Sort by total PnL
results.sort((a, b) => b.totalPnl - a.totalPnl);

console.log('\n========================================');
console.log('  PARSED BACKTEST RESULTS (from terminal output)');
console.log('  Config: SL cap ON | 4h cooldown ON | BTC filter OFF');
console.log('========================================\n');

console.log('TOP 10 COINS (by Total PnL)\n');
console.log('Rank | Symbol | Trades | PnL ($) | Return% | PF   | Months w/ trades');
console.log('-'.repeat(65));

results.slice(0, 10).forEach((r, i) => {
  console.log(
    `${(i + 1).toString().padStart(4)} | ${r.symbol.padEnd(6)} | ${r.totalTrades.toString().padStart(6)} | ` +
    `$${r.totalPnl.toFixed(0).padStart(6)} | ${r.returnPct.toFixed(1).padStart(6)}% | ${r.profitFactor.toFixed(2).padStart(5)} | ${r.monthsWithTrades}/${r.monthsTotal}`
  );
});

console.log('\n\nALL 14 COINS (sorted by PnL)\n');
results.forEach((r, i) => {
  console.log(`${(i + 1).toString().padStart(2)}. ${r.symbol}: $${r.totalPnl.toFixed(0)} (${r.totalTrades} trades, ${r.returnPct.toFixed(1)}% return, PF ${r.profitFactor.toFixed(2)})`);
});

console.log('\n');
