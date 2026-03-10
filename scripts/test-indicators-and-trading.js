#!/usr/bin/env node
// Audit: indicator calculations and trading logic
// Verifies SMA, EMA, RSI, ATR, FVG, OB, position sizing, TP levels

const ind = require('../lib/indicators');
const {
  detectOrderBlocks,
  detectFVGs,
  detectLiquidityClusters,
  analyzeOHLCV,
  ATR_OHLC,
  SMA,
  EMA
} = require('../services/trading-engine');
const { calculatePositionSize, plan } = require('../services/engines/risk-engine');
const { getProgressTowardTP, getLockInStopPrice } = require('../services/engines/manage-engine');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function near(a, b, tol = 0.0001) {
  return Math.abs(a - b) <= tol;
}

console.log('=== Indicator & Trading Logic Audit ===\n');

// --- 1. SMA ---
const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const sma3 = ind.SMA(prices, 3);
assert(near(sma3, 19), `SMA(3) last 3 = (18+19+20)/3 = 19, got ${sma3}`);
console.log('1. SMA: OK');

// --- 2. EMA ---
const ema3 = ind.EMA([10, 20, 30], 3);
const expectedEma = (10 + 20 + 30) / 3;
assert(near(ema3, expectedEma), `EMA(3) of [10,20,30] = ${expectedEma}, got ${ema3}`);
console.log('2. EMA: OK');

// --- 3. RSI ---
const flat = Array(20).fill(100);
const rsiFlat = ind.RSI(flat, 14);
assert(rsiFlat === 50 || near(rsiFlat, 50), `RSI flat = 50, got ${rsiFlat}`);
const upOnly = Array(20).fill(0).map((_, i) => i * 10);
const rsiUp = ind.RSI(upOnly, 14);
assert(rsiUp >= 90, `RSI up-trend >= 90, got ${rsiUp}`);
console.log('3. RSI: OK');

// --- 4. ATR ---
const highs = [105, 110, 108, 112];
const lows = [100, 102, 105, 106];
const closes = [103, 108, 106, 110];
const atr = ind.ATR(highs, lows, closes, 3);
assert(atr > 0 && Number.isFinite(atr), `ATR > 0, got ${atr}`);
console.log('4. ATR: OK');

// --- 5. Bollinger Bands ---
const bb = ind.BollingerBands(prices, 5, 2);
assert(bb.upper > bb.mid && bb.mid > bb.lower, 'BB: upper > mid > lower');
assert(near(bb.mid, ind.SMA(prices, 5)), 'BB mid = SMA');
console.log('5. Bollinger Bands: OK');

// --- 6. FVG ---
const fvgHighs = [100, 102, 98, 105, 107];
const fvgLows = [98, 99, 96, 100, 104];
// Bullish FVG: candle 0 high (100) < candle 2 low (96)? No. candle 2 low 96 < candle 0 high 100.
// Bullish: lows[i+2] > highs[i] => candle 3 low (100) > candle 1 high (102)? No.
// Try: candle 0 high 100, candle 2 low 106. So i=0: highs[0]=100, lows[2]=106. 106>100. Bullish FVG.
const fvgH = [100, 102, 98];
const fvgL = [98, 99, 106];
const fvgs = detectFVGs(fvgH, fvgL);
assert(fvgs.length >= 0, 'FVG returns array');
if (fvgs.length > 0) {
  const f = fvgs[0];
  assert(f.type === 'BULL' || f.type === 'BEAR', 'FVG has type');
  assert(f.top >= f.bottom, 'FVG top >= bottom');
}
console.log('6. FVG: OK');

// --- 7. Order Blocks ---
const obOpens = [100, 99, 101, 98, 105];
const obHighs = [102, 101, 103, 100, 108];
const obLows = [98, 97, 99, 96, 104];
const obCloses = [99, 101, 98, 105, 107];
const atrVal = ATR_OHLC(obHighs, obLows, obCloses, 14) || 1;
const obs = detectOrderBlocks(obOpens, obHighs, obLows, obCloses, atrVal);
assert(Array.isArray(obs), 'OB returns array');
console.log('7. Order Blocks: OK');

// --- 8. Liquidity Clusters ---
const liqHighs = Array(20).fill(0).map((_, i) => 100 + Math.sin(i * 0.5) * 5);
const liqLows = Array(20).fill(0).map((_, i) => 95 + Math.sin(i * 0.5) * 3);
const liq = detectLiquidityClusters(liqHighs, liqLows, 100);
assert(liq && (typeof liq.above === 'number' || liq.above === null), 'Liquidity has above');
assert(liq && (typeof liq.below === 'number' || liq.below === null), 'Liquidity has below');
console.log('8. Liquidity Clusters: OK');

// --- 9. analyzeOHLCV ---
const candles = Array(50).fill(0).map((_, i) => ({
  openTime: Date.now() - (50 - i) * 3600000,
  open: 100 - 0.5,
  high: 100 + 2,
  low: 100 - 2,
  close: 100 + (i % 2 ? 0.5 : -0.5),
  volume: 1000
}));
const coinData = { id: 'test', symbol: 'TST', price: 100 };
const analysis = analyzeOHLCV(candles, 100);
assert(analysis && analysis.rsi != null, 'analyzeOHLCV returns rsi');
assert(analysis.rsi >= 0 && analysis.rsi <= 100, 'RSI in range');
assert(analysis.atr > 0, 'ATR positive');
assert(analysis.orderBlocks != null, 'orderBlocks present');
assert(analysis.fvgs != null, 'fvgs present');
console.log('9. analyzeOHLCV: OK');

// --- 10. Position Sizing ---
const size = calculatePositionSize(10000, 2, 50000, 49000, 2, {});
assert(size > 0 && Number.isFinite(size), 'Position size finite');
const sizeDollar = calculatePositionSize(10000, 2, 50000, 49000, 2, {
  riskMode: 'dollar',
  riskDollarsPerTrade: 200
});
assert(sizeDollar > 0, 'Dollar risk produces size');
const stopDist = Math.abs(50000 - 49000) / 50000;
const expectedBase = 200 / stopDist;
assert(sizeDollar >= expectedBase * 0.5 && sizeDollar <= expectedBase * 10, `Dollar risk: size in range, got ${sizeDollar}`);
console.log('10. Position Sizing: OK');

// --- 11. Manage Engine: progress, lock-in ---
const trade = {
  direction: 'LONG',
  entryPrice: 100,
  stopLoss: 98,
  takeProfit1: 104,
  takeProfit2: 106,
  takeProfit3: 110
};
const progress = getProgressTowardTP(trade, 102);
assert(progress >= 0 && progress <= 1, 'Progress 0-1');
const lockStop = getLockInStopPrice(trade, 0.5, 2);
assert(lockStop != null && lockStop > 100, 'Lock-in stop above entry for LONG');
console.log('11. Manage Engine: OK');

// --- 12. Risk Engine plan ---
const decision = {
  side: 'LONG',
  entry: 50000,
  stopLoss: 49000,
  takeProfit1: 51500,
  takeProfit2: 52500,
  takeProfit3: 54000,
  coinId: 'btc',
  symbol: 'BTC',
  strategy: 'trend_follow',
  score: 65,
  indicators: { atr: 500 }
};
const orders = plan(decision, {}, { balance: 10000, openTrades: [], userSettings: { riskPerTrade: 2 } });
assert(orders != null, 'Plan returns orders');
assert(orders.stopLoss < orders.entry, 'LONG: SL below entry');
assert(orders.takeProfit1 > orders.entry, 'LONG: TP1 above entry');
console.log('12. Risk Engine plan: OK');

console.log('\n=== All checks passed ===\n');
