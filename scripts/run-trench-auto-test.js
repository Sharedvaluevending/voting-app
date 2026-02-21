#!/usr/bin/env node
/**
 * Run Trench Auto Trade for real (needs MongoDB + a user)
 * Usage: node scripts/run-trench-auto-test.js [userId]
 * If no userId, uses first user in DB. Enables auto, runs, logs result.
 * Loads .env so MONGODB_URI from your project works.
 */
const path = require('path');
const fs = require('fs');
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  }
} catch (e) { /* ignore */ }

const mongoose = require('mongoose');
const User = require('../models/User');
const trenchAuto = require('../services/trench-auto-trading');

const mongoURI = process.env.MONGODB_URI_STANDARD || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/votingApp';

async function main() {
  const userId = process.argv[2];
  console.log('=== Trench Auto Run Test ===\n');
  console.log('Connecting to MongoDB...');
  await mongoose.connect(mongoURI);
  let user;
  if (userId) {
    user = await User.findById(userId);
    if (!user) {
      console.error('User not found:', userId);
      process.exit(1);
    }
  } else {
    user = await User.findOne();
    if (!user) {
      console.error('No users in DB. Create one first.');
      process.exit(1);
    }
    console.log('Using first user:', user.username || user._id);
  }
  if (!user.trenchAuto) user.trenchAuto = {};
  user.trenchAuto.enabled = true;
  user.trenchAuto.mode = 'paper';
  user.trenchAuto.useEntryFilters = false;
  user.trenchAuto.minTrendingScore = 0;
  user.trenchPaperBalance = user.trenchPaperBalance ?? 1000;
  await user.save({ validateBeforeSave: false });
  console.log('Auto enabled, balance:', user.trenchPaperBalance);
  console.log('\nRunning runTrenchAutoTrade...');
  const result = await trenchAuto.runTrenchAutoTrade({ forceRun: true, runForUserId: user._id });
  console.log('\nResult:', JSON.stringify(result, null, 2));
  await mongoose.disconnect();
  process.exit(result.trades > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
