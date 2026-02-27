#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../models/User');
  const user = await User.findOne({ username: 'mike' }).lean();
  if (!user) { console.log('User not found'); process.exit(0); }

  console.log('=== trenchAuto settings ===');
  const s = user.trenchAuto || {};
  console.log(JSON.stringify(s, null, 2));

  console.log('\n=== trenchStats ===');
  console.log(JSON.stringify(user.trenchStats || {}, null, 2));

  console.log('\n=== Key values ===');
  console.log('consecutiveLossesToPause:', s.consecutiveLossesToPause);
  console.log('cooldownHours:', s.cooldownHours);
  console.log('maxOpenPositions:', s.maxOpenPositions);
  console.log('slPercent:', s.slPercent);
  console.log('tpPercent:', s.tpPercent);
  console.log('maxHoldMinutes:', s.maxHoldMinutes);
  console.log('mode:', s.mode);
  console.log('profitPayoutAddress:', s.profitPayoutAddress || '(not set)');
  console.log('profitPayoutPercent:', s.profitPayoutPercent || 0);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
