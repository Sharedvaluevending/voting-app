#!/usr/bin/env node
// scripts/backtest.js – Run engine on current data (smoke test). Full historical backtest would need stored candles.
// Usage: node scripts/backtest.js
// Waits for crypto-api data refresh (prices + candles + history) before running.

const { analyzeAllCoins, ENGINE_CONFIG } = require('../services/trading-engine');
const { fetchAllPrices, fetchAllCandles, fetchAllHistory, pricesReadyPromise } = require('../services/crypto-api');

const BACKTEST_TIMEOUT_MS = 90000; // 90s – prices resolve after ~15–25s; candles/history may still load

async function main() {
  console.log('\n--- Backtest (current data) ---');
  console.log('Config: minScore', ENGINE_CONFIG.MIN_SIGNAL_SCORE, 'minConfluence', ENGINE_CONFIG.MIN_CONFLUENCE_FOR_SIGNAL);
  console.log('Waiting for prices...');

  await Promise.race([
    pricesReadyPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), BACKTEST_TIMEOUT_MS))
  ]);

  const [prices, allCandles, allHistory] = await Promise.all([
    fetchAllPrices(),
    Promise.resolve(fetchAllCandles()),
    fetchAllHistory()
  ]);

  if (!prices || prices.length === 0) {
    console.log('No prices – skip.');
    process.exit(0);
  }

  const options = {}; // no DB in script – strategyWeights/btcSignal optional
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
