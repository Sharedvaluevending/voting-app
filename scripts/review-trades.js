#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');

const LAST_HOUR = process.argv.includes('--last-hour') || process.argv.includes('-1h');
const hoursMatch = process.argv.find(a => a.startsWith('--hours='));
const HOURS = hoursMatch ? parseInt(hoursMatch.split('=')[1], 10) : null;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const ScalpTrade = require('../models/ScalpTrade');
  const User = require('../models/User');

  const users = await User.find({ 'trenchStats.wins': { $gt: 0 } }).lean();
  if (users.length === 0) { console.log('No users with trades found'); process.exit(0); }

  const sinceMs = LAST_HOUR ? 60 * 60 * 1000 : (HOURS ? HOURS * 60 * 60 * 1000 : null);
  const sinceDate = sinceMs ? new Date(Date.now() - sinceMs) : null;

  // For time-filtered mode: get users who have closed trades in window
  let usersToShow = users;
  if (sinceDate) {
    const userIdsWithRecent = await ScalpTrade.distinct('userId', {
      status: 'CLOSED',
      exitTime: { $gte: sinceDate }
    });
    if (userIdsWithRecent.length > 0) {
      usersToShow = await User.find({ _id: { $in: userIdsWithRecent } }).lean();
    } else {
      const label = HOURS ? `last ${HOURS}h` : 'last hour';
      console.log(`No closed trades in ${label}. Try without --last-hour or --hours=N for recent trades.`);
      await mongoose.disconnect();
      process.exit(0);
    }
  }

  for (const user of usersToShow) {
    console.log(`\n=== ${user.username} ===`);
    const stats = user.trenchStats || {};
    const wins = stats.wins || 0;
    const losses = stats.losses || 0;
    const total = wins + losses;
    console.log(`Win rate: ${total > 0 ? (wins/total*100).toFixed(1) : 0}% | Wins: ${wins} | Losses: ${losses} | Total PnL: $${(stats.totalPnl || 0).toFixed(2)}`);
    console.log(`Balance: $${(user.trenchPaperBalance || 0).toFixed(2)} | Consec losses: ${stats.consecutiveLosses || 0}`);

    const closedQuery = { userId: user._id, status: 'CLOSED' };
    if (sinceDate) closedQuery.exitTime = { $gte: sinceDate };
    const closed = await ScalpTrade.find(closedQuery)
      .sort({ exitTime: -1 }).limit(sinceDate ? 200 : 20).lean();

    const timeLabel = HOURS ? `Last ${HOURS}h` : (LAST_HOUR ? 'Last hour' : 'Last');
    if (closed.length === 0) { console.log(sinceDate ? `No closed trades in ${timeLabel.toLowerCase()}` : 'No closed trades'); continue; }

    console.log(`\n${timeLabel} ${closed.length} trades (newest first):`);
    console.log('Symbol'.padEnd(12) + 'PnL%'.padStart(8) + 'PnL$'.padStart(10) + 'Exit Reason'.padStart(22) + 'Held'.padStart(8) + '  Entry Time');
    console.log('-'.repeat(85));

    for (const t of closed) {
      const held = t.exitTime ? Math.round((new Date(t.exitTime) - new Date(t.createdAt)) / 60000) : '?';
      const sym = (t.tokenSymbol || '???').padEnd(12);
      const pnlPct = (t.pnlPercent || 0).toFixed(1).padStart(7) + '%';
      const pnlUsd = ('$' + (t.pnl || 0).toFixed(2)).padStart(10);
      const reason = (t.exitReason || '?').padStart(22);
      const heldStr = (held + 'min').padStart(8);
      const time = new Date(t.createdAt).toLocaleString();
      const marker = (t.pnl || 0) >= 0 ? ' W' : ' L';
      console.log(`${sym}${pnlPct}${pnlUsd}${reason}${heldStr}  ${time}${marker}`);
    }

    if (sinceDate && closed.length > 0) {
      const hourWins = closed.filter(t => (t.pnl || 0) > 0).length;
      const hourLosses = closed.filter(t => (t.pnl || 0) < 0).length;
      const hourPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
      const byReason = {};
      for (const t of closed) {
        const r = t.exitReason || 'unknown';
        byReason[r] = (byReason[r] || 0) + 1;
      }
      const label = HOURS ? `${HOURS}h` : '1h';
      console.log(`\n--- LAST ${label.toUpperCase()} SUMMARY ---`);
      console.log(`Trades: ${closed.length} | Wins: ${hourWins} | Losses: ${hourLosses} | Win rate: ${closed.length > 0 ? (hourWins/closed.length*100).toFixed(1) : 0}%`);
      console.log(`Total PnL: $${hourPnl.toFixed(2)}`);
      console.log(`Exit reasons: ${Object.entries(byReason).map(([k,v])=>`${k}:${v}`).join(', ')}`);
    }

    // Check for repeat tokens
    const tokenCounts = {};
    for (const t of closed) {
      const sym = t.tokenSymbol || t.tokenAddress;
      tokenCounts[sym] = (tokenCounts[sym] || 0) + 1;
    }
    const repeats = Object.entries(tokenCounts).filter(([, c]) => c > 1);
    if (repeats.length > 0) {
      console.log(`\nRepeat tokens: ${repeats.map(([s, c]) => `${s}(${c}x)`).join(', ')}`);
    }

    // Check open positions
    const open = await ScalpTrade.find({ userId: user._id, status: 'OPEN' }).lean();
    if (open.length > 0) {
      console.log(`\n${open.length} OPEN positions:`);
      for (const p of open) {
        const age = Math.round((Date.now() - new Date(p.createdAt).getTime()) / 60000);
        console.log(`  ${(p.tokenSymbol || '???').padEnd(12)} entry: $${p.entryPrice?.toFixed(8)} | $${p.amountIn?.toFixed(2)} | age: ${age}min`);
      }
    }
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
