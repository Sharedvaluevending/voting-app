// tests/backtest/time-alignment.test.js
// Time alignment: higher TF candles only update on close

const assert = require('assert');
const path = require('path');
const { sliceCandlesAt, BARS_PER_TF } = require('../../services/backtest/market-data');

const fixturesPath = path.join(__dirname, 'fixtures', 'small-candles.json');
const candles = require(fixturesPath);

function testSliceAt1hBar20RequiresWarmup() {
  const slice = sliceCandlesAt(candles, 20, '1h');
  assert.equal(slice, null, 'Slice should be null before 1h warm-up (50 bars)');
}

function testSliceAt1hBar23RequiresWarmup() {
  const slice = sliceCandlesAt(candles, 23, '1h');
  assert.equal(slice, null, 'Slice should still be null before warm-up threshold');
}

function testSliceAt1hBar50FirstValidSlice() {
  const slice = sliceCandlesAt(candles, 50, '1h');
  assert(slice, 'Slice should exist once warm-up is satisfied');
  assert.equal(slice['1h'].length, 51, '1h should have 51 bars');
  const closed4h = Math.floor(51 / 4);
  assert.equal(closed4h, 12, 'At t=50 we have 12 closed 4h bars');
  assert(slice['4h'] && slice['4h'].length === closed4h, '4h should include only closed bars');
  const closed1d = Math.floor(51 / 24);
  assert.equal(closed1d, 2, 'At t=50 we have 2 closed 1d bars');
  assert(slice['1d'] && slice['1d'].length === closed1d, '1d should include only closed bars');
}

function testBarsPerTF() {
  assert(BARS_PER_TF['1h']['4h'] === 4, '4 bars of 1h per 4h');
  assert(BARS_PER_TF['1h']['1d'] === 24, '24 bars of 1h per 1d');
}

testSliceAt1hBar20RequiresWarmup();
testSliceAt1hBar23RequiresWarmup();
testSliceAt1hBar50FirstValidSlice();
testBarsPerTF();
console.log('Time alignment tests passed');
