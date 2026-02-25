// services/strategy-builder/presets.js
// ====================================================
// 25 INDICATOR-BASED STRATEGY PRESETS
// ====================================================

const PRESETS = [
  {
    id: 'ema_crossover',
    name: 'EMA Crossover',
    tier: 1,
    entry: { type: 'ema_crossover', fast: 9, slow: 21, direction: 'above' },
    exit: { type: 'ema_crossover', fast: 9, slow: 21, direction: 'below' },
    indicators: ['EMA']
  },
  {
    id: 'rsi_mean_revert',
    name: 'RSI Mean Reversion',
    tier: 1,
    entry: { type: 'rsi_range', period: 14, max: 30 },
    exit: { type: 'rsi_range', period: 14, min: 70 },
    indicators: ['RSI']
  },
  {
    id: 'macd_crossover',
    name: 'MACD Crossover',
    tier: 1,
    entry: { type: 'macd_crossover', fast: 12, slow: 26, signal: 9, direction: 'above' },
    exit: { type: 'macd_crossover', fast: 12, slow: 26, signal: 9, direction: 'below' },
    indicators: ['MACD']
  },
  {
    id: 'stochastic_bounce',
    name: 'Stochastic Bounce',
    tier: 1,
    entry: { type: 'stoch_crossover', period: 14, inOversold: true, direction: 'above' },
    exit: { type: 'stoch_crossover', period: 14, inOverbought: true, direction: 'below' },
    indicators: ['Stochastic']
  },
  {
    id: 'bollinger_bounce',
    name: 'Bollinger Bounce',
    tier: 1,
    entry: { type: 'bb_touch', period: 20, stdDev: 2, band: 'lower' },
    exit: { type: 'rsi_range', period: 14, min: 70 },
    indicators: ['Bollinger', 'RSI']
  },
  {
    id: 'vwap_reversion',
    name: 'VWAP Reversion',
    tier: 1,
    entry: { type: 'price_below', indicator: 'vwap', pct: 2 },
    exit: { type: 'price_at_or_above', indicator: 'vwap' },
    indicators: ['VWAP']
  },
  {
    id: 'ema_rsi_pullback',
    name: 'EMA + RSI Pullback',
    tier: 2,
    entry: { type: 'and', conditions: [
      { type: 'price_above', indicator: 'ema', period: 21 },
      { type: 'price_near', indicator: 'ema', period: 9, pct: 0.5 },
      { type: 'rsi_range', period: 14, min: 40, max: 60 }
    ]},
    exit: { type: 'or', conditions: [
      { type: 'rsi_range', period: 14, min: 70 },
      { type: 'price_below', indicator: 'ema', period: 21 }
    ]},
    indicators: ['EMA', 'RSI']
  },
  {
    id: 'macd_trend',
    name: 'MACD + Trend',
    tier: 2,
    entry: { type: 'and', conditions: [
      { type: 'macd_crossover', fast: 12, slow: 26, signal: 9, direction: 'above' },
      { type: 'price_above', indicator: 'ema', period: 21 }
    ]},
    exit: { type: 'macd_crossover', fast: 12, slow: 26, signal: 9, direction: 'below' },
    indicators: ['MACD', 'EMA']
  },
  {
    id: 'bollinger_squeeze',
    name: 'Bollinger Squeeze',
    tier: 2,
    entry: { type: 'bb_squeeze_break', period: 20, stdDev: 2, direction: 'above' },
    exit: { type: 'bb_touch', period: 20, stdDev: 2, band: 'mid' },
    indicators: ['Bollinger']
  },
  {
    id: 'triple_confluence',
    name: 'Triple Confluence',
    tier: 3,
    entry: { type: 'and', conditions: [
      { type: 'price_above', indicator: 'ema', period: 9 },
      { type: 'ema_above', fast: 9, slow: 21 },
      { type: 'rsi_range', period: 14, min: 40, max: 60 },
      { type: 'macd_histogram_above', fast: 12, slow: 26, signal: 9, value: 0 }
    ]},
    exit: { type: 'or', conditions: [
      { type: 'macd_crossover', fast: 12, slow: 26, signal: 9, direction: 'below' },
      { type: 'rsi_range', period: 14, min: 70 }
    ]},
    indicators: ['EMA', 'RSI', 'MACD']
  },
  {
    id: 'keltner_breakout',
    name: 'Keltner Breakout',
    tier: 3,
    entry: { type: 'keltner_break', period: 20, mult: 2, direction: 'above' },
    exit: { type: 'price_below', indicator: 'keltner_mid', period: 20 },
    indicators: ['Keltner']
  },
  {
    id: 'donchian_breakout',
    name: 'Donchian Breakout',
    tier: 3,
    entry: { type: 'donchian_break', period: 20, direction: 'above' },
    exit: { type: 'donchian_break', period: 20, direction: 'below' },
    indicators: ['Donchian']
  }
];

function getPreset(id) {
  return PRESETS.find(p => p.id === id) || null;
}

function getAllPresets() {
  return PRESETS;
}

module.exports = {
  PRESETS,
  getPreset,
  getAllPresets
};
