#!/usr/bin/env node
/**
 * Review main platform trades (BTC, ETH, XRP, etc. - Trade model)
 * Run: node scripts/review-main-trades.js [--hours=24]
 */
require('dotenv').config();
const mongoose = require('mongoose');

const hoursMatch = process.argv.find(a => a.startsWith('--hours='));
const HOURS = hoursMatch ? parseInt(hoursMatch.split('=')[1], 10) : 24;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Trade = require('../models/Trade');
  const User = require('../models/User');

  const since = HOURS ? new Date(Date.now() - HOURS * 60 * 60 * 1000) : null;

  const users = await User.find({}).lean();
  for (const user of users) {
    const q = { userId: user._id, status: { $ne: 'OPEN' } };
    if (since) q.exitTime = { $gte: since };
    const closed = await Trade.find(q).sort({ exitTime: -1 }).limit(100).lean();
    if (closed.length === 0) continue;

    const wins = closed.filter(t => (t.pnl || 0) > 0);
    const losses = closed.filter(t => (t.pnl || 0) <= 0);
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const byStatus = {};
    closed.forEach(t => {
      const s = t.status || t.closeReason || 'unknown';
      byStatus[s] = (byStatus[s] || 0) + 1;
    });
    const byCoin = {};
    closed.forEach(t => {
      const c = t.symbol || t.coinId || '?';
      if (!byCoin[c]) byCoin[c] = { wins: 0, losses: 0, pnl: 0 };
      if ((t.pnl || 0) > 0) byCoin[c].wins++;
      else byCoin[c].losses++;
      byCoin[c].pnl += t.pnl || 0;
    });
    const byStrategy = {};
    closed.forEach(t => {
      const s = t.strategyType || 'unknown';
      if (!byStrategy[s]) byStrategy[s] = { wins: 0, losses: 0, pnl: 0 };
      if ((t.pnl || 0) > 0) byStrategy[s].wins++;
      else byStrategy[s].losses++;
      byStrategy[s].pnl += t.pnl || 0;
    });

    console.log(`\n=== ${user.username} (last ${HOURS}h) ===`);
    console.log(`Trades: ${closed.length} | Wins: ${wins.length} | Losses: ${losses.length} | Win rate: ${closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : 0}%`);
    console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
    console.log('Exit reasons:', JSON.stringify(byStatus));
    console.log('By coin:', Object.entries(byCoin).map(([c, v]) => `${c}:${v.wins}W/${v.losses}L $${v.pnl.toFixed(0)}`).join(', '));
    console.log('By strategy:', Object.entries(byStrategy).map(([s, v]) => `${s}:${v.wins}W/${v.losses}L $${v.pnl.toFixed(0)}`).join(', '));
    console.log('\nLast 15 trades:');
    closed.slice(0, 15).forEach(t => {
      const held = t.exitTime && t.entryTime ? Math.round((new Date(t.exitTime) - new Date(t.entryTime)) / 60000) : '?';
      const pnl = (t.pnl || 0).toFixed(2);
      const status = t.status || t.closeReason || '?';
      console.log(`  ${(t.symbol || '?').padEnd(6)} ${t.direction} ${(t.pnl >= 0 ? '+' : '')}$${pnl.padStart(8)} ${status.padEnd(20)} ${held}min`);
    });
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
