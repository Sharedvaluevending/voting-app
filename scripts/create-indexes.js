#!/usr/bin/env node
/**
 * Create/update MongoDB indexes for hot collections.
 * Run this once per deploy when adding new schema indexes.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User');
const Trade = require('../models/Trade');
const Alert = require('../models/Alert');
const SetupNotification = require('../models/SetupNotification');
const ScalpTrade = require('../models/ScalpTrade');
const StrategyWeight = require('../models/StrategyWeight');
const CandleCache = require('../models/CandleCache');

async function main() {
  const uri = process.env.MONGODB_URI_STANDARD || process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI or MONGODB_URI_STANDARD is required');
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  });

  const models = [User, Trade, Alert, SetupNotification, ScalpTrade, StrategyWeight, CandleCache];
  for (const model of models) {
    const out = await model.createIndexes();
    console.log(`[indexes] ${model.modelName}: ${Array.isArray(out) ? out.length : 'ok'}`);
  }

  await mongoose.connection.close();
  console.log('[indexes] complete');
}

main().catch(async (err) => {
  console.error('[indexes] failed:', err.message);
  try { await mongoose.connection.close(); } catch (e) {}
  process.exit(1);
});
