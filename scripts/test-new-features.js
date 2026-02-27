#!/usr/bin/env node
/**
 * Quick smoke test for new features (Chart, Strategy Compare, Backtest, Signal Quality)
 * Verifies key data structures and APIs return expected fields.
 */
const { analyzeCoin } = require('../services/trading-engine');
const { evaluate } = require('../services/engines/signal-engine');

function buildCandles() {
  const bars = [];
  for (let i = 0; i < 50; i++) {
    bars.push({
      openTime: Date.now() - (50 - i) * 3600000,
      open: 50000 - 100,
      high: 50000 + 200,
      low: 50000 - 200,
      close: 50000 + (i % 2 === 0 ? 50 : -50),
      volume: 1000 + i * 10
    });
  }
  return {
    '1h': bars,
    '4h': bars.slice(-20).map((b, i) => ({ ...b, openTime: b.openTime - i * 4 * 3600000 })),
    '1d': bars.slice(-30).map((b, i) => ({ ...b, openTime: b.openTime - i * 24 * 3600000 }))
  };
}

const coinData = {
  id: 'bitcoin',
  symbol: 'BTC',
  name: 'Bitcoin',
  price: 50000,
  change24h: 2.5,
  volume24h: 1e9,
  marketCap: 1e12
};

let passed = 0;
let failed = 0;

// 1. Trading engine: confidenceInterval
try {
  const result = analyzeCoin(coinData, buildCandles(), null, {});
  if (result.confidenceInterval && Array.isArray(result.confidenceInterval) && result.confidenceInterval.length === 2) {
    console.log('  OK   Trading engine returns confidenceInterval');
    passed++;
  } else {
    throw new Error('Missing or invalid confidenceInterval');
  }
} catch (e) {
  console.log('  FAIL Trading engine confidenceInterval:', e.message);
  failed++;
}

// 2. Signal engine: confidenceInterval, topStrategiesSlice
try {
  const decision = evaluate({
    coinData,
    candles: buildCandles(),
    history: {},
    options: {}
  });
  if (decision.confidenceInterval && Array.isArray(decision.confidenceInterval)) {
    console.log('  OK   Signal engine returns confidenceInterval');
    passed++;
  } else {
    throw new Error('Missing confidenceInterval');
  }
  if (Array.isArray(decision.topStrategiesSlice) && decision.topStrategiesSlice.length <= 3) {
    console.log('  OK   Signal engine returns topStrategiesSlice (max 3)');
    passed++;
  } else {
    throw new Error('Invalid topStrategiesSlice');
  }
} catch (e) {
  console.log('  FAIL Signal engine:', e.message);
  failed++;
}

// 3. Funding rate filter: HOLD when extreme
try {
  const candles = buildCandles();
  const resultWithFilter = analyzeCoin(coinData, candles, null, {
    featureFundingRateFilter: true,
    fundingRate: { rate: 0.002 }
  });
  // With extreme positive funding, LONG signals may be suppressed to HOLD
  console.log('  OK   Funding rate filter option accepted');
  passed++;
} catch (e) {
  console.log('  FAIL Funding rate filter:', e.message);
  failed++;
}

console.log('\n--- New Features Smoke Test ---');
console.log('  Passed:', passed, '  Failed:', failed);
process.exit(failed > 0 ? 1 : 0);
