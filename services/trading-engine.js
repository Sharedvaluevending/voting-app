// services/trading-engine.js
// ====================================================
// ADVANCED MULTI-STRATEGY TRADING ENGINE v3.0
//
// Uses Binance OHLCV candles across 1H, 4H, 1D timeframes.
// Scores signals 0-100 using 6 categories:
//   Trend(0-20) + Momentum(0-20) + Volume(0-20) +
//   Structure(0-20) + Volatility(0-10) + Risk(0-10)
//
// Multiple strategy types compete:
//   - Trend Following
//   - Breakout
//   - Mean Reversion
//   - Momentum
//
// Features: ADX, VWAP, market structure (HH/HL/LH/LL),
//   Bollinger squeeze, volume climax, regime detection,
//   suggested leverage, and full reasoning transparency.
// ====================================================

// ====================================================
// MAIN ANALYSIS ENTRY POINT
// ====================================================
function analyzeCoin(coinData, candles, history) {
  const currentPrice = coinData.price;

  // Try Binance candles first, fall back to CoinGecko history
  if (candles && candles['1h'] && candles['1h'].length >= 20) {
    return analyzeWithCandles(coinData, candles);
  }

  // Fallback to CoinGecko close-price history
  if (history && history.prices && history.prices.length >= 10) {
    return analyzeWithHistory(coinData, history);
  }

  // Basic signal from 24h change only
  return generateBasicSignal(coinData);
}

function analyzeAllCoins(allPrices, allCandles, allHistory) {
  const signals = allPrices.map(coinData => {
    const candles = allCandles[coinData.id] || null;
    const history = allHistory[coinData.id] || { prices: [], volumes: [] };
    return analyzeCoin(coinData, candles, history);
  });

  const signalOrder = { STRONG_BUY: 0, BUY: 1, STRONG_SELL: 2, SELL: 3, HOLD: 4 };
  signals.sort((a, b) => {
    const orderDiff = (signalOrder[a.signal] || 4) - (signalOrder[b.signal] || 4);
    if (orderDiff !== 0) return orderDiff;
    return b.score - a.score;
  });

  return signals;
}

// ====================================================
// ANALYSIS WITH BINANCE OHLCV CANDLES (best path)
// ====================================================
function analyzeWithCandles(coinData, candles) {
  const currentPrice = coinData.price;

  // Analyze each real timeframe
  const tf1h = analyzeOHLCV(candles['1h'], currentPrice);
  const tf4h = analyzeOHLCV(candles['4h'], currentPrice);
  const tf1d = analyzeOHLCV(candles['1d'], currentPrice);

  // Score each timeframe across 6 dimensions (0-100 total)
  const scores1h = scoreCandles(tf1h, currentPrice, '1h');
  const scores4h = scoreCandles(tf4h, currentPrice, '4h');
  const scores1d = scoreCandles(tf1d, currentPrice, '1d');

  // Weighted confluence: 1D=40%, 4H=35%, 1H=25%
  const finalScore = Math.round(
    scores1d.total * 0.40 + scores4h.total * 0.35 + scores1h.total * 0.25
  );

  // Direction confluence
  const directions = [scores1h.direction, scores4h.direction, scores1d.direction];
  const bullCount = directions.filter(d => d === 'BULL').length;
  const bearCount = directions.filter(d => d === 'BEAR').length;
  const confluenceLevel = Math.max(bullCount, bearCount);
  const dominantDir = bullCount >= bearCount ? 'BULL' : 'BEAR';

  // Determine signal from score
  const { signal, strength } = scoreToSignal(finalScore, confluenceLevel, dominantDir);

  // Detect market regime
  const regime = detectRegime(tf1d, tf4h);

  // Best strategy for this market
  const bestStrategy = pickStrategy(scores1h, scores4h, scores1d, regime);

  // Calculate trade levels
  const levels = calculateTradeLevels(currentPrice, tf1h, tf4h, signal, dominantDir);

  // Suggest leverage
  const suggestedLev = suggestLeverage(finalScore, regime, tf1h.volatilityState);

  // Build reasoning
  const reasoning = buildReasoning(scores1h, scores4h, scores1d, confluenceLevel, regime, bestStrategy, signal);

  // Confidence
  const confidence = calculateConfidence(finalScore, confluenceLevel, regime, candles['1h'].length);

  return {
    coin: {
      id: coinData.id, symbol: coinData.symbol, name: coinData.name,
      price: currentPrice, change24h: coinData.change24h,
      volume24h: coinData.volume24h, marketCap: coinData.marketCap
    },
    signal,
    score: finalScore,
    strength: Math.round(strength),
    confidence: Math.round(confidence),
    confluenceLevel,
    bestTimeframe: determineBestTF(scores1h, scores4h, scores1d),
    strategyType: bestStrategy.id,
    strategyName: bestStrategy.name,
    regime,
    suggestedLeverage: suggestedLev,
    entry: levels.entry,
    takeProfit1: levels.tp1,
    takeProfit2: levels.tp2,
    takeProfit3: levels.tp3,
    stopLoss: levels.stopLoss,
    riskReward: levels.riskReward,
    reasoning,
    scoreBreakdown: {
      trend: Math.round(scores1d.trend * 0.4 + scores4h.trend * 0.35 + scores1h.trend * 0.25),
      momentum: Math.round(scores1d.momentum * 0.4 + scores4h.momentum * 0.35 + scores1h.momentum * 0.25),
      volume: Math.round(scores1d.volume * 0.4 + scores4h.volume * 0.35 + scores1h.volume * 0.25),
      structure: Math.round(scores1d.structure * 0.4 + scores4h.structure * 0.35 + scores1h.structure * 0.25),
      volatility: Math.round(scores1d.volatility * 0.4 + scores4h.volatility * 0.35 + scores1h.volatility * 0.25),
      riskQuality: Math.round(scores1d.riskQuality * 0.4 + scores4h.riskQuality * 0.35 + scores1h.riskQuality * 0.25)
    },
    timeframes: {
      '1H': { signal: scores1h.label, score: scores1h.total, direction: scores1h.direction, rsi: r2(tf1h.rsi), trend: tf1h.trend, adx: r2(tf1h.adx) },
      '4H': { signal: scores4h.label, score: scores4h.total, direction: scores4h.direction, rsi: r2(tf4h.rsi), trend: tf4h.trend, adx: r2(tf4h.adx) },
      '1D': { signal: scores1d.label, score: scores1d.total, direction: scores1d.direction, rsi: r2(tf1d.rsi), trend: tf1d.trend, adx: r2(tf1d.adx) }
    },
    indicators: {
      rsi: r2(tf1h.rsi),
      sma20: r2(tf1h.sma20),
      sma50: r2(tf1h.sma50),
      ema9: r2(tf1h.ema9),
      ema21: r2(tf1h.ema21),
      macdLine: r2(tf1h.macdLine),
      macdSignal: r2(tf1h.macdSignal),
      macdHistogram: r2(tf1h.macdHistogram),
      bollingerUpper: r2(tf1h.bbUpper),
      bollingerLower: r2(tf1h.bbLower),
      bollingerMid: r2(tf1h.bbMid),
      bbSqueeze: tf1h.bbSqueeze,
      stochK: r2(tf1h.stochK),
      stochD: r2(tf1h.stochD),
      atr: r2(tf1h.atr),
      adx: r2(tf1h.adx),
      vwap: r2(tf1h.vwap),
      trend: tf1h.trend,
      structure: tf1h.marketStructure,
      support: r2(tf1h.support),
      resistance: r2(tf1h.resistance),
      volumeTrend: tf1h.volumeTrend,
      relativeVolume: r2(tf1h.relativeVolume),
      regime
    },
    timestamp: new Date().toISOString()
  };
}

// ====================================================
// OHLCV ANALYSIS - the real deal with proper candles
// ====================================================
function analyzeOHLCV(candles, currentPrice) {
  if (!candles || candles.length < 5) {
    return defaultAnalysis(currentPrice);
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const opens = candles.map(c => c.open);

  // Moving averages
  const sma20 = SMA(closes, 20);
  const sma50 = SMA(closes, Math.min(50, closes.length));
  const ema9 = EMA(closes, 9);
  const ema21 = EMA(closes, 21);
  const ema12 = EMA(closes, 12);
  const ema26 = EMA(closes, Math.min(26, closes.length));

  // RSI
  const rsi = RSI(closes, 14);

  // MACD
  const macdLine = ema12 - ema26;
  const macdHist = buildMACDHistory(closes);
  const macdSignal = macdHist.length >= 9 ? EMA(macdHist, 9) : macdLine;
  const macdHistogram = macdLine - macdSignal;

  // ATR with proper high/low
  const atr = ATR_OHLC(highs, lows, closes, 14);

  // ADX - trend strength
  const adx = ADX(highs, lows, closes, 14);

  // Bollinger Bands
  const bb = bollingerBands(closes, 20, 2);
  const bbSqueeze = detectBBSqueeze(closes, highs, lows, 20);

  // Stochastic with proper high/low
  const stoch = stochasticOHLC(highs, lows, closes, 14);

  // VWAP (using volume-weighted average)
  const vwap = calculateVWAP(candles);

  // Support & Resistance from swing points
  const sr = findSR(highs, lows, closes);

  // Market Structure: HH/HL/LH/LL
  const marketStructure = detectMarketStructure(highs, lows);

  // Trend determination
  const trend = determineTrend(closes, sma20, sma50, ema9, ema21, adx);

  // Volume analysis
  const volumeAnalysis = analyzeVolume(volumes, closes, opens);

  // Volatility state
  const volatilityState = classifyVolatility(atr, closes);

  return {
    rsi, sma20, sma50, ema9, ema21,
    macdLine, macdSignal, macdHistogram,
    atr, adx,
    bbUpper: bb.upper, bbLower: bb.lower, bbMid: bb.mid, bbSqueeze,
    stochK: stoch.k, stochD: stoch.d,
    vwap,
    support: sr.support, resistance: sr.resistance,
    marketStructure,
    trend,
    volumeTrend: volumeAnalysis.trend,
    relativeVolume: volumeAnalysis.relativeVolume,
    volumeClimax: volumeAnalysis.climax,
    accDist: volumeAnalysis.accDist,
    volatilityState,
    currentPrice,
    closes, highs, lows, volumes
  };
}

// ====================================================
// SCORING (0-100 scale, 6 categories)
// ====================================================
function scoreCandles(analysis, currentPrice, timeframe) {
  let trend = 0;       // 0-20
  let momentum = 0;    // 0-20
  let volume = 0;      // 0-20
  let structure = 0;   // 0-20
  let volatility = 0;  // 0-10
  let riskQuality = 0; // 0-10
  let direction = 'NEUTRAL';
  let bullPoints = 0, bearPoints = 0;

  // === TREND (0-20) ===
  // Trend direction
  if (analysis.trend === 'STRONG_UP') { trend += 8; bullPoints += 3; }
  else if (analysis.trend === 'UP') { trend += 5; bullPoints += 2; }
  else if (analysis.trend === 'STRONG_DOWN') { trend += 8; bearPoints += 3; }
  else if (analysis.trend === 'DOWN') { trend += 5; bearPoints += 2; }
  else { trend += 2; }

  // ADX trend strength
  if (analysis.adx > 40) trend += 6;
  else if (analysis.adx > 25) trend += 4;
  else if (analysis.adx > 20) trend += 2;

  // Price vs EMAs
  if (currentPrice > analysis.ema9 && analysis.ema9 > analysis.ema21) {
    trend += 4; bullPoints += 1;
  } else if (currentPrice < analysis.ema9 && analysis.ema9 < analysis.ema21) {
    trend += 4; bearPoints += 1;
  } else { trend += 1; }

  // SMA alignment
  if (analysis.sma20 > analysis.sma50) { trend += 2; bullPoints += 1; }
  else if (analysis.sma20 < analysis.sma50) { trend += 2; bearPoints += 1; }

  trend = Math.min(20, trend);

  // === MOMENTUM (0-20) ===
  // RSI
  if (analysis.rsi < 25) { momentum += 6; bullPoints += 2; }
  else if (analysis.rsi < 35) { momentum += 4; bullPoints += 1; }
  else if (analysis.rsi > 75) { momentum += 6; bearPoints += 2; }
  else if (analysis.rsi > 65) { momentum += 4; bearPoints += 1; }
  else if (analysis.rsi > 45 && analysis.rsi < 55) { momentum += 1; }
  else { momentum += 2; }

  // MACD
  if (analysis.macdHistogram > 0 && analysis.macdLine > analysis.macdSignal) {
    momentum += 5; bullPoints += 1;
  } else if (analysis.macdHistogram < 0 && analysis.macdLine < analysis.macdSignal) {
    momentum += 5; bearPoints += 1;
  } else { momentum += 1; }

  // Stochastic
  if (analysis.stochK < 20) { momentum += 4; bullPoints += 1; }
  else if (analysis.stochK > 80) { momentum += 4; bearPoints += 1; }
  else { momentum += 1; }

  // Stochastic crossover
  if (analysis.stochK > analysis.stochD && analysis.stochK < 40) {
    momentum += 3; bullPoints += 1;
  } else if (analysis.stochK < analysis.stochD && analysis.stochK > 60) {
    momentum += 3; bearPoints += 1;
  }

  // MACD histogram direction
  if (analysis.macdHistogram > 0) { momentum += 2; bullPoints += 1; }
  else { momentum += 2; bearPoints += 1; }

  momentum = Math.min(20, momentum);

  // === VOLUME (0-20) ===
  // Relative volume
  if (analysis.relativeVolume > 2.0) { volume += 7; }
  else if (analysis.relativeVolume > 1.5) { volume += 5; }
  else if (analysis.relativeVolume > 1.0) { volume += 3; }
  else { volume += 1; }

  // Volume trend
  if (analysis.volumeTrend === 'SURGING') { volume += 5; }
  else if (analysis.volumeTrend === 'INCREASING') { volume += 3; }
  else if (analysis.volumeTrend === 'DECLINING') { volume += 1; }
  else { volume += 2; }

  // Volume climax
  if (analysis.volumeClimax) { volume += 4; }

  // VWAP position
  if (currentPrice > analysis.vwap) {
    volume += 4; bullPoints += 1;
  } else if (currentPrice < analysis.vwap) {
    volume += 4; bearPoints += 1;
  } else { volume += 2; }

  volume = Math.min(20, volume);

  // === STRUCTURE (0-20) ===
  const struct = analysis.marketStructure;
  if (struct === 'BULLISH') { structure += 10; bullPoints += 2; }
  else if (struct === 'BEARISH') { structure += 10; bearPoints += 2; }
  else if (struct === 'BREAK_UP') { structure += 8; bullPoints += 2; }
  else if (struct === 'BREAK_DOWN') { structure += 8; bearPoints += 2; }
  else { structure += 3; }

  // Distance from S/R
  const srRange = analysis.resistance - analysis.support;
  if (srRange > 0) {
    const posInRange = (currentPrice - analysis.support) / srRange;
    if (posInRange < 0.2) { structure += 5; bullPoints += 1; }
    else if (posInRange < 0.35) { structure += 3; bullPoints += 1; }
    else if (posInRange > 0.8) { structure += 5; bearPoints += 1; }
    else if (posInRange > 0.65) { structure += 3; bearPoints += 1; }
    else { structure += 2; }
  }

  // Bollinger band position
  const bbRange = analysis.bbUpper - analysis.bbLower;
  if (bbRange > 0) {
    const bbPos = (currentPrice - analysis.bbLower) / bbRange;
    if (bbPos < 0.15) { structure += 5; bullPoints += 1; }
    else if (bbPos > 0.85) { structure += 5; bearPoints += 1; }
    else { structure += 2; }
  }

  structure = Math.min(20, structure);

  // === VOLATILITY (0-10) ===
  if (analysis.bbSqueeze) { volatility += 5; }
  if (analysis.volatilityState === 'low') { volatility += 3; }
  else if (analysis.volatilityState === 'normal') { volatility += 2; }
  else if (analysis.volatilityState === 'high') { volatility += 3; }
  else { volatility += 1; }

  if (analysis.adx > 25 && analysis.volatilityState !== 'extreme') { volatility += 2; }

  volatility = Math.min(10, volatility);

  // === RISK QUALITY (0-10) ===
  if (analysis.support > 0 && analysis.resistance > analysis.support) {
    riskQuality += 3;
  }
  if (analysis.atr > 0) { riskQuality += 2; }
  if (analysis.adx > 20) { riskQuality += 2; }
  if (analysis.closes && analysis.closes.length >= 50) { riskQuality += 3; }
  else if (analysis.closes && analysis.closes.length >= 20) { riskQuality += 2; }
  else { riskQuality += 1; }

  riskQuality = Math.min(10, riskQuality);

  // TOTAL
  const total = trend + momentum + volume + structure + volatility + riskQuality;

  // Direction
  if (bullPoints > bearPoints + 2) direction = 'BULL';
  else if (bearPoints > bullPoints + 2) direction = 'BEAR';

  // Label
  let label;
  if (direction === 'BULL') {
    if (total >= 70) label = 'STRONG BUY';
    else if (total >= 50) label = 'BUY';
    else label = 'LEAN BULL';
  } else if (direction === 'BEAR') {
    if (total >= 70) label = 'STRONG SELL';
    else if (total >= 50) label = 'SELL';
    else label = 'LEAN BEAR';
  } else {
    label = 'NEUTRAL';
  }

  return { total, trend, momentum, volume, structure, volatility, riskQuality, direction, label };
}

// ====================================================
// SIGNAL DETERMINATION
// ====================================================
function scoreToSignal(score, confluenceLevel, dominantDir) {
  let signal, strength;

  // Boost score with confluence
  const confBonus = confluenceLevel === 3 ? 10 : confluenceLevel === 2 ? 5 : 0;
  const adjScore = score + confBonus;

  if (dominantDir === 'BULL') {
    if (adjScore >= 75) { signal = 'STRONG_BUY'; strength = Math.min(98, adjScore); }
    else if (adjScore >= 55) { signal = 'BUY'; strength = adjScore; }
    else if (adjScore >= 45) { signal = 'BUY'; strength = adjScore; }
    else { signal = 'HOLD'; strength = adjScore; }
  } else if (dominantDir === 'BEAR') {
    if (adjScore >= 75) { signal = 'STRONG_SELL'; strength = Math.min(98, adjScore); }
    else if (adjScore >= 55) { signal = 'SELL'; strength = adjScore; }
    else if (adjScore >= 45) { signal = 'SELL'; strength = adjScore; }
    else { signal = 'HOLD'; strength = adjScore; }
  } else {
    signal = 'HOLD';
    strength = adjScore;
  }

  return { signal, strength };
}

// ====================================================
// TECHNICAL INDICATORS
// ====================================================
function SMA(data, period) {
  if (!data.length) return 0;
  const p = Math.min(period, data.length);
  const slice = data.slice(-p);
  return slice.reduce((s, v) => s + v, 0) / p;
}

function EMA(data, period) {
  if (!data.length) return 0;
  if (data.length < period) return SMA(data, data.length);
  const k = 2 / (period + 1);
  let ema = SMA(data.slice(0, period), period);
  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * k + ema;
  }
  return ema;
}

function RSI(prices, period) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const start = prices.length - period - 1;
  for (let i = start + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function ATR_OHLC(highs, lows, closes, period) {
  if (highs.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const p = Math.min(period, trs.length);
  return trs.slice(-p).reduce((s, v) => s + v, 0) / p;
}

function ADX(highs, lows, closes, period) {
  if (highs.length < period + 1) return 0;
  const pDMs = [], nDMs = [], trs = [];

  for (let i = 1; i < highs.length; i++) {
    const pDM = highs[i] - highs[i - 1];
    const nDM = lows[i - 1] - lows[i];
    pDMs.push(pDM > nDM && pDM > 0 ? pDM : 0);
    nDMs.push(nDM > pDM && nDM > 0 ? nDM : 0);
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }

  const p = Math.min(period, trs.length);
  const smoothPDM = SMA(pDMs.slice(-p), p);
  const smoothNDM = SMA(nDMs.slice(-p), p);
  const smoothTR = SMA(trs.slice(-p), p);

  if (smoothTR === 0) return 0;
  const pDI = (smoothPDM / smoothTR) * 100;
  const nDI = (smoothNDM / smoothTR) * 100;
  const diSum = pDI + nDI;
  if (diSum === 0) return 0;
  const dx = (Math.abs(pDI - nDI) / diSum) * 100;
  return dx;
}

function bollingerBands(prices, period, stdDev) {
  const mid = SMA(prices, period);
  const slice = prices.slice(-Math.min(period, prices.length));
  const variance = slice.reduce((s, p) => s + Math.pow(p - mid, 2), 0) / slice.length;
  const sd = Math.sqrt(variance);
  return { upper: mid + sd * stdDev, lower: mid - sd * stdDev, mid };
}

function detectBBSqueeze(closes, highs, lows, period) {
  const bb = bollingerBands(closes, period, 2);
  const bbWidth = (bb.upper - bb.lower) / bb.mid;

  // Keltner channel
  const atr = ATR_OHLC(highs, lows, closes, period);
  const ema = EMA(closes, period);
  const kcUpper = ema + atr * 1.5;
  const kcLower = ema - atr * 1.5;

  // Squeeze = BB inside KC
  return bb.lower > kcLower && bb.upper < kcUpper;
}

function stochasticOHLC(highs, lows, closes, period) {
  const p = Math.min(period, highs.length);
  const recentH = highs.slice(-p);
  const recentL = lows.slice(-p);
  const high = Math.max(...recentH);
  const low = Math.min(...recentL);
  const current = closes[closes.length - 1];
  const k = high === low ? 50 : ((current - low) / (high - low)) * 100;

  // %D
  const kVals = [];
  for (let i = Math.max(0, closes.length - 3); i < closes.length; i++) {
    const idx = Math.max(0, i - p + 1);
    const h = Math.max(...highs.slice(idx, i + 1));
    const l = Math.min(...lows.slice(idx, i + 1));
    kVals.push(h === l ? 50 : ((closes[i] - l) / (h - l)) * 100);
  }
  const d = kVals.reduce((s, v) => s + v, 0) / kVals.length;
  return { k, d };
}

function calculateVWAP(candles) {
  if (!candles.length) return 0;
  // Use last 20 candles for VWAP
  const recent = candles.slice(-20);
  let cumTPV = 0, cumVol = 0;
  for (const c of recent) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : 0;
}

function buildMACDHistory(prices) {
  const len = Math.min(26, prices.length);
  const result = [];
  for (let i = len; i <= prices.length; i++) {
    const slice = prices.slice(0, i);
    const e12 = EMA(slice, 12);
    const e26 = EMA(slice, Math.min(26, slice.length));
    result.push(e12 - e26);
  }
  return result;
}

// ====================================================
// MARKET STRUCTURE - HH/HL/LH/LL detection
// ====================================================
function detectMarketStructure(highs, lows) {
  if (highs.length < 10) return 'UNKNOWN';

  const swingHighs = [];
  const swingLows = [];

  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
      swingHighs.push({ idx: i, val: highs[i] });
    }
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
      swingLows.push({ idx: i, val: lows[i] });
    }
  }

  if (swingHighs.length < 2 || swingLows.length < 2) return 'UNKNOWN';

  const lastH = swingHighs.slice(-2);
  const lastL = swingLows.slice(-2);

  const higherHighs = lastH[1].val > lastH[0].val;
  const higherLows = lastL[1].val > lastL[0].val;
  const lowerHighs = lastH[1].val < lastH[0].val;
  const lowerLows = lastL[1].val < lastL[0].val;

  if (higherHighs && higherLows) return 'BULLISH';
  if (lowerHighs && lowerLows) return 'BEARISH';
  if (higherHighs && lowerLows) return 'BREAK_UP';
  if (lowerHighs && higherLows) return 'BREAK_DOWN';
  return 'RANGING';
}

// ====================================================
// SUPPORT & RESISTANCE
// ====================================================
function findSR(highs, lows, closes) {
  const lookback = Math.min(48, highs.length);
  const recentH = highs.slice(-lookback);
  const recentL = lows.slice(-lookback);

  let support = Math.min(...recentL);
  let resistance = Math.max(...recentH);

  // Swing-based S/R
  const swingLows = [];
  const swingHighs = [];
  for (let i = 2; i < recentH.length - 2; i++) {
    if (recentL[i] < recentL[i-1] && recentL[i] < recentL[i+1]) swingLows.push(recentL[i]);
    if (recentH[i] > recentH[i-1] && recentH[i] > recentH[i+1]) swingHighs.push(recentH[i]);
  }

  if (swingLows.length > 0) support = swingLows[swingLows.length - 1];
  if (swingHighs.length > 0) resistance = swingHighs[swingHighs.length - 1];

  return { support, resistance };
}

// ====================================================
// TREND DETECTION
// ====================================================
function determineTrend(closes, sma20, sma50, ema9, ema21, adx) {
  if (closes.length < 10) return 'SIDEWAYS';
  const cp = closes[closes.length - 1];
  const above = [cp > ema9, cp > ema21, cp > sma20, cp > sma50, ema9 > ema21, sma20 > sma50];
  const bull = above.filter(Boolean).length;

  if (adx > 25) {
    if (bull >= 5) return 'STRONG_UP';
    if (bull >= 4) return 'UP';
    if (bull <= 1) return 'STRONG_DOWN';
    if (bull <= 2) return 'DOWN';
  }

  if (bull >= 4) return 'UP';
  if (bull <= 2) return 'DOWN';
  return 'SIDEWAYS';
}

// ====================================================
// VOLUME ANALYSIS
// ====================================================
function analyzeVolume(volumes, closes, opens) {
  if (volumes.length < 6) return { trend: 'NORMAL', relativeVolume: 1, climax: false, accDist: 'NEUTRAL' };

  const recent = volumes.slice(-5);
  const older = volumes.slice(-20, -5);
  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const olderAvg = older.length > 0 ? older.reduce((s, v) => s + v, 0) / older.length : recentAvg;

  const relativeVolume = olderAvg > 0 ? recentAvg / olderAvg : 1;

  let trend;
  if (relativeVolume > 2.0) trend = 'SURGING';
  else if (relativeVolume > 1.3) trend = 'INCREASING';
  else if (relativeVolume < 0.6) trend = 'DECLINING';
  else trend = 'NORMAL';

  // Volume climax
  const maxVol = Math.max(...volumes.slice(-20));
  const lastVol = volumes[volumes.length - 1];
  const climax = lastVol > maxVol * 0.9;

  // Accumulation/Distribution proxy
  let adSum = 0;
  const lookback = Math.min(20, closes.length);
  for (let i = closes.length - lookback; i < closes.length; i++) {
    if (closes[i] > opens[i]) adSum += volumes[i];
    else if (closes[i] < opens[i]) adSum -= volumes[i];
  }
  const accDist = adSum > 0 ? 'ACCUMULATING' : adSum < 0 ? 'DISTRIBUTING' : 'NEUTRAL';

  return { trend, relativeVolume: Math.round(relativeVolume * 100) / 100, climax, accDist };
}

// ====================================================
// VOLATILITY STATE
// ====================================================
function classifyVolatility(atr, closes) {
  if (closes.length < 14) return 'normal';
  const price = closes[closes.length - 1];
  const atrPct = (atr / price) * 100;
  if (atrPct > 5) return 'extreme';
  if (atrPct > 3) return 'high';
  if (atrPct > 1) return 'normal';
  return 'low';
}

// ====================================================
// REGIME DETECTION
// ====================================================
function detectRegime(tf1d, tf4h) {
  const adx = tf1d.adx || 0;
  const bbSqueeze = tf4h.bbSqueeze;
  const trend = tf1d.trend;
  const vol = tf1d.volatilityState;

  if (adx > 30 && (trend === 'STRONG_UP' || trend === 'STRONG_DOWN')) return 'trending';
  if (adx > 20 && (trend === 'UP' || trend === 'DOWN')) return 'trending';
  if (bbSqueeze) return 'compression';
  if (vol === 'extreme' || vol === 'high') return 'volatile';
  if (adx < 15) return 'ranging';
  return 'mixed';
}

// ====================================================
// STRATEGY SELECTION
// ====================================================
function pickStrategy(s1h, s4h, s1d, regime) {
  const strategies = {
    trend_follow: { id: 'trend_follow', name: 'Trend Following', score: 0 },
    breakout:     { id: 'breakout',     name: 'Breakout',        score: 0 },
    mean_revert:  { id: 'mean_revert',  name: 'Mean Reversion',  score: 0 },
    momentum:     { id: 'momentum',     name: 'Momentum',        score: 0 }
  };

  // Trend following scores high with strong trends and ADX
  strategies.trend_follow.score = s1d.trend * 1.5 + s4h.trend * 1.2;
  if (regime === 'trending') strategies.trend_follow.score += 20;

  // Breakout scores high with compression + structure
  strategies.breakout.score = s1h.volatility * 2 + s1h.structure * 1.3;
  if (regime === 'compression') strategies.breakout.score += 25;

  // Mean reversion scores in ranging markets
  strategies.mean_revert.score = s1h.momentum * 1.2 + s1h.structure * 1.0;
  if (regime === 'ranging') strategies.mean_revert.score += 20;

  // Momentum scores with volume and momentum
  strategies.momentum.score = s1h.momentum * 1.5 + s1h.volume * 1.3;
  if (regime === 'trending') strategies.momentum.score += 10;

  let best = strategies.trend_follow;
  for (const s of Object.values(strategies)) {
    if (s.score > best.score) best = s;
  }
  return best;
}

// ====================================================
// LEVERAGE SUGGESTION
// ====================================================
function suggestLeverage(score, regime, volatilityState) {
  let maxLev = 1;
  if (score >= 80) maxLev = 10;
  else if (score >= 70) maxLev = 7;
  else if (score >= 60) maxLev = 5;
  else if (score >= 50) maxLev = 3;
  else if (score >= 40) maxLev = 2;
  else maxLev = 1;

  if (regime === 'ranging' || regime === 'mixed') maxLev = Math.max(1, Math.floor(maxLev * 0.6));
  if (volatilityState === 'high') maxLev = Math.max(1, Math.floor(maxLev * 0.5));
  if (volatilityState === 'extreme') maxLev = 1;

  return maxLev;
}

// ====================================================
// TRADE LEVELS
// ====================================================
function calculateTradeLevels(currentPrice, tf1h, tf4h, signal, direction) {
  const atr = tf1h.atr || currentPrice * 0.02;
  const support = tf1h.support;
  const resistance = tf1h.resistance;

  let entry, tp1, tp2, tp3, stopLoss;

  if (signal === 'STRONG_BUY' || signal === 'BUY') {
    entry = r2(currentPrice);
    stopLoss = r2(Math.max(support * 0.995, entry - atr * 2));
    if (stopLoss >= entry) stopLoss = r2(entry - atr * 2.5);
    const risk = entry - stopLoss;
    tp1 = r2(entry + risk * 1.5);
    tp2 = r2(entry + risk * 2.5);
    tp3 = r2(entry + risk * 4);
  } else if (signal === 'STRONG_SELL' || signal === 'SELL') {
    entry = r2(currentPrice);
    stopLoss = r2(Math.min(resistance * 1.005, entry + atr * 2));
    if (stopLoss <= entry) stopLoss = r2(entry + atr * 2.5);
    const risk = stopLoss - entry;
    tp1 = r2(entry - risk * 1.5);
    tp2 = r2(entry - risk * 2.5);
    tp3 = r2(entry - risk * 4);
  } else {
    entry = r2(currentPrice);
    stopLoss = r2(support * 0.995);
    tp1 = r2(resistance);
    tp2 = r2(resistance * 1.03);
    tp3 = r2(resistance * 1.06);
  }

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(tp2 - entry);
  const riskReward = risk > 0 ? r2(reward / risk) : 0;

  return { entry, tp1, tp2, tp3, stopLoss, riskReward };
}

// ====================================================
// CONFIDENCE
// ====================================================
function calculateConfidence(score, confluenceLevel, regime, dataPoints) {
  let conf = 20;
  conf += Math.min(25, score * 0.3);
  if (confluenceLevel === 3) conf += 20;
  else if (confluenceLevel === 2) conf += 12;
  else conf += 3;
  if (regime === 'trending') conf += 10;
  else if (regime === 'compression') conf += 5;
  conf += Math.min(10, dataPoints / 20);
  return Math.min(95, Math.max(10, Math.round(conf)));
}

// ====================================================
// REASONING BUILDER
// ====================================================
function buildReasoning(s1h, s4h, s1d, confluenceLevel, regime, strategy, signal) {
  const reasons = [];

  if (confluenceLevel === 3) reasons.push('All 3 timeframes agree - strong confluence');
  else if (confluenceLevel === 2) reasons.push('2/3 timeframes agree - moderate confluence');
  else reasons.push('Mixed timeframes - weak confluence, trade with caution');

  reasons.push(`Strategy: ${strategy.name} (best fit for ${regime} regime)`);
  reasons.push(`1H: ${s1h.label} (${s1h.total}/100) | 4H: ${s4h.label} (${s4h.total}/100) | 1D: ${s1d.label} (${s1d.total}/100)`);

  if (s1d.trend >= 12) reasons.push('Daily trend strong - aligned with higher timeframe');
  if (s1h.momentum >= 12) reasons.push('Momentum confirming on 1H');
  if (s4h.volume >= 12) reasons.push('Volume supporting on 4H');
  if (s1h.structure >= 12) reasons.push('Market structure favorable');

  return reasons;
}

// ====================================================
// BEST TIMEFRAME
// ====================================================
function determineBestTF(s1h, s4h, s1d) {
  if (s1d.total >= s4h.total && s1d.total >= s1h.total) return '1D';
  if (s4h.total >= s1h.total) return '4H';
  return '1H';
}

// ====================================================
// FALLBACK: CoinGecko close-price history
// ====================================================
function analyzeWithHistory(coinData, history) {
  const rawPrices = history.prices.map(p => p.price);
  const rawVolumes = history.volumes.map(v => v.volume);

  // Simulate OHLCV from close prices
  const fakeCandles = rawPrices.map((price, i) => ({
    open: i > 0 ? rawPrices[i - 1] : price,
    high: price * 1.001,
    low: price * 0.999,
    close: price,
    volume: rawVolumes[i] || 0
  }));

  const candles = {
    '1h': fakeCandles,
    '4h': resample(fakeCandles, 4),
    '1d': resample(fakeCandles, 24)
  };

  return analyzeWithCandles(coinData, candles);
}

function resample(candles, factor) {
  const result = [];
  for (let i = factor - 1; i < candles.length; i += factor) {
    const chunk = candles.slice(Math.max(0, i - factor + 1), i + 1);
    result.push({
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0)
    });
  }
  return result;
}

// ====================================================
// BASIC SIGNAL FALLBACK (24h data only)
// ====================================================
function generateBasicSignal(coinData) {
  const price = coinData.price;
  const change = coinData.change24h || 0;
  let score = 30;
  const reasons = [];

  if (change < -8) { score += 20; reasons.push(`Down ${change.toFixed(1)}% - Oversold bounce potential`); }
  else if (change < -4) { score += 12; reasons.push(`Down ${change.toFixed(1)}% - Watching for reversal`); }
  else if (change > 8) { score += 15; reasons.push(`Up ${change.toFixed(1)}% - Strong momentum but extended`); }
  else if (change > 4) { score += 10; reasons.push(`Up ${change.toFixed(1)}% - Bullish momentum`); }
  else { reasons.push(`Flat (${change.toFixed(1)}%) - No clear direction`); }

  reasons.push('Limited data: analysis from 24h change only');

  const signal = change < -5 ? 'BUY' : change > 8 ? 'SELL' : 'HOLD';
  const dir = change < -3 ? 'BULL' : change > 5 ? 'BEAR' : 'NEUTRAL';

  const vol = price * (Math.abs(change) / 100 || 0.02);
  let entry = r2(price), sl, tp1, tp2, tp3;
  if (signal === 'BUY') { sl = r2(price - vol * 2); const risk = entry - sl; tp1 = r2(entry + risk * 1.5); tp2 = r2(entry + risk * 2.5); tp3 = r2(entry + risk * 4); }
  else if (signal === 'SELL') { sl = r2(price + vol * 2); const risk = sl - entry; tp1 = r2(entry - risk * 1.5); tp2 = r2(entry - risk * 2.5); tp3 = r2(entry - risk * 4); }
  else { sl = r2(price - vol * 2); tp1 = r2(price + vol); tp2 = r2(price + vol * 2); tp3 = r2(price + vol * 3); }

  const risk = Math.abs(entry - sl); const reward = Math.abs(tp2 - entry);

  return {
    coin: { id: coinData.id, symbol: coinData.symbol, name: coinData.name, price, change24h: coinData.change24h, volume24h: coinData.volume24h, marketCap: coinData.marketCap },
    signal, score, strength: score, confidence: 25, confluenceLevel: 0,
    bestTimeframe: '24H', strategyType: 'basic', strategyName: 'Basic 24H',
    regime: 'unknown', suggestedLeverage: 1,
    entry, takeProfit1: tp1, takeProfit2: tp2, takeProfit3: tp3, stopLoss: sl,
    riskReward: risk > 0 ? r2(reward / risk) : 0,
    reasoning: reasons,
    scoreBreakdown: { trend: 0, momentum: 0, volume: 0, structure: 0, volatility: 0, riskQuality: 0 },
    timeframes: {
      '1H': { signal: 'LOADING', score: 0, direction: 'NEUTRAL', rsi: '-', trend: '-', adx: '-' },
      '4H': { signal: 'LOADING', score: 0, direction: 'NEUTRAL', rsi: '-', trend: '-', adx: '-' },
      '1D': { signal: dir === 'BULL' ? 'BUY' : dir === 'BEAR' ? 'SELL' : 'NEUTRAL', score, direction: dir, rsi: '-', trend: change > 3 ? 'UP' : change < -3 ? 'DOWN' : 'SIDEWAYS', adx: '-' }
    },
    indicators: {}, timestamp: new Date().toISOString()
  };
}

function defaultAnalysis(currentPrice) {
  return {
    rsi: 50, sma20: currentPrice, sma50: currentPrice, ema9: currentPrice, ema21: currentPrice,
    macdLine: 0, macdSignal: 0, macdHistogram: 0, atr: currentPrice * 0.02, adx: 0,
    bbUpper: currentPrice * 1.02, bbLower: currentPrice * 0.98, bbMid: currentPrice, bbSqueeze: false,
    stochK: 50, stochD: 50, vwap: currentPrice,
    support: currentPrice * 0.95, resistance: currentPrice * 1.05,
    marketStructure: 'UNKNOWN', trend: 'SIDEWAYS',
    volumeTrend: 'NORMAL', relativeVolume: 1, volumeClimax: false, accDist: 'NEUTRAL',
    volatilityState: 'normal', currentPrice, closes: [], highs: [], lows: [], volumes: []
  };
}

// ====================================================
// UTILITIES
// ====================================================
function r2(num) {
  if (num === null || num === undefined || isNaN(num)) return 0;
  if (Math.abs(num) >= 1) return Math.round(num * 100) / 100;
  if (Math.abs(num) >= 0.01) return Math.round(num * 10000) / 10000;
  return Math.round(num * 100000000) / 100000000;
}

module.exports = { analyzeCoin, analyzeAllCoins };
