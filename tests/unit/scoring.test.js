// tests/unit/scoring.test.js
// Unit tests for trading engine scoring logic

const { analyzeCoin, ENGINE_CONFIG } = require('../../services/trading-engine');
const candles1h = require('../backtest/fixtures/small-candles.json');

// Build minimal candle set for 1h, 4h, 1d (trading engine needs 20+ bars for 1h)
function buildCandles(closePrice = 50000) {
  const bars = [];
  for (let i = 0; i < 50; i++) {
    bars.push({
      openTime: Date.now() - (50 - i) * 3600000,
      open: closePrice - 100,
      high: closePrice + 200,
      low: closePrice - 200,
      close: closePrice + (i % 2 === 0 ? 50 : -50),
      volume: 1000 + i * 10
    });
  }
  return {
    '1h': bars,
    '4h': bars.slice(-20).map((b, i) => ({ ...b, openTime: b.openTime - i * 4 * 3600000 })),
    '1d': bars.slice(-30).map((b, i) => ({ ...b, openTime: b.openTime - i * 24 * 3600000 }))
  };
}

describe('Trading Engine Scoring', () => {
  const coinData = {
    id: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    price: 50000,
    change24h: 2.5,
    volume24h: 1e9,
    marketCap: 1e12,
    lastUpdated: new Date()
  };

  test('analyzeCoin returns valid signal structure with candles', () => {
    const candles = buildCandles(50000);
    const result = analyzeCoin(coinData, candles, null, {});
    expect(result).toBeDefined();
    expect(result.signal).toBeDefined();
    expect(['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL']).toContain(result.signal);
    expect(result.score).toBeDefined();
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.coin).toBeDefined();
    expect(result.coin.id).toBe('bitcoin');
  });

  test('analyzeCoin returns valid regime', () => {
    const candles = buildCandles(50000);
    const result = analyzeCoin(coinData, candles, null, {});
    const validRegimes = ['trending', 'ranging', 'volatile', 'compression', 'mixed'];
    expect(result.regime).toBeDefined();
    expect(validRegimes).toContain(result.regime);
  });

  test('analyzeCoin returns confidenceInterval', () => {
    const candles = buildCandles(50000);
    const result = analyzeCoin(coinData, candles, null, {});
    expect(result.confidence).toBeDefined();
    expect(result.confidenceInterval).toBeDefined();
    expect(Array.isArray(result.confidenceInterval)).toBe(true);
    expect(result.confidenceInterval.length).toBe(2);
    expect(result.confidenceInterval[0]).toBeLessThanOrEqual(result.confidenceInterval[1]);
  });

  test('analyzeCoin falls back to basic signal with insufficient candles', () => {
    const result = analyzeCoin(coinData, { '1h': [] }, null, {});
    expect(result).toBeDefined();
    expect(result.signal).toBeDefined();
    expect(['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL']).toContain(result.signal);
  });

  test('analyzeCoin falls back to history when no candles', () => {
    const history = {
      prices: Array(15).fill(0).map((_, i) => [Date.now() - i * 3600000, 50000 - i * 100]),
      volumes: Array(15).fill(1e9)
    };
    const result = analyzeCoin(coinData, null, history, {});
    expect(result).toBeDefined();
    expect(result.signal).toBeDefined();
  });

  test('ENGINE_CONFIG has expected values', () => {
    expect(ENGINE_CONFIG.MIN_SIGNAL_SCORE).toBe(52);
    expect(ENGINE_CONFIG.MTF_DIVERGENCE_PENALTY).toBe(10);
    expect(ENGINE_CONFIG.SESSION_PENALTY).toBe(5);
  });

  test('uses fixture candles when available', () => {
    if (candles1h['1h'] && candles1h['1h'].length >= 20) {
      const lastClose = candles1h['1h'][candles1h['1h'].length - 1].close;
      const result = analyzeCoin(
        { ...coinData, price: lastClose },
        candles1h,
        null,
        {}
      );
      expect(result).toBeDefined();
      expect(result.signal).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });
});
