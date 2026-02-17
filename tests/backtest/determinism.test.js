// tests/backtest/determinism.test.js
// Same seed -> identical results

const assert = require('assert');
const path = require('path');
const { getPathSequence, POLICY, seededRandom } = require('../../services/backtest/intrabar-path');

const bar = { open: 100, high: 105, low: 95, close: 102 };

function testSeededRandom() {
  const r1 = seededRandom(42);
  const r2 = seededRandom(42);
  const vals1 = [r1(), r1(), r1()];
  const vals2 = [r2(), r2(), r2()];
  assert.deepEqual(vals1, vals2, 'Same seed should produce same sequence');
}

function testPathDeterminism() {
  const seq1 = getPathSequence(bar, 'LONG', POLICY.WORST_CASE, 123);
  const seq2 = getPathSequence(bar, 'LONG', POLICY.WORST_CASE, 123);
  assert.deepEqual(seq1, seq2, 'WORST_CASE should be deterministic');
}

function testRandomSeededDeterminism() {
  const seq1 = getPathSequence(bar, 'LONG', POLICY.RANDOM_SEEDED, 999);
  const seq2 = getPathSequence(bar, 'LONG', POLICY.RANDOM_SEEDED, 999);
  assert.deepEqual(seq1, seq2, 'RANDOM_SEEDED with same seed should be identical');
}

function testDifferentSeedsDifferent() {
  const seq1 = getPathSequence(bar, 'LONG', POLICY.RANDOM_SEEDED, 111);
  const seq2 = getPathSequence(bar, 'LONG', POLICY.RANDOM_SEEDED, 222);
  assert.notDeepEqual(seq1, seq2, 'Different seeds should produce different paths (with high probability)');
}

testSeededRandom();
testPathDeterminism();
testRandomSeededDeterminism();
testDifferentSeedsDifferent();
console.log('Determinism tests passed');
