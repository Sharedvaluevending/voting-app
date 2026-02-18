// tests/unit/risk-engine.test.js
// Unit tests for risk engine position sizing and order planning

const {
  plan,
  calculatePositionSize,
  suggestLeverage,
  MAX_SL_DISTANCE_PCT
} = require('../../services/engines/risk-engine');

describe('Risk Engine - calculatePositionSize', () => {
  test('returns finite position size for valid inputs', () => {
    const size = calculatePositionSize(10000, 2, 50000, 49000, 2, {});
    expect(Number.isFinite(size)).toBe(true);
    expect(size).toBeGreaterThan(0);
  });

  test('caps position at balance * leverage * 0.95', () => {
    const size = calculatePositionSize(10000, 50, 50000, 40000, 5, {});
    const maxAllowed = 10000 * 5 * 0.95;
    expect(size).toBeLessThanOrEqual(maxAllowed + 1); // allow small float tolerance
  });

  test('uses 2% stop fallback when stopLoss invalid', () => {
    const size = calculatePositionSize(10000, 2, 50000, 0, 2, {});
    expect(Number.isFinite(size)).toBe(true);
    expect(size).toBeGreaterThan(0);
  });

  test('dollar risk mode uses riskDollarsPerTrade', () => {
    const sizeDollar = calculatePositionSize(10000, 2, 50000, 49000, 2, {
      riskMode: 'dollar',
      riskDollarsPerTrade: 50
    });
    const sizePercent = calculatePositionSize(10000, 2, 50000, 49000, 2, { riskMode: 'percent' });
    expect(sizeDollar).toBeDefined();
    expect(Number.isFinite(sizeDollar)).toBe(true);
    expect(sizeDollar).toBeLessThan(sizePercent);
  });

  test('handles zero or invalid entry price', () => {
    const size = calculatePositionSize(10000, 2, 0, 49000, 2, {});
    expect(size).toBeGreaterThan(0);
    expect(Number.isFinite(size)).toBe(true);
  });
});

describe('Risk Engine - suggestLeverage', () => {
  test('returns higher leverage for higher scores', () => {
    const lev85 = suggestLeverage(85, 'trending', 'normal');
    const lev55 = suggestLeverage(55, 'trending', 'normal');
    const lev45 = suggestLeverage(45, 'trending', 'normal');
    expect(lev85).toBeGreaterThanOrEqual(lev55);
    expect(lev55).toBeGreaterThanOrEqual(lev45);
  });

  test('reduces leverage in ranging regime', () => {
    const levTrending = suggestLeverage(75, 'trending', 'normal');
    const levRanging = suggestLeverage(75, 'ranging', 'normal');
    expect(levRanging).toBeLessThanOrEqual(levTrending);
  });

  test('reduces leverage in high volatility', () => {
    const levNormal = suggestLeverage(75, 'trending', 'normal');
    const levHigh = suggestLeverage(75, 'trending', 'high');
    expect(levHigh).toBeLessThanOrEqual(levNormal);
  });
});

describe('Risk Engine - plan', () => {
  const validDecision = {
    side: 'LONG',
    entry: 50000,
    stopLoss: 49000,
    takeProfit1: 51500,
    takeProfit2: 52500,
    takeProfit3: 54000,
    coinId: 'bitcoin',
    symbol: 'BTC',
    strategy: 'trend_follow',
    regime: 'trending',
    score: 65,
    indicators: { atr: 500 }
  };

  const context = {
    balance: 10000,
    openTrades: [],
    streak: 0,
    strategyStats: {},
    featureFlags: {},
    userSettings: { riskPerTrade: 2, defaultLeverage: 2 }
  };

  test('returns null for invalid decision', () => {
    expect(plan(null, {}, context)).toBeNull();
    expect(plan({}, {}, context)).toBeNull();
    expect(plan({ side: 'LONG' }, {}, context)).toBeNull();
  });

  test('returns valid order plan for valid decision', () => {
    const orders = plan(validDecision, {}, context);
    expect(orders).toBeDefined();
    expect(orders.direction).toBe('LONG');
    expect(orders.entry).toBeGreaterThan(0);
    expect(orders.stopLoss).toBeLessThan(orders.entry);
    expect(orders.size).toBeGreaterThan(0);
    expect(orders.margin).toBeGreaterThan(0);
  });

  test('SL is capped at MAX_SL_DISTANCE_PCT', () => {
    const wideDecision = {
      ...validDecision,
      stopLoss: 30000
    };
    const orders = plan(wideDecision, {}, context);
    const slDist = Math.abs(orders.entry - orders.stopLoss) / orders.entry;
    expect(slDist).toBeLessThanOrEqual(MAX_SL_DISTANCE_PCT + 0.01);
  });

  test('SL on wrong side is corrected for LONG', () => {
    const badDecision = {
      ...validDecision,
      stopLoss: 51000
    };
    const orders = plan(badDecision, {}, context);
    expect(orders.stopLoss).toBeLessThan(orders.entry);
  });

  test('SL on wrong side is corrected for SHORT', () => {
    const shortDecision = {
      ...validDecision,
      side: 'SHORT',
      entry: 50000,
      stopLoss: 49000,
      takeProfit1: 48500,
      takeProfit2: 47500,
      takeProfit3: 46000
    };
    const orders = plan(shortDecision, {}, context);
    expect(orders.stopLoss).toBeGreaterThan(orders.entry);
  });

  test('returns null when balance is zero', () => {
    const orders = plan(validDecision, {}, { ...context, balance: 0 });
    expect(orders).toBeNull();
  });
});
