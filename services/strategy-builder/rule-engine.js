// services/strategy-builder/rule-engine.js
// ====================================================
// RULE ENGINE - Evaluates strategy rules on candle data
// Returns BUY | SELL | HOLD per bar
// ====================================================

const ind = require('../../lib/indicators');

/**
 * Evaluate entry/exit rules at bar index t.
 * @param {Array} candles - OHLCV candles [{open,high,low,close,volume,openTime}]
 * @param {Object} strategy - { entry, exit }
 * @param {number} t - Bar index (0-based)
 * @returns {{ signal: 'BUY'|'SELL'|'HOLD', entry: boolean, exit: boolean }}
 */
function evaluateBar(candles, strategy, t) {
  if (!candles || t < 50 || t >= candles.length - 1) return { signal: 'HOLD', entry: false, exit: false };
  if (!strategy || !strategy.entry || !strategy.exit) return { signal: 'HOLD', entry: false, exit: false };

  const slice = candles.slice(0, t + 1);
  const closes = slice.map(c => c.close);
  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);
  const currentPrice = closes[closes.length - 1];

  const entryMet = evalCondition(strategy.entry, { candles: slice, closes, highs, lows, currentPrice, t });
  const exitMet = evalCondition(strategy.exit, { candles: slice, closes, highs, lows, currentPrice, t });

  if (exitMet) return { signal: 'HOLD', entry: false, exit: true };
  if (entryMet) {
    const dir = strategy.direction === 'SHORT' ? 'SELL' : 'BUY';
    return { signal: dir, entry: true, exit: false };
  }
  return { signal: 'HOLD', entry: false, exit: false };
}

function evalCondition(cond, ctx) {
  if (!cond) return false;
  if (cond.type === 'and') {
    return (cond.conditions || []).every(c => evalCondition(c, ctx));
  }
  if (cond.type === 'or') {
    return (cond.conditions || []).some(c => evalCondition(c, ctx));
  }

  const { closes, highs, lows, candles, currentPrice } = ctx;

  switch (cond.type) {
    case 'ema_crossover': {
      const fast = ind.EMASeries(closes, cond.fast || 9);
      const slow = ind.EMASeries(closes, cond.slow || 21);
      if (cond.direction === 'above') return ind.crossedAbove(fast, slow);
      return ind.crossedBelow(fast, slow);
    }
    case 'macd_crossover': {
      const { macd, signal } = ind.MACDSeries(closes, cond.fast || 12, cond.slow || 26, cond.signal || 9);
      if (macd.length < 2 || signal.length < 2) return false;
      const m1 = macd[macd.length - 2];
      const m2 = macd[macd.length - 1];
      const s1 = signal[signal.length - 2];
      const s2 = signal[signal.length - 1];
      if (cond.direction === 'above') return m1 <= s1 && m2 > s2;
      return m1 >= s1 && m2 < s2;
    }
    case 'rsi_range': {
      const rsi = ind.RSI(closes, cond.period || 14);
      if (cond.min != null && rsi < cond.min) return false;
      if (cond.max != null && rsi > cond.max) return false;
      return true;
    }
    case 'stoch_crossover': {
      const stoch = ind.Stochastic(highs, lows, closes, cond.period || 14);
      if (cond.inOversold && stoch.k >= 25) return false;
      if (cond.inOverbought && stoch.k <= 75) return false;
      if (cond.direction === 'above') return stoch.k > stoch.d;
      return stoch.k < stoch.d;
    }
    case 'bb_touch': {
      const bb = ind.BollingerBands(closes, cond.period || 20, cond.stdDev || 2);
      const range = bb.upper - bb.lower;
      if (range === 0) return false;
      const dist = Math.abs(currentPrice - (cond.band === 'lower' ? bb.lower : cond.band === 'upper' ? bb.upper : bb.mid)) / range;
      return dist < 0.02;
    }
    case 'bb_squeeze_break': {
      const bb = ind.BollingerBands(closes, cond.period || 20, cond.stdDev || 2);
      const width = bb.upper - bb.lower;
      const prevWidth = closes.length >= 50 ? (() => {
        const prev = ind.BollingerBands(closes.slice(0, -1), 20, 2);
        return prev.upper - prev.lower;
      })() : width * 1.5;
      if (width < prevWidth * 0.8) return false; // Was squeezed
      if (cond.direction === 'above') return currentPrice > bb.upper;
      return currentPrice < bb.lower;
    }
    case 'price_above':
    case 'price_below':
    case 'price_at_or_above':
    case 'price_near': {
      let ref = 0;
      if (cond.indicator === 'ema') ref = ind.EMA(closes, cond.period || 21);
      else if (cond.indicator === 'vwap') ref = ind.VWAP(candles);
      else if (cond.indicator === 'keltner_mid') {
        const kc = ind.KeltnerChannel(candles, cond.period || 20, 2);
        ref = kc.mid;
      }
      if (ref <= 0) return false;
      const pct = (cond.pct || 0) / 100;
      if (cond.type === 'price_above') return currentPrice > ref;
      if (cond.type === 'price_below') return currentPrice < ref * (1 - (cond.pct || 0) / 100);
      if (cond.type === 'price_at_or_above') return currentPrice >= ref;
      if (cond.type === 'price_near') return Math.abs(currentPrice - ref) / ref < (pct || 0.005);
      return false;
    }
    case 'ema_above': {
      const e9 = ind.EMA(closes, cond.fast || 9);
      const e21 = ind.EMA(closes, cond.slow || 21);
      return e9 > e21;
    }
    case 'macd_histogram_above': {
      const m = ind.MACD(closes, cond.fast || 12, cond.slow || 26, cond.signal || 9);
      return m.histogram > (cond.value ?? 0);
    }
    case 'keltner_break': {
      const kc = ind.KeltnerChannel(candles, cond.period || 20, cond.mult || 2);
      if (cond.direction === 'above') return currentPrice > kc.upper;
      return currentPrice < kc.lower;
    }
    case 'donchian_break': {
      const dc = ind.DonchianChannel(candles, cond.period || 20);
      if (cond.direction === 'above') return currentPrice >= dc.upper;
      return currentPrice <= dc.lower;
    }
    default:
      return false;
  }
}

module.exports = {
  evaluateBar,
  evalCondition
};
