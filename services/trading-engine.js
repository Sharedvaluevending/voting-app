// services/trading-engine.js
// ====================================================
// TRADING ENGINE - Signal Generation with TP/SL/Entry
// Analyzes price data and generates actionable trade signals
// with entry points, take profits, stop losses, and reasoning.
// ====================================================

/**
 * Generate a full trade analysis for a coin.
 *
 * @param {Object} coinData - Current price data from crypto-api
 * @param {Object} history - Price history { prices: [{timestamp, price}], volumes: [...] }
 * @returns {Object} Complete trade signal with entry/TP/SL
 */
function analyzeCoin(coinData, history) {
  const prices = (history.prices || []).map(p => p.price);
  const volumes = (history.volumes || []).map(v => v.volume);

  if (prices.length < 10) {
    return buildSignal(coinData, 'HOLD', 0, 50, ['Insufficient price data for analysis'], {}, prices);
  }

  const currentPrice = coinData.price;
  const indicators = calculateIndicators(prices, volumes, currentPrice);
  const { signal, strength, reasons } = evaluateSignal(indicators, coinData);
  const levels = calculateLevels(currentPrice, indicators, signal);
  const confidence = calculateConfidence(indicators, prices.length);

  return {
    coin: {
      id: coinData.id,
      symbol: coinData.symbol,
      name: coinData.name,
      price: currentPrice,
      change24h: coinData.change24h,
      volume24h: coinData.volume24h,
      marketCap: coinData.marketCap
    },
    signal: signal,
    strength: Math.round(strength),
    confidence: Math.round(confidence),
    entry: levels.entry,
    takeProfit1: levels.tp1,
    takeProfit2: levels.tp2,
    takeProfit3: levels.tp3,
    stopLoss: levels.stopLoss,
    riskReward: levels.riskReward,
    reasoning: reasons,
    indicators: {
      rsi: Math.round(indicators.rsi * 100) / 100,
      sma20: round2(indicators.sma20),
      sma50: round2(indicators.sma50),
      ema12: round2(indicators.ema12),
      ema26: round2(indicators.ema26),
      macdLine: round2(indicators.macdLine),
      macdSignal: round2(indicators.macdSignal),
      macdHistogram: round2(indicators.macdHistogram),
      atr: round2(indicators.atr),
      trend: indicators.trend,
      support: round2(indicators.support),
      resistance: round2(indicators.resistance),
      volumeTrend: indicators.volumeTrend,
      priceVsSma20: round2(indicators.priceVsSma20),
      priceVsSma50: round2(indicators.priceVsSma50)
    },
    timestamp: new Date().toISOString()
  };
}

// ====================================================
// TECHNICAL INDICATORS
// ====================================================

function calculateIndicators(prices, volumes, currentPrice) {
  const sma20 = SMA(prices, 20);
  const sma50 = SMA(prices, 50);
  const ema12 = EMA(prices, 12);
  const ema26 = EMA(prices, 26);
  const rsi = RSI(prices, 14);
  const atr = ATR(prices, 14);

  // MACD
  const macdLine = ema12 - ema26;
  const macdPrices = prices.slice(-26).map((_, i, arr) => {
    const slice12 = prices.slice(0, prices.length - 26 + i + 1);
    const slice26 = prices.slice(0, prices.length - 26 + i + 1);
    return EMA(slice12, 12) - EMA(slice26, 26);
  });
  const macdSignal = EMA(macdPrices, 9);
  const macdHistogram = macdLine - macdSignal;

  // Support & Resistance (local min/max from recent data)
  const recentPrices = prices.slice(-48); // ~2 days of hourly data
  const support = Math.min(...recentPrices);
  const resistance = Math.max(...recentPrices);

  // Trend detection
  const trend = determineTrend(prices, sma20, sma50);

  // Volume trend
  const volumeTrend = analyzeVolumeTrend(volumes);

  // Price relative to moving averages
  const priceVsSma20 = sma20 > 0 ? ((currentPrice - sma20) / sma20) * 100 : 0;
  const priceVsSma50 = sma50 > 0 ? ((currentPrice - sma50) / sma50) * 100 : 0;

  return {
    sma20, sma50, ema12, ema26, rsi, atr,
    macdLine, macdSignal, macdHistogram,
    support, resistance, trend, volumeTrend,
    priceVsSma20, priceVsSma50, currentPrice
  };
}

function SMA(data, period) {
  if (data.length < period) return data.length > 0 ? data.reduce((s, v) => s + v, 0) / data.length : 0;
  const slice = data.slice(-period);
  return slice.reduce((sum, val) => sum + val, 0) / period;
}

function EMA(data, period) {
  if (data.length === 0) return 0;
  if (data.length < period) return SMA(data, data.length);

  const multiplier = 2 / (period + 1);
  let ema = SMA(data.slice(0, period), period);

  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }
  return ema;
}

function RSI(prices, period) {
  if (prices.length < period + 1) return 50;

  let gains = 0, losses = 0;
  const startIdx = prices.length - period - 1;

  for (let i = startIdx + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function ATR(prices, period) {
  if (prices.length < 2) return 0;

  const trueRanges = [];
  for (let i = 1; i < prices.length; i++) {
    // Simplified ATR using close prices (no high/low available)
    trueRanges.push(Math.abs(prices[i] - prices[i - 1]));
  }

  if (trueRanges.length < period) {
    return trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length;
  }

  return trueRanges.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function determineTrend(prices, sma20, sma50) {
  if (prices.length < 20) return 'SIDEWAYS';

  const currentPrice = prices[prices.length - 1];
  const aboveSma20 = currentPrice > sma20;
  const aboveSma50 = currentPrice > sma50;
  const sma20AboveSma50 = sma20 > sma50;

  if (aboveSma20 && aboveSma50 && sma20AboveSma50) return 'STRONG_UP';
  if (aboveSma20 && sma20AboveSma50) return 'UP';
  if (!aboveSma20 && !aboveSma50 && !sma20AboveSma50) return 'STRONG_DOWN';
  if (!aboveSma20 && !sma20AboveSma50) return 'DOWN';
  return 'SIDEWAYS';
}

function analyzeVolumeTrend(volumes) {
  if (volumes.length < 10) return 'NORMAL';

  const recent = volumes.slice(-5);
  const older = volumes.slice(-10, -5);

  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const olderAvg = older.reduce((s, v) => s + v, 0) / older.length;

  if (olderAvg === 0) return 'NORMAL';
  const change = ((recentAvg - olderAvg) / olderAvg) * 100;

  if (change > 50) return 'SURGING';
  if (change > 20) return 'INCREASING';
  if (change < -30) return 'DECLINING';
  return 'NORMAL';
}

// ====================================================
// SIGNAL EVALUATION
// ====================================================

function evaluateSignal(ind, coinData) {
  let score = 0;
  const reasons = [];

  // RSI Analysis (weight: 25)
  if (ind.rsi < 30) {
    score += 25;
    reasons.push(`RSI at ${ind.rsi.toFixed(1)} - Oversold territory, potential bounce incoming`);
  } else if (ind.rsi < 40) {
    score += 12;
    reasons.push(`RSI at ${ind.rsi.toFixed(1)} - Approaching oversold, watch for reversal`);
  } else if (ind.rsi > 70) {
    score -= 25;
    reasons.push(`RSI at ${ind.rsi.toFixed(1)} - Overbought, consider taking profits`);
  } else if (ind.rsi > 60) {
    score -= 10;
    reasons.push(`RSI at ${ind.rsi.toFixed(1)} - Approaching overbought zone`);
  } else {
    reasons.push(`RSI at ${ind.rsi.toFixed(1)} - Neutral zone`);
  }

  // MACD Analysis (weight: 20)
  if (ind.macdHistogram > 0 && ind.macdLine > ind.macdSignal) {
    score += 20;
    reasons.push('MACD bullish crossover - Momentum shifting upward');
  } else if (ind.macdHistogram < 0 && ind.macdLine < ind.macdSignal) {
    score -= 20;
    reasons.push('MACD bearish crossover - Momentum shifting downward');
  } else if (ind.macdHistogram > 0) {
    score += 8;
    reasons.push('MACD histogram positive but weakening');
  } else {
    score -= 8;
    reasons.push('MACD histogram negative but may be bottoming');
  }

  // Trend Analysis (weight: 25)
  switch (ind.trend) {
    case 'STRONG_UP':
      score += 25;
      reasons.push('Strong uptrend - Price above both SMA20 and SMA50, golden cross');
      break;
    case 'UP':
      score += 15;
      reasons.push('Uptrend - Price above SMA20, bullish structure');
      break;
    case 'STRONG_DOWN':
      score -= 25;
      reasons.push('Strong downtrend - Price below both moving averages, death cross');
      break;
    case 'DOWN':
      score -= 15;
      reasons.push('Downtrend - Price below SMA20, bearish structure');
      break;
    default:
      reasons.push('Sideways/consolidation - No clear directional bias');
  }

  // Volume Analysis (weight: 15)
  if (ind.volumeTrend === 'SURGING') {
    score += (score > 0 ? 15 : -15); // Volume confirms direction
    reasons.push('Volume surging - Strong conviction behind the move');
  } else if (ind.volumeTrend === 'INCREASING') {
    score += (score > 0 ? 8 : -8);
    reasons.push('Volume increasing - Building momentum');
  } else if (ind.volumeTrend === 'DECLINING') {
    score += (score > 0 ? -5 : 5); // Declining volume weakens the trend
    reasons.push('Volume declining - Current move may be losing steam');
  }

  // Support/Resistance proximity (weight: 15)
  const range = ind.resistance - ind.support;
  if (range > 0) {
    const posInRange = (ind.currentPrice - ind.support) / range;
    if (posInRange < 0.2) {
      score += 15;
      reasons.push(`Near support at $${round2(ind.support)} - Potential bounce zone`);
    } else if (posInRange > 0.8) {
      score -= 10;
      reasons.push(`Near resistance at $${round2(ind.resistance)} - May face selling pressure`);
    }
  }

  // 24h change context
  if (coinData.change24h < -8) {
    score += 5; // Contrarian: big drops can mean bounce
    reasons.push(`Down ${coinData.change24h.toFixed(1)}% in 24h - Potential oversold bounce if support holds`);
  } else if (coinData.change24h > 8) {
    score -= 5;
    reasons.push(`Up ${coinData.change24h.toFixed(1)}% in 24h - Extended move, watch for pullback`);
  }

  // Classify signal
  let signal, strength;
  if (score >= 45) { signal = 'STRONG_BUY'; strength = Math.min(95, score); }
  else if (score >= 20) { signal = 'BUY'; strength = score; }
  else if (score >= -20) { signal = 'HOLD'; strength = Math.abs(score); }
  else if (score >= -45) { signal = 'SELL'; strength = Math.abs(score); }
  else { signal = 'STRONG_SELL'; strength = Math.min(95, Math.abs(score)); }

  return { signal, strength, reasons };
}

// ====================================================
// ENTRY, TAKE PROFIT & STOP LOSS LEVELS
// ====================================================

function calculateLevels(currentPrice, indicators, signal) {
  const atr = indicators.atr;
  const support = indicators.support;
  const resistance = indicators.resistance;

  let entry, tp1, tp2, tp3, stopLoss;

  if (signal === 'STRONG_BUY' || signal === 'BUY') {
    // Long trade setup
    // Entry: slightly below current price (wait for small dip) or at current
    entry = round2(currentPrice * 0.998);

    // Stop loss: below recent support or 1.5x ATR below entry
    const atrStop = entry - (atr * 1.5);
    const supportStop = support * 0.995;
    stopLoss = round2(Math.max(atrStop, supportStop));

    // Ensure stop loss is actually below entry
    if (stopLoss >= entry) {
      stopLoss = round2(entry - (atr * 2));
    }

    const risk = entry - stopLoss;

    // Take profits at 1.5x, 2.5x, 4x risk
    tp1 = round2(entry + (risk * 1.5));
    tp2 = round2(entry + (risk * 2.5));
    tp3 = round2(entry + (risk * 4));

    // If TP1 would be above resistance and that seems reasonable, cap it
    if (resistance > currentPrice && tp1 > resistance) {
      tp1 = round2(resistance * 0.998);
      tp2 = round2(resistance * 1.02);
      tp3 = round2(resistance * 1.05);
    }
  } else if (signal === 'STRONG_SELL' || signal === 'SELL') {
    // Short trade setup
    entry = round2(currentPrice * 1.002);

    // Stop loss above resistance or 1.5x ATR above entry
    const atrStop = entry + (atr * 1.5);
    const resistanceStop = resistance * 1.005;
    stopLoss = round2(Math.min(atrStop, resistanceStop));

    if (stopLoss <= entry) {
      stopLoss = round2(entry + (atr * 2));
    }

    const risk = stopLoss - entry;

    // Take profits below entry
    tp1 = round2(entry - (risk * 1.5));
    tp2 = round2(entry - (risk * 2.5));
    tp3 = round2(entry - (risk * 4));

    if (support < currentPrice && tp1 < support) {
      tp1 = round2(support * 1.002);
      tp2 = round2(support * 0.98);
      tp3 = round2(support * 0.95);
    }
  } else {
    // HOLD - show reference levels but no active trade
    entry = round2(currentPrice);
    stopLoss = round2(support * 0.995);
    tp1 = round2(resistance * 0.998);
    tp2 = round2(resistance * 1.03);
    tp3 = round2(resistance * 1.06);
  }

  // Calculate risk/reward ratio
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(tp2 - entry);
  const riskReward = risk > 0 ? round2(reward / risk) : 0;

  return { entry, tp1, tp2, tp3, stopLoss, riskReward };
}

// ====================================================
// CONFIDENCE CALCULATION
// ====================================================

function calculateConfidence(indicators, dataPoints) {
  let conf = 50; // Base confidence

  // More data = more confidence (up to +20)
  conf += Math.min(20, dataPoints / 10);

  // Strong trend = more confidence (+15)
  if (indicators.trend === 'STRONG_UP' || indicators.trend === 'STRONG_DOWN') conf += 15;
  else if (indicators.trend === 'UP' || indicators.trend === 'DOWN') conf += 8;

  // Volume confirming = more confidence (+10)
  if (indicators.volumeTrend === 'SURGING' || indicators.volumeTrend === 'INCREASING') conf += 10;

  // Clear RSI signal = more confidence (+5)
  if (indicators.rsi < 25 || indicators.rsi > 75) conf += 5;

  return Math.min(92, Math.max(20, conf));
}

// ====================================================
// BATCH ANALYSIS
// ====================================================

/**
 * Analyze all coins and return sorted trade signals.
 * @param {Array} allPrices - Current prices from crypto-api
 * @param {Object} allHistory - History keyed by coinId from crypto-api
 * @returns {Array} Sorted trade signals (strongest first)
 */
function analyzeAllCoins(allPrices, allHistory) {
  const signals = allPrices.map(coinData => {
    const history = allHistory[coinData.id] || { prices: [], volumes: [] };
    return analyzeCoin(coinData, history);
  });

  // Sort: STRONG_BUY first, then BUY, etc. Within same signal, by confidence
  const signalOrder = { STRONG_BUY: 0, BUY: 1, HOLD: 2, SELL: 3, STRONG_SELL: 4 };
  signals.sort((a, b) => {
    const orderDiff = signalOrder[a.signal] - signalOrder[b.signal];
    if (orderDiff !== 0) return orderDiff;
    return b.confidence - a.confidence;
  });

  return signals;
}

function round2(num) {
  if (num >= 1) return Math.round(num * 100) / 100;
  if (num >= 0.01) return Math.round(num * 10000) / 10000;
  return Math.round(num * 100000000) / 100000000; // For small crypto prices
}

function buildSignal(coinData, signal, strength, confidence, reasons, indicators, prices) {
  return {
    coin: {
      id: coinData.id,
      symbol: coinData.symbol,
      name: coinData.name,
      price: coinData.price,
      change24h: coinData.change24h,
      volume24h: coinData.volume24h,
      marketCap: coinData.marketCap
    },
    signal,
    strength,
    confidence,
    entry: coinData.price,
    takeProfit1: null,
    takeProfit2: null,
    takeProfit3: null,
    stopLoss: null,
    riskReward: 0,
    reasoning: reasons,
    indicators: indicators,
    timestamp: new Date().toISOString()
  };
}

module.exports = { analyzeCoin, analyzeAllCoins };
