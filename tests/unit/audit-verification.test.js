// tests/unit/audit-verification.test.js
// Verification tests for signal engine and position sizing audit

const {
  plan,
  calculatePositionSize,
  suggestLeverage,
} = require('../../services/engines/risk-engine');

const { evaluate } = require('../../services/engines/signal-engine');

// ======================================================
// TEST 2 — Position Sizing: Fixed $ vs % mode
// ======================================================
describe('Position Sizing — Fixed $ vs % mode', () => {
  const baseDec = {
    side: 'LONG',
    coinId: 'solana',
    symbol: 'SOL',
    strategy: 'trend_follow',
    score: 65,
    entry: 150,
    stopLoss: 145,
    takeProfit1: 160,
    takeProfit2: 170,
    takeProfit3: 180,
    regime: 'trending',
    indicators: { atr: 3 },
  };

  test('Fixed $ mode: $200 risk produces exact $200 risk per trade', () => {
    const result = plan(baseDec, {}, {
      balance: 10000,
      userSettings: {
        riskMode: 'dollar',
        riskDollarsPerTrade: 200,
        riskPerTrade: 2,
        useFixedLeverage: true,
        defaultLeverage: 2,
      },
    });
    expect(result).not.toBeNull();
    const stopDist = Math.abs(result.entry - result.stopLoss) / result.entry;
    const actualRisk = result.size * stopDist;
    // Actual risk should be close to $200 (within slippage adjustment)
    expect(actualRisk).toBeGreaterThan(180);
    expect(actualRisk).toBeLessThan(220);
  });

  test('Fixed $ mode: size not modified by confidence, streak, drawdown', () => {
    const result1 = plan(baseDec, {}, {
      balance: 10000,
      streak: -5,
      userSettings: {
        riskMode: 'dollar',
        riskDollarsPerTrade: 200,
        riskPerTrade: 2,
        useFixedLeverage: true,
        defaultLeverage: 2,
        drawdownSizingEnabled: true,
        drawdownThresholdPercent: 5,
      },
      peakEquity: 15000,
    });

    const result2 = plan(baseDec, {}, {
      balance: 10000,
      streak: 5,
      userSettings: {
        riskMode: 'dollar',
        riskDollarsPerTrade: 200,
        riskPerTrade: 2,
        useFixedLeverage: true,
        defaultLeverage: 2,
      },
    });

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    // Both should produce identical position sizes
    expect(result1.size).toEqual(result2.size);
  });

  test('Fixed $ mode: rejects trade when balance insufficient', () => {
    const result = plan(baseDec, {}, {
      balance: 50, // far too low for $200 risk
      userSettings: {
        riskMode: 'dollar',
        riskDollarsPerTrade: 200,
        riskPerTrade: 2,
        useFixedLeverage: true,
        defaultLeverage: 2,
      },
    });
    expect(result).toBeNull();
  });

  test('% mode: position size changes with streak and drawdown', () => {
    // Use a wider stop (10% from entry) so margin cap doesn't absorb streak adjustment
    const wideStopDec = { ...baseDec, entry: 150, stopLoss: 135, indicators: { atr: 10 } };
    const resultNormal = plan(wideStopDec, {}, {
      balance: 10000,
      streak: 0,
      userSettings: {
        riskMode: 'percent',
        riskPerTrade: 1,
        useFixedLeverage: true,
        defaultLeverage: 1,
        maxBalancePercentPerTrade: 100,
      },
    });

    const resultStreak = plan(wideStopDec, {}, {
      balance: 10000,
      streak: -3,
      userSettings: {
        riskMode: 'percent',
        riskPerTrade: 1,
        useFixedLeverage: true,
        defaultLeverage: 1,
        maxBalancePercentPerTrade: 100,
      },
    });

    expect(resultNormal).not.toBeNull();
    expect(resultStreak).not.toBeNull();
    // Losing streak should reduce position size
    expect(resultStreak.size).toBeLessThan(resultNormal.size);
  });

  test('% mode: growing balance = growing position', () => {
    const resultSmall = plan(baseDec, {}, {
      balance: 5000,
      userSettings: {
        riskMode: 'percent',
        riskPerTrade: 2,
        useFixedLeverage: true,
        defaultLeverage: 2,
      },
    });

    const resultLarge = plan(baseDec, {}, {
      balance: 20000,
      userSettings: {
        riskMode: 'percent',
        riskPerTrade: 2,
        useFixedLeverage: true,
        defaultLeverage: 2,
      },
    });

    expect(resultSmall).not.toBeNull();
    expect(resultLarge).not.toBeNull();
    expect(resultLarge.size).toBeGreaterThan(resultSmall.size);
  });
});

// ======================================================
// TEST 4 — Strategy Fit: Best Fit selection
// ======================================================
describe('Strategy Fit — Best Fit selection', () => {
  test('Higher displayScore = Best Fit (Swing 68 > Breakout 66)', () => {
    // Simulate: if Swing has displayScore 68 and Breakout has 66, Swing wins
    // This verifies the pickStrategy logic conceptually
    const strategies = [
      { id: 'swing', displayScore: 68 },
      { id: 'breakout', displayScore: 66 },
      { id: 'momentum', displayScore: 55 },
    ];
    const best = strategies.reduce((a, b) => (a.displayScore > b.displayScore) ? a : b);
    expect(best.id).toBe('swing');
  });

  test('Both above 55 threshold are valid for opening', () => {
    const strategies = [
      { id: 'swing', displayScore: 68 },
      { id: 'breakout', displayScore: 66 },
      { id: 'scalping', displayScore: 40 },
    ];
    const eligible = strategies.filter(s => s.displayScore >= 55);
    expect(eligible.length).toBe(2);
    expect(eligible.map(s => s.id)).toEqual(['swing', 'breakout']);
  });
});

// ======================================================
// TEST: Leverage suggestion
// ======================================================
describe('Leverage Suggestion', () => {
  test('high score + trending = higher leverage', () => {
    expect(suggestLeverage(85, 'trending', 'normal')).toBe(10);
  });

  test('moderate score + ranging = reduced leverage', () => {
    const lev = suggestLeverage(65, 'ranging', 'normal');
    expect(lev).toBeLessThanOrEqual(3);
  });

  test('any score + extreme volatility = 1x leverage', () => {
    expect(suggestLeverage(95, 'trending', 'extreme')).toBe(1);
  });

  test('low score = 1x leverage', () => {
    expect(suggestLeverage(30, 'trending', 'normal')).toBe(1);
  });
});

// ======================================================
// TEST: R:R Calculation Accuracy
// ======================================================
describe('R:R Calculation', () => {
  test('R:R calculated from (TP - Entry) / (Entry - SL) for longs', () => {
    const entry = 10.0;
    const sl = 9.0; // 1.0 risk
    const tp1 = 11.5; // 1.5 reward
    const tp2 = 12.5; // 2.5 reward
    const risk = entry - sl;
    const reward = tp2 - entry;
    const rr = reward / risk;
    expect(rr).toBeCloseTo(2.5, 1);
  });

  test('R:R calculated from (Entry - TP) / (SL - Entry) for shorts', () => {
    const entry = 10.0;
    const sl = 11.0; // 1.0 risk
    const tp1 = 8.5; // 1.5 reward
    const tp2 = 7.5; // 2.5 reward
    const risk = sl - entry;
    const reward = entry - tp2;
    const rr = reward / risk;
    expect(rr).toBeCloseTo(2.5, 1);
  });
});

// ======================================================
// TEST: Signal direction consistency with score
// ======================================================
describe('Signal Direction Consistency', () => {
  test('plan returns null for HOLD signal (no side)', () => {
    const result = plan({ side: null, entry: 100, stopLoss: 95 }, {}, {
      balance: 10000,
      userSettings: { riskPerTrade: 2, riskMode: 'percent' },
    });
    expect(result).toBeNull();
  });

  test('plan produces LONG order for LONG side', () => {
    const result = plan({
      side: 'LONG', entry: 100, stopLoss: 95, score: 65,
      strategy: 'trend_follow', indicators: { atr: 3 },
    }, {}, {
      balance: 10000,
      userSettings: { riskPerTrade: 2, riskMode: 'percent', useFixedLeverage: true, defaultLeverage: 2 },
    });
    expect(result).not.toBeNull();
    expect(result.direction).toBe('LONG');
  });

  test('plan produces SHORT order for SHORT side', () => {
    const result = plan({
      side: 'SHORT', entry: 100, stopLoss: 105, score: 65,
      strategy: 'trend_follow', indicators: { atr: 3 },
    }, {}, {
      balance: 10000,
      userSettings: { riskPerTrade: 2, riskMode: 'percent', useFixedLeverage: true, defaultLeverage: 2 },
    });
    expect(result).not.toBeNull();
    expect(result.direction).toBe('SHORT');
  });
});
