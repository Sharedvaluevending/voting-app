#!/usr/bin/env node
// scripts/backtest.js – Run engine on current data (smoke test). Aligns with live app options when MongoDB available.
// Usage: node scripts/backtest.js

const mongoose = require('mongoose');
const { analyzeAllCoins, ENGINE_CONFIG } = require('../services/trading-engine');
const { fetchAllPrices, fetchAllCandles, fetchAllHistory, pricesReadyPromise } = require('../services/crypto-api');
const StrategyWeight = require('../models/StrategyWeight');

async function buildEngineOptions(prices, allCandles, allHistory) {
  const { analyzeCoin } = require('../services/trading-engine');
  const strategyWeights = await StrategyWeight.find({ active: true }).lean();
  const strategyStats = {};
  strategyWeights.forEach(s => {
    strategyStats[s.strategyId] = { totalTrades: s.performance?.totalTrades || 0 };
  });
  let btcSignal = null;
  const btcData = prices.find(p => p.id === 'bitcoin');
  if (btcData) {
    const btcCandles = allCandles && allCandles.bitcoin;
    const btcHistory = allHistory && allHistory.bitcoin || { prices: [], volumes: [] };
    const btcSig = analyzeCoin(btcData, btcCandles, btcHistory, { strategyWeights, strategyStats });
    btcSignal = btcSig.signal;
  }
  return { strategyWeights, strategyStats, btcSignal };
}

async function main() {
  console.log('\n--- Backtest (current data) ---');
  console.log('Config: minScore', ENGINE_CONFIG.MIN_SIGNAL_SCORE, 'minConfluence', ENGINE_CONFIG.MIN_CONFLUENCE_FOR_SIGNAL);

  // Wait for prices to be ready (same as live app)
  const waitMs = 120000;
  await Promise.race([
    pricesReadyPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for prices')), waitMs))
  ]).catch(err => {
    console.warn('[Backtest] Proceeding without waiting for prices:', err.message);
  });

  const [prices, allCandles, allHistory] = await Promise.all([
    fetchAllPrices(),
    Promise.resolve(fetchAllCandles()),
    fetchAllHistory()
  ]);

  if (!prices || prices.length === 0) {
    console.log('No prices – skip.');
    process.exit(0);
  }

  let options = {};
  const mongoURI = process.env.MONGODB_URI || process.env.MONGODB_URI_STANDARD;
  if (mongoURI) {
    try {
      await mongoose.connect(mongoURI);
      options = await buildEngineOptions(prices, allCandles, allHistory);
      await mongoose.disconnect();
      console.log('Using live-aligned options (strategyWeights, btcSignal)');
    } catch (err) {
      console.warn('[Backtest] MongoDB unavailable, using default options:', err.message);
    }
  } else {
    console.log('No MONGODB_URI – using default options (no strategyWeights/btcSignal)');
  }

  const signals = analyzeAllCoins(prices, allCandles, allHistory, options);
  const strongBuy = signals.filter(s => s.signal === 'STRONG_BUY').length;
  const buy = signals.filter(s => s.signal === 'BUY').length;
  const hold = signals.filter(s => s.signal === 'HOLD').length;
  const sell = signals.filter(s => s.signal === 'SELL').length;
  const strongSell = signals.filter(s => s.signal === 'STRONG_SELL').length;
  console.log('Signals:', { STRONG_BUY: strongBuy, BUY: buy, HOLD: hold, SELL: sell, STRONG_SELL: strongSell });
  console.log('Sample:', signals[0] ? { coin: signals[0].coin.symbol, signal: signals[0].signal, score: signals[0].score, strategy: signals[0].strategyName } : 'none');
  console.log('OK\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
