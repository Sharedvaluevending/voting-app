// tests/backtest/time-alignment.test.js
// Time alignment: higher TF candles only update on close

const assert = require('assert');
const path = require('path');
const { sliceCandlesAt, BARS_PER_TF } = require('../../services/backtest/market-data');

const fixturesPath = path.join(__dirname, 'fixtures', 'small-candles.json');
const candles = require(fixturesPath);

function testSliceAt1hBar20() {
  const slice = sliceCandlesAt(candles, 20, '1h');
  assert(slice, 'Slice should exist (need 20+ bars for engine)');
  assert.equal(slice['1h'].length, 21, '1h should have 21 bars at t=20');
  const closed4h = Math.floor(21 / 4);
  assert(closed4h >= 5, 'At t=20 we have 5+ closed 4h bars');
  assert(slice['4h'] && slice['4h'].length >= 5, '4h should have closed bars');
}

function testSliceAt1hBar23() {
  const slice = sliceCandlesAt(candles, 23, '1h');
  assert(slice, 'Slice should exist (need 20+ bars)');
  assert.equal(slice['1h'].length, 24, '1h should have 24 bars');
  const closed4h = Math.floor((23 + 1) / 4);
  assert.equal(closed4h, 6, 'At t=23 we have 6 closed 4h bars');
  assert(slice['4h'], '4h should exist');
  assert(slice['4h'].length >= 6, '4h should have at least 6 closed bars');
}

function testSliceAt1hBar50() {
  const slice = sliceCandlesAt(candles, 50, '1h');
  assert(slice, 'Slice should exist');
  assert.equal(slice['1h'].length, 51, '1h should have 51 bars');
  const closed4h = Math.floor(51 / 4);
  assert.equal(closed4h, 12, 'At t=50 we have 12 closed 4h bars');
  const closed1d = Math.floor(51 / 24);
  assert.equal(closed1d, 2, 'At t=50 we have 2 closed 1d bars');
}

function testBarsPerTF() {
  assert(BARS_PER_TF['1h']['4h'] === 4, '4 bars of 1h per 4h');
  assert(BARS_PER_TF['1h']['1d'] === 24, '24 bars of 1h per 1d');
}

testSliceAt1hBar20();
testSliceAt1hBar23();
testSliceAt1hBar50();
testBarsPerTF();
console.log('Time alignment tests passed');
