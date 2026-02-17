// tests/backtest/trade-state.test.js
// Trade state machine invariants

const assert = require('assert');
const {
  createTrade,
  isValidStopMove,
  validateLevels,
  applyAction
} = require('../../services/backtest/trade-state');

function testCreateTrade() {
  const orders = {
    direction: 'LONG',
    entry: 50000,
    stopLoss: 49000,
    size: 1000,
    symbol: 'BTC',
    coinId: 'bitcoin',
    strategy: 'trend_follow',
    regime: 'trending'
  };
  const trade = createTrade(orders, 10, 'test-1');
  assert.equal(trade.direction, 'LONG');
  assert.equal(trade.entry, 50000);
  assert.equal(trade.entryPrice, 50000);
  assert.equal(trade.stopLoss, 49000);
  assert.equal(trade.status, 'OPEN');
}

function testValidStopMoveLong() {
  const trade = { direction: 'LONG', stopLoss: 49000, maxPrice: 51000 };
  assert(isValidStopMove(trade, 49500), 'Moving SL up (toward safety) should be valid');
  assert(!isValidStopMove(trade, 48500), 'Moving SL down (widen risk) should be invalid');
}

function testValidStopMoveShort() {
  const trade = { direction: 'SHORT', stopLoss: 51000, minPrice: 49000 };
  assert(isValidStopMove(trade, 50500), 'Moving SL down (toward safety) should be valid');
  assert(!isValidStopMove(trade, 51500), 'Moving SL up (widen risk) should be invalid');
}

function testValidateLevels() {
  assert(validateLevels({ direction: 'LONG', entry: 100, stopLoss: 95, takeProfit1: 110 }), 'Valid LONG levels');
  assert(!validateLevels({ direction: 'LONG', entry: 100, stopLoss: 105 }), 'Invalid: SL above entry for LONG');
}

function testApplyBEAction() {
  const trade = createTrade({
    direction: 'LONG',
    entry: 50000,
    stopLoss: 49000,
    size: 1000,
    symbol: 'BTC',
    coinId: 'bitcoin'
  }, 0);
  const { trade: updated, error } = applyAction(trade, { type: 'BE', newStop: 50150, marketPrice: 50500 });
  assert(!error, 'Should not error');
  assert.equal(updated.stopLoss, 50150);
  assert(updated.breakevenHit);
}

testCreateTrade();
testValidStopMoveLong();
testValidStopMoveShort();
testValidateLevels();
testApplyBEAction();
console.log('Trade state tests passed');
