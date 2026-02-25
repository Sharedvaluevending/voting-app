// services/strategy-builder/indicator-catalog.js
// ====================================================
// Full catalog of 25+ indicators with configurable params
// Used by Strategy Builder UI for picker + settings
// ====================================================

// ruleType = condition type for rule-engine; paramKeys = which params go into the rule
const INDICATOR_CATALOG = [
  { id: 'ema_crossover', name: 'EMA Crossover', group: 'Trend', ruleType: 'ema_crossover', params: [
    { key: 'fast', label: 'Fast period', type: 'number', default: 9, min: 2, max: 50 },
    { key: 'slow', label: 'Slow period', type: 'number', default: 21, min: 5, max: 100 },
    { key: 'direction', label: 'Direction', type: 'select', options: [
      { value: 'above', label: 'Fast crosses above slow (bullish)' },
      { value: 'below', label: 'Fast crosses below slow (bearish)' }
    ]}
  ]},
  { id: 'ema_above', name: 'EMA Above (trend)', group: 'Trend', ruleType: 'ema_above', params: [
    { key: 'fast', label: 'Fast period', type: 'number', default: 9, min: 2, max: 50 },
    { key: 'slow', label: 'Slow period', type: 'number', default: 21, min: 5, max: 100 }
  ]},
  { id: 'price_above_ema', name: 'Price above EMA', group: 'Trend', ruleType: 'price_above', params: [
    { key: 'period', label: 'EMA period', type: 'number', default: 21, min: 5, max: 100 }
  ], extra: { indicator: 'ema' }},
  { id: 'price_below_ema', name: 'Price below EMA', group: 'Trend', ruleType: 'price_below', params: [
    { key: 'period', label: 'EMA period', type: 'number', default: 21, min: 5, max: 100 },
    { key: 'pct', label: 'Below by %', type: 'number', default: 2, min: 0, max: 20 }
  ], extra: { indicator: 'ema' }},
  { id: 'price_near_ema', name: 'Price near EMA', group: 'Trend', ruleType: 'price_near', params: [
    { key: 'period', label: 'EMA period', type: 'number', default: 9, min: 5, max: 50 },
    { key: 'pct', label: 'Within %', type: 'number', default: 0.5, min: 0.1, max: 5 }
  ], extra: { indicator: 'ema' }},

  { id: 'rsi_range', name: 'RSI in range', group: 'Momentum', ruleType: 'rsi_range', params: [
    { key: 'period', label: 'Period', type: 'number', default: 14, min: 5, max: 50 },
    { key: 'min', label: 'Min (oversold)', type: 'number', default: 30, min: 0, max: 100 },
    { key: 'max', label: 'Max (overbought)', type: 'number', default: 70, min: 0, max: 100 }
  ]},
  { id: 'rsi_oversold', name: 'RSI Oversold (<)', group: 'Momentum', ruleType: 'rsi_range', params: [
    { key: 'period', label: 'Period', type: 'number', default: 14, min: 5, max: 50 },
    { key: 'max', label: 'Below level', type: 'number', default: 30, min: 10, max: 50 }
  ]},
  { id: 'rsi_overbought', name: 'RSI Overbought (>)', group: 'Momentum', ruleType: 'rsi_range', params: [
    { key: 'period', label: 'Period', type: 'number', default: 14, min: 5, max: 50 },
    { key: 'min', label: 'Above level', type: 'number', default: 70, min: 50, max: 90 }
  ]},
  { id: 'macd_crossover', name: 'MACD Crossover', group: 'Momentum', ruleType: 'macd_crossover', params: [
    { key: 'fast', label: 'Fast', type: 'number', default: 12, min: 5, max: 30 },
    { key: 'slow', label: 'Slow', type: 'number', default: 26, min: 15, max: 50 },
    { key: 'signal', label: 'Signal', type: 'number', default: 9, min: 5, max: 20 },
    { key: 'direction', label: 'Direction', type: 'select', options: [
      { value: 'above', label: 'MACD crosses above signal' },
      { value: 'below', label: 'MACD crosses below signal' }
    ]}
  ]},
  { id: 'macd_histogram_above', name: 'MACD Histogram > 0', group: 'Momentum', ruleType: 'macd_histogram_above', params: [
    { key: 'fast', label: 'Fast', type: 'number', default: 12, min: 5, max: 30 },
    { key: 'slow', label: 'Slow', type: 'number', default: 26, min: 15, max: 50 },
    { key: 'signal', label: 'Signal', type: 'number', default: 9, min: 5, max: 20 },
    { key: 'value', label: 'Min value', type: 'number', default: 0, min: -10, max: 10 }
  ]},
  { id: 'stoch_crossover', name: 'Stochastic Crossover', group: 'Momentum', ruleType: 'stoch_crossover', params: [
    { key: 'period', label: 'Period', type: 'number', default: 14, min: 5, max: 30 },
    { key: 'inOversold', label: 'In oversold zone', type: 'checkbox', default: false },
    { key: 'inOverbought', label: 'In overbought zone', type: 'checkbox', default: false },
    { key: 'direction', label: 'Direction', type: 'select', options: [
      { value: 'above', label: 'K crosses above D' },
      { value: 'below', label: 'K crosses below D' }
    ]}
  ]},

  { id: 'bb_touch', name: 'Bollinger Band touch', group: 'Volatility', ruleType: 'bb_touch', params: [
    { key: 'period', label: 'Period', type: 'number', default: 20, min: 10, max: 50 },
    { key: 'stdDev', label: 'Std dev', type: 'number', default: 2, min: 1, max: 3 },
    { key: 'band', label: 'Band', type: 'select', options: [
      { value: 'lower', label: 'Lower band' },
      { value: 'upper', label: 'Upper band' },
      { value: 'mid', label: 'Middle band' }
    ]}
  ]},
  { id: 'bb_squeeze_break', name: 'Bollinger Squeeze break', group: 'Volatility', ruleType: 'bb_squeeze_break', params: [
    { key: 'period', label: 'Period', type: 'number', default: 20, min: 10, max: 50 },
    { key: 'stdDev', label: 'Std dev', type: 'number', default: 2, min: 1, max: 3 },
    { key: 'direction', label: 'Break', type: 'select', options: [
      { value: 'above', label: 'Break above upper' },
      { value: 'below', label: 'Break below lower' }
    ]}
  ]},
  { id: 'keltner_break', name: 'Keltner Channel break', group: 'Volatility', ruleType: 'keltner_break', params: [
    { key: 'period', label: 'Period', type: 'number', default: 20, min: 10, max: 50 },
    { key: 'mult', label: 'ATR multiplier', type: 'number', default: 2, min: 1, max: 4 },
    { key: 'direction', label: 'Break', type: 'select', options: [
      { value: 'above', label: 'Break above upper' },
      { value: 'below', label: 'Break below lower' }
    ]}
  ]},
  { id: 'donchian_break', name: 'Donchian Channel break', group: 'Volatility', ruleType: 'donchian_break', params: [
    { key: 'period', label: 'Period', type: 'number', default: 20, min: 10, max: 50 },
    { key: 'direction', label: 'Break', type: 'select', options: [
      { value: 'above', label: 'Break above high' },
      { value: 'below', label: 'Break below low' }
    ]}
  ]},

  { id: 'vwap_below', name: 'Price below VWAP', group: 'Price', ruleType: 'price_below', params: [
    { key: 'pct', label: 'Below by %', type: 'number', default: 2, min: 0, max: 20 }
  ], extra: { indicator: 'vwap' }},
  { id: 'vwap_above', name: 'Price at or above VWAP', group: 'Price', ruleType: 'price_at_or_above', params: [],
    extra: { indicator: 'vwap' }},
  { id: 'price_near_keltner', name: 'Price near Keltner mid', group: 'Price', ruleType: 'price_near', params: [
    { key: 'period', label: 'Period', type: 'number', default: 20, min: 10, max: 50 },
    { key: 'pct', label: 'Within %', type: 'number', default: 0.5, min: 0.1, max: 5 }
  ], extra: { indicator: 'keltner_mid' }}
];

function getCatalog() {
  return INDICATOR_CATALOG;
}

function getIndicatorById(id) {
  return INDICATOR_CATALOG.find(i => i.id === id);
}

function buildConditionFromForm(id, formValues) {
  const ind = getIndicatorById(id);
  if (!ind) return null;
  const rule = { type: ind.ruleType, ...(ind.extra || {}) };
  for (const p of ind.params || []) {
    const val = formValues[p.key];
    if (val === undefined) rule[p.key] = p.default;
    else if (p.type === 'number') rule[p.key] = parseFloat(val) || p.default;
    else if (p.type === 'checkbox') rule[p.key] = !!val;
    else rule[p.key] = val;
  }
  return rule;
}

module.exports = {
  getCatalog,
  getIndicatorById,
  buildConditionFromForm,
  INDICATOR_CATALOG
};
