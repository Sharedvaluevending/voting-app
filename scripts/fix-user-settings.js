#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../models/User');

  const result = await User.updateOne(
    { username: 'mike' },
    {
      $set: {
        'trenchAuto.consecutiveLossesToPause': 3,
        'trenchAuto.cooldownHours': 1,
        'trenchAuto.minTrendingScore': 1,
        'trenchAuto.minLiquidityUsd': 10000,
        'trenchAuto.maxPriceChange24hPercent': 500,
        'trenchAuto.maxTop10HoldersPercent': 80,
        'trenchAuto.checkIntervalMinutes': 1,
      }
    }
  );

  console.log('Updated:', result.modifiedCount, 'document(s)');

  const user = await User.findOne({ username: 'mike' }).lean();
  const s = user.trenchAuto;
  console.log('\n=== Updated settings ===');
  console.log('consecutiveLossesToPause:', s.consecutiveLossesToPause);
  console.log('cooldownHours:', s.cooldownHours);
  console.log('minTrendingScore:', s.minTrendingScore);
  console.log('minLiquidityUsd:', s.minLiquidityUsd);
  console.log('maxPriceChange24hPercent:', s.maxPriceChange24hPercent);
  console.log('maxTop10HoldersPercent:', s.maxTop10HoldersPercent);
  console.log('checkIntervalMinutes:', s.checkIntervalMinutes);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
