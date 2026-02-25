#!/usr/bin/env node
// scripts/backtest.js – Run engine on current data (smoke test). Full historical backtest would need stored candles.
// Usage: node scripts/backtest.js
// Waits for initial data load before running (up to 2 min).

const { analyzeAllCoins, analyzeCoin, ENGINE_CONFIG } = require('../services/trading-engine');
const { fetchAllPrices, fetchAllCandles, fetchAllHistory, getRefreshCompletePromise } = require('../services/crypto-api');

async function buildEngineOptionsStandalone(prices, allCandles, allHistory) {
  // Try MongoDB for parity with live app when MONGODB_URI is set
  const mongoURI = process.env.MONGODB_URI || process.env.MONGODB_URI_STANDARD;
  if (!mongoURI) return {};

  try {
    const mongoose = require('mongoose');
    await mongoose.connect(mongoURI, { serverSelectionTimeoutMS: 3000 });
    const StrategyWeight = require('../models/StrategyWeight');
    const strategyWeights = await StrategyWeight.find({ active: true }).lean();
    const strategyStats = {};
    strategyWeights.forEach(s => {
      strategyStats[s.strategyId] = { totalTrades: s.performance?.totalTrades || 0 };
    });
    let btcSignal = null;
    const btcData = prices.find(p => p.id === 'bitcoin');
    if (btcData) {
      const btcCandles = allCandles?.bitcoin;
      const btcHistory = allHistory?.bitcoin || { prices: [], volumes: [] };
      const btcSig = analyzeCoin(btcData, btcCandles, btcHistory, { strategyWeights, strategyStats });
      btcSignal = btcSig.signal;
    }
    await mongoose.disconnect();
    return { strategyWeights, strategyStats, btcSignal };
  } catch (_) {
    return {};
  }
}

async function main() {
  console.log('\n--- Backtest (current data) ---');
  console.log('Config: minScore', ENGINE_CONFIG.MIN_SIGNAL_SCORE, 'minConfluence', ENGINE_CONFIG.MIN_CONFLUENCE_FOR_SIGNAL);

  // Wait for full data load (prices + candles/history) so engine has proper OHLCV
  const WAIT_MS = 120000;
  console.log('Waiting for data (up to', Math.round(WAIT_MS / 1000), 's)...');
  await Promise.race([
    getRefreshCompletePromise(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), WAIT_MS))
  ]).catch(() => {
    console.log('(timeout – continuing with cached data if any)');
  });

  const [prices, allCandles, allHistory] = await Promise.all([
    fetchAllPrices(),
    Promise.resolve(fetchAllCandles()),
    fetchAllHistory()
  ]);
  if (!prices || prices.length === 0) {
    console.log('No prices – skip. Ensure APIs (CoinGecko/CoinCap/Kraken) are reachable.');
    process.exit(0);
  }
  const options = await buildEngineOptionsStandalone(prices, allCandles, allHistory);
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
