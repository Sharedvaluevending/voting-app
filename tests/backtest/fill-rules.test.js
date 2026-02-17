// tests/backtest/fill-rules.test.js
// Fill rules for market, limit, stop orders

const assert = require('assert');
const {
  execute,
  fillMarketOrder,
  wouldLimitFill,
  applySlippage
} = require('../../services/backtest/execution-simulator');

function testMarketOrderFill() {
  const order = { direction: 'LONG', size: 1000, entry: 50000 };
  const snapshot = { currentPrice: 50000, coinData: { price: 50000 } };
  const result = fillMarketOrder(order, snapshot, {});
  assert(result.filled, 'Market order should fill');
  assert(result.fillPrice > 50000, 'LONG entry should pay more (slippage)');
  assert(result.fees > 0, 'Should have fees');
}

function testLimitOrderNoFill() {
  const bar = { open: 50000, high: 50100, low: 49950, close: 50050 };
  const filled = wouldLimitFill(49800, 'LONG', bar, 5);
  assert(!filled, 'Buy limit at 49800 should not fill when low is 49950 (price never reached limit)');
}

function testLimitOrderFill() {
  const bar = { open: 50000, high: 50100, low: 49800, close: 50050 };
  const filled = wouldLimitFill(49900, 'LONG', bar, 5);
  assert(filled, 'Buy limit at 49900 should fill when low is 49800');
}

function testApplySlippage() {
  const price = 100;
  const longEntry = applySlippage(price, 'LONG', 10, true);
  assert(longEntry > 100, 'LONG entry pays more');
  const shortEntry = applySlippage(price, 'SHORT', 10, true);
  assert(shortEntry < 100, 'SHORT entry pays less (receives more)');
}

function testExecuteMarket() {
  const order = { direction: 'LONG', size: 1000, orderType: 'market' };
  const snapshot = { currentPrice: 50000 };
  const result = execute(order, snapshot, {});
  assert(result.filled, 'Execute market should fill');
}

testMarketOrderFill();
testLimitOrderNoFill();
testLimitOrderFill();
testApplySlippage();
testExecuteMarket();
console.log('Fill rules tests passed');
