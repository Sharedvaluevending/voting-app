// services/trading-engine.js
// ====================================================
// ADVANCED MULTI-STRATEGY TRADING ENGINE v4.0
//
// Uses Binance OHLCV candles across 15m, 1H, 4H, 1D, 1W.
// Scores signals 0-100 using 6 categories (learned weights optional).
// Min score/confluence gate, regime-strategy gating, BTC filter,
// MTF divergence, dynamic stops, multi-TF S/R, VWAP bands,
// order blocks, liquidity clusters, session filter.
// ====================================================

// Config: quality gates and filters (quant-desk upgrades)
const ENGINE_CONFIG = {
  MIN_SIGNAL_SCORE: 50,
  MIN_CONFLUENCE_FOR_SIGNAL: 2,
  MTF_DIVERGENCE_PENALTY: 10,
  SESSION_START_UTC: 12,
  SESSION_END_UTC: 22,
  SESSION_PENALTY: 5,
  BTC_STRONG_OPPOSITE_FORCE_HOLD: true
};

// ====================================================
// MAIN ANALYSIS ENTRY POINT
// ====================================================
function analyzeCoin(coinData, candles, history, options) {
  options = options || {};
  const currentPrice = coinData.price;

  // Try Binance candles first, fall back to CoinGecko history
  if (candles && candles['1h'] && candles['1h'].length >= 20) {
    return analyzeWithCandles(coinData, candles, options);
  }

  // Fallback to CoinGecko close-price history
  if (history && history.prices && history.prices.length >= 10) {
    return analyzeWithHistory(coinData, history, options);
  }

  // Basic signal from 24h change only
  return generateBasicSignal(coinData);
}

function analyzeAllCoins(allPrices, allCandles, allHistory, options) {
  options = options || {};
  const strategyWeights = options.strategyWeights || [];
  const btcSignal = options.btcSignal || null;

  const signals = allPrices.map(coinData => {
    const candles = allCandles[coinData.id] || null;
    const history = allHistory[coinData.id] || { prices: [], volumes: [] };
    return analyzeCoin(coinData, candles, history, options);
  });

  // BTC regime filter: don't LONG alts when BTC is STRONG_SELL, don't SHORT when BTC is STRONG_BUY
  if (ENGINE_CONFIG.BTC_STRONG_OPPOSITE_FORCE_HOLD && btcSignal) {
    signals.forEach(sig => {
      if (sig.coin.id === 'bitcoin') return;
      if (btcSignal === 'STRONG_SELL' && (sig.signal === 'BUY' || sig.signal === 'STRONG_BUY')) {
        sig.signal = 'HOLD';
        sig.reasoning = (sig.reasoning || []).concat(['BTC strongly bearish – alt longs suppressed']);
      } else if (btcSignal === 'STRONG_BUY' && (sig.signal === 'SELL' || sig.signal === 'STRONG_SELL')) {
        sig.signal = 'HOLD';
        sig.reasoning = (sig.reasoning || []).concat(['BTC strongly bullish – alt shorts suppressed']);
      }
    });
  }

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
function analyzeWithCandles(coinData, candles, options) {
  options = options || {};
  const currentPrice = coinData.price;
  const strategyWeights = options.strategyWeights || [];

  // Analyze each real timeframe
  const tf1h = analyzeOHLCV(candles['1h'], currentPrice);
  const tf4h = analyzeOHLCV(candles['4h'], currentPrice);
  const tf1d = analyzeOHLCV(candles['1d'], currentPrice);

  // Optional 15m and 1w for scalping / position strategies
  let scores15m = null;
  let scores1w = null;
  let tf15m = null;
  let tf1w = null;
  if (candles['15m'] && candles['15m'].length >= 20) {
    tf15m = analyzeOHLCV(candles['15m'], currentPrice);
    scores15m = scoreCandles(tf15m, currentPrice, '15m');
  }
  if (candles['1w'] && candles['1w'].length >= 5) {
    tf1w = analyzeOHLCV(candles['1w'], currentPrice);
    scores1w = scoreCandles(tf1w, currentPrice, '1w');
  }

  // Score each timeframe across 6 dimensions (0-100 total)
  const scores1h = scoreCandles(tf1h, currentPrice, '1h');
  const scores4h = scoreCandles(tf4h, currentPrice, '4h');
  const scores1d = scoreCandles(tf1d, currentPrice, '1d');

  // Weighted confluence: 1D=40%, 4H=35%, 1H=25%
  let finalScore = Math.round(
    scores1d.total * 0.40 + scores4h.total * 0.35 + scores1h.total * 0.25
  );

  // MTF divergence penalty: 1H vs 4H direction disagree
  const directions = [scores1h.direction, scores4h.direction, scores1d.direction];
  const bullCount = directions.filter(d => d === 'BULL').length;
  const bearCount = directions.filter(d => d === 'BEAR').length;
  const confluenceLevel = Math.max(bullCount, bearCount);
  // Tie-breaker: when 1-1, use score to infer direction (avoid BULL bias). Score high = bullish bias, low = bearish bias.
  let dominantDir;
  if (bullCount > bearCount) dominantDir = 'BULL';
  else if (bearCount > bullCount) dominantDir = 'BEAR';
  else {
    dominantDir = finalScore >= 55 ? 'BULL' : finalScore <= 45 ? 'BEAR' : 'NEUTRAL';
  }
  if (scores1h.direction !== scores4h.direction && scores1h.direction !== 'NEUTRAL' && scores4h.direction !== 'NEUTRAL') {
    finalScore = Math.max(0, finalScore - ENGINE_CONFIG.MTF_DIVERGENCE_PENALTY);
  }

  // Session filter: outside 12–22 UTC reduce score slightly
  const utcHour = new Date().getUTCHours();
  const inSession = utcHour >= ENGINE_CONFIG.SESSION_START_UTC && utcHour < ENGINE_CONFIG.SESSION_END_UTC;
  if (!inSession) {
    finalScore = Math.max(0, finalScore - ENGINE_CONFIG.SESSION_PENALTY);
  }

  // Divergence & top/bottom modifiers – avoid getting trapped at extremes
  const mergeDiv = (rsi, macd, obv, stoch) => {
    const bull = (rsi?.bullish || macd?.bullish || obv?.bullish || stoch?.bullish) || false;
    const bear = (rsi?.bearish || macd?.bearish || obv?.bearish || stoch?.bearish) || false;
    const bullCount = [rsi?.bullish, macd?.bullish, obv?.bullish, stoch?.bullish].filter(Boolean).length;
    const bearCount = [rsi?.bearish, macd?.bearish, obv?.bearish, stoch?.bearish].filter(Boolean).length;
    const confluence = (bull && bullCount >= 2) || (bear && bearCount >= 2);
    return { bullish: bull, bearish: bear, confluence };
  };
  const div1h = mergeDiv(tf1h.rsiDivergence, tf1h.macdDivergence, tf1h.obvDivergence, tf1h.stochDivergence);
  const div4h = mergeDiv(tf4h.rsiDivergence, tf4h.macdDivergence, tf4h.obvDivergence, tf4h.stochDivergence);
  const divMod = (d) => {
    let delta = 0;
    const boost = d.confluence ? 2 : 0; // 2+ divergence types = stronger
    if (d.bullish) { delta += dominantDir === 'BULL' ? 8 + boost : (dominantDir === 'BEAR' ? -6 - boost : 4); }
    if (d.bearish) { delta += dominantDir === 'BEAR' ? 8 + boost : (dominantDir === 'BULL' ? -6 - boost : -4); }
    return delta;
  };
  finalScore += Math.round((divMod(div1h) * 0.6 + divMod(div4h) * 0.4));
  if (tf1h.potentialBottom) {
    if (dominantDir === 'BEAR') finalScore = Math.max(0, finalScore - 12);
    else if (dominantDir === 'BULL') finalScore = Math.min(100, finalScore + 6);
  }
  if (tf1h.potentialTop) {
    if (dominantDir === 'BULL') finalScore = Math.max(0, finalScore - 12);
    else if (dominantDir === 'BEAR') finalScore = Math.min(100, finalScore + 6);
  }

  // Detect market regime
  const regime = detectRegime(tf1d, tf4h);

  // Best strategy + all strategies (with regime gating and optional learned weights)
  const strategyStats = options.strategyStats || {};
  const { best: bestStrategy, allStrategies: allStrategiesWithScores } = pickStrategy(
    scores1h, scores4h, scores1d, regime, scores15m, scores1w, strategyWeights, strategyStats
  );

  // Determine signal from score (with min score/confluence gate)
  let { signal, strength } = scoreToSignal(finalScore, confluenceLevel, dominantDir);
  if (finalScore < ENGINE_CONFIG.MIN_SIGNAL_SCORE || confluenceLevel < ENGINE_CONFIG.MIN_CONFLUENCE_FOR_SIGNAL) {
    if (signal !== 'HOLD') {
      signal = 'HOLD';
      strength = finalScore;
    }
  }

  // Strategy-specific direction: use the timeframes that strategy actually uses
  const stratDirMap = {
    scalping: scores15m ? [scores15m, scores1h] : [scores1h],
    momentum: [scores1h],
    breakout: [scores1h],
    mean_revert: [scores1h],
    trend_follow: [scores4h, scores1d],
    swing: [scores4h, scores1d],
    position: scores1w ? [scores1d, scores1w] : [scores1d]
  };
  function getStratDominantDirAndConfluence(stratId) {
    const scores = stratDirMap[stratId] || [scores1h, scores4h, scores1d];
    const dirs = scores.map(sc => sc && sc.direction).filter(Boolean);
    const bull = dirs.filter(d => d === 'BULL').length;
    const bear = dirs.filter(d => d === 'BEAR').length;
    const conf = Math.max(bull, bear);
    const dir = bear > bull ? 'BEAR' : bull > bear ? 'BULL' : dominantDir;
    return { dir, confluence: conf || 1 };
  }

  // All strategies with display score, sorted by score (so user can pick any)
  const topStrategiesRaw = allStrategiesWithScores
    .filter(s => s.displayScore != null)
    .sort((a, b) => b.displayScore - a.displayScore);
  const topStrategies = topStrategiesRaw.map(s => {
    const stratScore = Math.round(s.displayScore);
    const { dir: stratDir, confluence: stratConfluence } = getStratDominantDirAndConfluence(s.id);
    const stratSignal = scoreToSignal(stratScore, Math.max(1, stratConfluence), stratDir).signal;
    const stratDirForLevels = stratSignal === 'STRONG_BUY' || stratSignal === 'BUY' ? 'BULL' : stratSignal === 'STRONG_SELL' || stratSignal === 'SELL' ? 'BEAR' : dominantDir;
    const levelsForStrat = calculateTradeLevels(currentPrice, tf1h, tf4h, tf1d, stratSignal, stratDirForLevels, regime, s.id);
    return {
      id: s.id,
      name: s.name,
      score: stratScore,
      signal: stratSignal,
      entry: levelsForStrat.entry,
      stopLoss: levelsForStrat.stopLoss,
      takeProfit1: levelsForStrat.tp1,
      takeProfit2: levelsForStrat.tp2,
      takeProfit3: levelsForStrat.tp3,
      riskReward: levelsForStrat.riskReward
    };
  });

  // Main trade levels (blended signal; no strategy override)
  const levels = calculateTradeLevels(currentPrice, tf1h, tf4h, tf1d, signal, dominantDir, regime);

  // Suggest leverage
  const suggestedLev = suggestLeverage(finalScore, regime, tf1h.volatilityState);

  // Build reasoning (include session, MTF divergence, quality gate if applicable)
  const reasoning = buildReasoning(scores1h, scores4h, scores1d, confluenceLevel, regime, bestStrategy, signal, finalScore, inSession, tf1h, tf4h, tf1d);

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
    topStrategies,
    regime,
    suggestedLeverage: suggestedLev,
    entry: levels.entry,
    takeProfit1: levels.tp1,
    takeProfit2: levels.tp2,
    takeProfit3: levels.tp3,
    stopLoss: levels.stopLoss,
    riskReward: levels.riskReward,
    stopType: STOP_TP_LABELS.stopType,
    stopLabel: STOP_TP_LABELS.stopLabel,
    tpType: STOP_TP_LABELS.tpType,
    tpLabel: STOP_TP_LABELS.tpLabel,
    reasoning,
    scoreBreakdown: {
      trend: Math.round(scores1d.trend * 0.4 + scores4h.trend * 0.35 + scores1h.trend * 0.25),
      momentum: Math.round(scores1d.momentum * 0.4 + scores4h.momentum * 0.35 + scores1h.momentum * 0.25),
      volume: Math.round(scores1d.volume * 0.4 + scores4h.volume * 0.35 + scores1h.volume * 0.25),
      structure: Math.round(scores1d.structure * 0.4 + scores4h.structure * 0.35 + scores1h.structure * 0.25),
      volatility: Math.round(scores1d.volatility * 0.4 + scores4h.volatility * 0.35 + scores1h.volatility * 0.25),
      riskQuality: Math.round(scores1d.riskQuality * 0.4 + scores4h.riskQuality * 0.35 + scores1h.riskQuality * 0.25)
    },
    timeframes: Object.assign({
      '1H': { signal: scores1h.label, score: scores1h.total, direction: scores1h.direction, rsi: r2(tf1h.rsi), trend: tf1h.trend, adx: r2(tf1h.adx) },
      '4H': { signal: scores4h.label, score: scores4h.total, direction: scores4h.direction, rsi: r2(tf4h.rsi), trend: tf4h.trend, adx: r2(tf4h.adx) },
      '1D': { signal: scores1d.label, score: scores1d.total, direction: scores1d.direction, rsi: r2(tf1d.rsi), trend: tf1d.trend, adx: r2(tf1d.adx) }
    }, scores15m && tf15m ? { '15m': { signal: scores15m.label, score: scores15m.total, direction: scores15m.direction, rsi: r2(tf15m.rsi), trend: tf15m.trend, adx: r2(tf15m.adx) } } : {}, scores1w && tf1w ? { '1W': { signal: scores1w.label, score: scores1w.total, direction: scores1w.direction, rsi: r2(tf1w.rsi), trend: tf1w.trend, adx: r2(tf1w.adx) } } : {}),
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
      rsiDivergence: tf1h.rsiDivergence,
      macdDivergence: tf1h.macdDivergence,
      obvDivergence: tf1h.obvDivergence,
      stochDivergence: tf1h.stochDivergence,
      potentialBottom: tf1h.potentialBottom,
      potentialTop: tf1h.potentialTop,
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

  // Order blocks, FVG, liquidity clusters (price-action confluence)
  const orderBlocks = detectOrderBlocks(opens, highs, lows, closes, atr);
  const fvgs = detectFVGs(highs, lows);
  const liquidityClusters = detectLiquidityClusters(highs, lows, currentPrice);

  // Market Structure: HH/HL/LH/LL
  const marketStructure = detectMarketStructure(highs, lows);

  // Divergence detection (RSI, MACD, OBV, Stochastic) - helps identify tops/bottoms
  const rsiHistory = buildRSIHistory(closes, 14);
  const macdHistHistory = buildMACDHistogramHistory(closes);
  const obvHistory = buildOBVHistory(closes, volumes);
  const stochHistory = buildStochasticHistory(highs, lows, closes, 14);
  const rsiDiv = detectRSIDivergence(closes, lows, highs, rsiHistory);
  const macdDiv = detectMACDDivergence(closes, lows, highs, macdHistHistory);
  const obvDiv = detectOBVDivergence(closes, lows, highs, obvHistory);
  const stochDiv = detectStochasticDivergence(closes, lows, highs, stochHistory);

  // Top/bottom warnings: reversal likely against current trend (2+ divergence types = stronger)
  const allDivs = { rsiDiv, macdDiv, obvDiv, stochDiv };
  const potentialBottom = detectPotentialBottom(closes, lows, rsi, allDivs, sr.support, currentPrice);
  const potentialTop = detectPotentialTop(closes, highs, rsi, allDivs, sr.resistance, currentPrice);

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
    orderBlocks, fvgs, liquidityClusters,
    marketStructure,
    rsiDivergence: rsiDiv,
    macdDivergence: macdDiv,
    obvDivergence: obvDiv,
    stochDivergence: stochDiv,
    potentialBottom,
    potentialTop,
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

  // MACD histogram magnitude (already checked direction above; this scores strength)
  if (Math.abs(analysis.macdHistogram) > 0) { momentum += 2; }

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

  // VWAP bands: price within 0.5 ATR of VWAP = value zone (small bonus)
  const atrP = analysis.atr || 0;
  if (atrP > 0 && analysis.vwap > 0) {
    const dist = Math.abs(currentPrice - analysis.vwap) / atrP;
    if (dist < 0.5) volume += 2;
  }
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

  // Order blocks: price at/near zone adds confluence
  const ob = analysis.orderBlocks || [];
  for (const b of ob) {
    const mid = (b.top + b.bottom) / 2;
    const dist = (mid > 0) ? Math.abs(currentPrice - mid) / mid : 1;
    if (dist < 0.008) {
      if (b.type === 'BULL') { structure += 3; bullPoints += 1; }
      else if (b.type === 'BEAR') { structure += 3; bearPoints += 1; }
    }
  }
  // Fair value gaps: price inside or just touching zone
  const fvgList = analysis.fvgs || [];
  for (const f of fvgList) {
    const inZone = currentPrice >= f.bottom && currentPrice <= f.top;
    const nearLow = f.bottom > 0 && currentPrice >= f.bottom * 0.997 && currentPrice <= f.bottom * 1.003;
    const nearHigh = f.top > 0 && currentPrice >= f.top * 0.997 && currentPrice <= f.top * 1.003;
    if (inZone || nearLow || nearHigh) {
      if (f.type === 'BULL') { structure += 2; bullPoints += 1; }
      else if (f.type === 'BEAR') { structure += 2; bearPoints += 1; }
    }
  }
  // Liquidity cluster: near cluster above = potential resistance/sweep; near below = support
  const liq = analysis.liquidityClusters || {};
  if (liq.above != null && liq.above > 0 && currentPrice >= liq.above * 0.995 && currentPrice <= liq.above * 1.01) {
    structure += 1; bearPoints += 1;
  }
  if (liq.below != null && liq.below > 0 && currentPrice <= liq.below * 1.005 && currentPrice >= liq.below * 0.99) {
    structure += 1; bullPoints += 1;
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

  // Direction: require +1 margin (was +2) to reduce excessive NEUTRAL
  if (bullPoints > bearPoints + 1) direction = 'BULL';
  else if (bearPoints > bullPoints + 1) direction = 'BEAR';

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
// DIVERGENCE DETECTION (RSI, MACD) - identify tops/bottoms
// ====================================================
function buildRSIHistory(prices, period) {
  const result = [];
  for (let i = period + 1; i <= prices.length; i++) {
    result.push(RSI(prices.slice(0, i), period));
  }
  return result;
}

function buildMACDHistogramHistory(prices) {
  const macdLine = buildMACDHistory(prices);
  const result = [];
  for (let i = 0; i < macdLine.length; i++) {
    const signal = i >= 9 ? EMA(macdLine.slice(0, i + 1), 9) : macdLine[i];
    result.push(macdLine[i] - signal);
  }
  return result;
}

function getSwingPoints(lows, highs, lookback) {
  const swingLows = [];
  const swingHighs = [];
  const start = Math.max(2, (lows.length || 0) - lookback);
  for (let i = start; i < (lows.length || 0) - 2; i++) {
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      swingLows.push({ idx: i, val: lows[i] });
    }
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      swingHighs.push({ idx: i, val: highs[i] });
    }
  }
  return { swingLows, swingHighs };
}

function detectRSIDivergence(closes, lows, highs, rsiHistory) {
  const result = { bullish: false, bearish: false };
  if (!rsiHistory || rsiHistory.length < 20 || !lows || !highs) return result;
  const lookback = Math.min(40, Math.floor(lows.length / 2));
  const { swingLows, swingHighs } = getSwingPoints(lows, highs, lookback);
  // RSI index offset: rsiHistory[i] corresponds to closes[14+i] roughly (RSI needs 15 candles)
  const rsiOffset = 15;
  if (swingLows.length >= 2) {
    const L1 = swingLows[swingLows.length - 2];
    const L2 = swingLows[swingLows.length - 1];
    const idx1 = Math.min(L1.idx - rsiOffset, rsiHistory.length - 1);
    const idx2 = Math.min(L2.idx - rsiOffset, rsiHistory.length - 1);
    if (idx1 >= 0 && idx2 >= 0 && L2.val < L1.val && rsiHistory[idx2] > rsiHistory[idx1] + 2) {
      result.bullish = true; // Price lower low, RSI higher low = bullish divergence
    }
  }
  if (swingHighs.length >= 2) {
    const H1 = swingHighs[swingHighs.length - 2];
    const H2 = swingHighs[swingHighs.length - 1];
    const idx1 = Math.min(H1.idx - rsiOffset, rsiHistory.length - 1);
    const idx2 = Math.min(H2.idx - rsiOffset, rsiHistory.length - 1);
    if (idx1 >= 0 && idx2 >= 0 && H2.val > H1.val && rsiHistory[idx2] < rsiHistory[idx1] - 2) {
      result.bearish = true; // Price higher high, RSI lower high = bearish divergence
    }
  }
  return result;
}

function buildOBVHistory(closes, volumes) {
  if (!closes || !volumes || closes.length !== volumes.length || closes.length < 5) return [];
  const result = []; let obv = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i > 0) {
      if (closes[i] > closes[i - 1]) obv += volumes[i];
      else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    }
    result.push(obv);
  }
  return result;
}

function buildStochasticHistory(highs, lows, closes, period) {
  if (!highs || !lows || !closes || closes.length < period) return [];
  const result = [];
  for (let i = period - 1; i < closes.length; i++) {
    const sliceH = highs.slice(i - period + 1, i + 1);
    const sliceL = lows.slice(i - period + 1, i + 1);
    const h = Math.max(...sliceH);
    const l = Math.min(...sliceL);
    const k = h === l ? 50 : ((closes[i] - l) / (h - l)) * 100;
    result.push(k);
  }
  return result;
}

function detectOBVDivergence(closes, lows, highs, obvHistory) {
  const result = { bullish: false, bearish: false };
  if (!obvHistory || obvHistory.length < 20 || !lows || !highs) return result;
  const lookback = Math.min(40, Math.floor(lows.length / 2));
  const { swingLows, swingHighs } = getSwingPoints(lows, highs, lookback);
  // obvHistory[i] aligns with closes[i]
  if (swingLows.length >= 2) {
    const L1 = swingLows[swingLows.length - 2];
    const L2 = swingLows[swingLows.length - 1];
    const idx1 = Math.min(L1.idx, obvHistory.length - 1);
    const idx2 = Math.min(L2.idx, obvHistory.length - 1);
    if (idx1 >= 0 && idx2 >= 0 && L2.val < L1.val && obvHistory[idx2] > obvHistory[idx1]) {
      result.bullish = true; // Price lower low, OBV higher low = bullish
    }
  }
  if (swingHighs.length >= 2) {
    const H1 = swingHighs[swingHighs.length - 2];
    const H2 = swingHighs[swingHighs.length - 1];
    const idx1 = Math.min(H1.idx, obvHistory.length - 1);
    const idx2 = Math.min(H2.idx, obvHistory.length - 1);
    if (idx1 >= 0 && idx2 >= 0 && H2.val > H1.val && obvHistory[idx2] < obvHistory[idx1]) {
      result.bearish = true; // Price higher high, OBV lower high = bearish
    }
  }
  return result;
}

function detectStochasticDivergence(closes, lows, highs, stochHistory) {
  const result = { bullish: false, bearish: false };
  if (!stochHistory || stochHistory.length < 20 || !lows || !highs) return result;
  const lookback = Math.min(40, Math.floor(lows.length / 2));
  const { swingLows, swingHighs } = getSwingPoints(lows, highs, lookback);
  // stochHistory[i] corresponds to closes[period-1+i]
  const stochOffset = 14 - 1;
  if (swingLows.length >= 2) {
    const L1 = swingLows[swingLows.length - 2];
    const L2 = swingLows[swingLows.length - 1];
    const idx1 = Math.min(L1.idx - stochOffset, stochHistory.length - 1);
    const idx2 = Math.min(L2.idx - stochOffset, stochHistory.length - 1);
    if (idx1 >= 0 && idx2 >= 0 && L2.val < L1.val && stochHistory[idx2] > stochHistory[idx1] + 2) {
      result.bullish = true; // Price lower low, Stoch higher low = bullish
    }
  }
  if (swingHighs.length >= 2) {
    const H1 = swingHighs[swingHighs.length - 2];
    const H2 = swingHighs[swingHighs.length - 1];
    const idx1 = Math.min(H1.idx - stochOffset, stochHistory.length - 1);
    const idx2 = Math.min(H2.idx - stochOffset, stochHistory.length - 1);
    if (idx1 >= 0 && idx2 >= 0 && H2.val > H1.val && stochHistory[idx2] < stochHistory[idx1] - 2) {
      result.bearish = true; // Price higher high, Stoch lower high = bearish
    }
  }
  return result;
}

function detectMACDDivergence(closes, lows, highs, macdHistHistory) {
  const result = { bullish: false, bearish: false };
  if (!macdHistHistory || macdHistHistory.length < 20 || !lows || !highs) return result;
  const lookback = Math.min(40, Math.floor(lows.length / 2));
  const { swingLows, swingHighs } = getSwingPoints(lows, highs, lookback);
  const macdOffset = 26;
  if (swingLows.length >= 2) {
    const L1 = swingLows[swingLows.length - 2];
    const L2 = swingLows[swingLows.length - 1];
    const idx1 = Math.min(L1.idx - macdOffset, macdHistHistory.length - 1);
    const idx2 = Math.min(L2.idx - macdOffset, macdHistHistory.length - 1);
    if (idx1 >= 0 && idx2 >= 0 && L2.val < L1.val && macdHistHistory[idx2] > macdHistHistory[idx1]) {
      result.bullish = true; // Price lower low, MACD histogram higher (less negative)
    }
  }
  if (swingHighs.length >= 2) {
    const H1 = swingHighs[swingHighs.length - 2];
    const H2 = swingHighs[swingHighs.length - 1];
    const idx1 = Math.min(H1.idx - macdOffset, macdHistHistory.length - 1);
    const idx2 = Math.min(H2.idx - macdOffset, macdHistHistory.length - 1);
    if (idx1 >= 0 && idx2 >= 0 && H2.val > H1.val && macdHistHistory[idx2] < macdHistHistory[idx1]) {
      result.bearish = true; // Price higher high, MACD histogram lower (less positive)
    }
  }
  return result;
}

function detectPotentialBottom(closes, lows, rsi, allDivs, support, currentPrice) {
  if (!support || support <= 0) return false;
  const bullishDiv = (allDivs.rsiDiv?.bullish || allDivs.macdDiv?.bullish || allDivs.obvDiv?.bullish || allDivs.stochDiv?.bullish) || false;
  const oversold = rsi < 35;
  const nearSupport = currentPrice <= support * 1.02 && currentPrice >= support * 0.98;
  return bullishDiv && (oversold || nearSupport);
}

function detectPotentialTop(closes, highs, rsi, allDivs, resistance, currentPrice) {
  if (!resistance || resistance <= 0) return false;
  const bearishDiv = (allDivs.rsiDiv?.bearish || allDivs.macdDiv?.bearish || allDivs.obvDiv?.bearish || allDivs.stochDiv?.bearish) || false;
  const overbought = rsi > 65;
  const nearResistance = currentPrice >= resistance * 0.98 && currentPrice <= resistance * 1.02;
  return bearishDiv && (overbought || nearResistance);
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
// ORDER BLOCKS (last opposing candle before strong move)
// ====================================================
function detectOrderBlocks(opens, highs, lows, closes, atr) {
  const blocks = [];
  if (!opens || opens.length < 5 || !atr || atr <= 0) return blocks;
  const bodyThreshold = atr * 0.4;
  const lookback = Math.min(40, opens.length - 2);

  for (let i = closes.length - 2; i >= Math.max(0, closes.length - lookback); i--) {
    const bodyPrev = closes[i] - opens[i];
    const bodyNext = closes[i + 1] - opens[i + 1];
    // Bullish OB: bearish candle then strong bullish move
    if (bodyPrev < 0 && bodyNext > bodyThreshold) {
      blocks.push({ type: 'BULL', top: highs[i], bottom: lows[i], idx: i });
      if (blocks.length >= 2) break;
    }
    // Bearish OB: bullish candle then strong bearish move
    if (bodyPrev > 0 && bodyNext < -bodyThreshold) {
      blocks.push({ type: 'BEAR', top: highs[i], bottom: lows[i], idx: i });
      if (blocks.length >= 2) break;
    }
  }
  return blocks;
}

// ====================================================
// FAIR VALUE GAPS (3-candle imbalance)
// ====================================================
function detectFVGs(highs, lows) {
  const fvgs = [];
  if (!highs || highs.length < 3) return fvgs;
  const lookback = Math.min(30, highs.length - 3);

  for (let i = highs.length - 1; i >= Math.max(0, highs.length - lookback); i--) {
    if (i + 2 >= highs.length) continue;
    // Bullish FVG: gap between candle i high and candle i+2 low
    if (lows[i + 2] > highs[i]) {
      fvgs.push({ type: 'BULL', top: lows[i + 2], bottom: highs[i], idx: i });
      if (fvgs.length >= 2) break;
    }
    // Bearish FVG: gap between candle i low and candle i+2 high
    if (highs[i + 2] < lows[i]) {
      fvgs.push({ type: 'BEAR', top: lows[i], bottom: highs[i + 2], idx: i });
      if (fvgs.length >= 2) break;
    }
  }
  return fvgs;
}

// ====================================================
// LIQUIDITY CLUSTERS (swing highs/lows grouped by proximity)
// ====================================================
function detectLiquidityClusters(highs, lows, currentPrice) {
  const result = { above: null, below: null };
  if (!highs || highs.length < 10) return result;
  const lookback = Math.min(48, highs.length);
  const recentH = highs.slice(-lookback);
  const recentL = lows.slice(-lookback);

  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < recentH.length - 2; i++) {
    if (recentH[i] > recentH[i - 1] && recentH[i] > recentH[i + 1]) swingHighs.push(recentH[i]);
    if (recentL[i] < recentL[i - 1] && recentL[i] < recentL[i + 1]) swingLows.push(recentL[i]);
  }
  if (swingHighs.length === 0 && swingLows.length === 0) return result;

  const pctTolerance = 0.005; // 0.5% = same level
  const cluster = (vals, isHigh) => {
    if (vals.length === 0) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    const groups = [];
    let group = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const diff = Math.abs(sorted[i] - group[group.length - 1]) / group[group.length - 1];
      if (diff <= pctTolerance) group.push(sorted[i]);
      else { groups.push(group); group = [sorted[i]]; }
    }
    groups.push(group);
    const best = groups.filter(g => isHigh ? g.some(v => v > currentPrice) : g.some(v => v < currentPrice));
    if (best.length === 0) return null;
    const nearest = isHigh
      ? best.map(g => Math.min(...g)).filter(v => v > currentPrice).sort((a, b) => a - b)[0]
      : best.map(g => Math.max(...g)).filter(v => v < currentPrice).sort((a, b) => b - a)[0];
    return nearest !== undefined ? nearest : null;
  };
  result.above = cluster(swingHighs, true);
  result.below = cluster(swingLows, false);
  return result;
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
// REGIME DETECTION (use both 1D and 4H so we don't default everything to ranging)
// ====================================================
function detectRegime(tf1d, tf4h) {
  const adx1d = tf1d.adx || 0;
  const adx4h = tf4h.adx || 0;
  const adx = Math.max(adx1d, adx4h);
  const bbSqueeze = tf4h.bbSqueeze;
  const trend = tf1d.trend;
  const vol = tf1d.volatilityState;

  if (adx > 30 && (trend === 'STRONG_UP' || trend === 'STRONG_DOWN')) return 'trending';
  if (adx > 20 && (trend === 'UP' || trend === 'DOWN')) return 'trending';
  if (bbSqueeze) return 'compression';
  if (vol === 'extreme' || vol === 'high') return 'volatile';
  if (adx > 0 && adx < 15) return 'ranging';
  return 'mixed';
}

// Regime–strategy gating: strategies not allowed in wrong regime (min sample still applies)
const REGIME_STRATEGY_BLOCK = {
  mean_revert: ['trending'],
  trend_follow: ['ranging'],
  momentum: ['ranging'],
  breakout: [],
  scalping: ['trending', 'ranging'],  // Scalping needs volatility/compression, not sustained trends or flat ranges
  swing: [],
  position: []
};

const MIN_TRADES_FOR_STRATEGY = 5;

// ====================================================
// STRATEGY SELECTION (7 strategies + regime gating + learned weights)
// ====================================================
function pickStrategy(s1h, s4h, s1d, regime, scores15m, scores1w, strategyWeights, strategyStats) {
  strategyWeights = strategyWeights || [];
  strategyStats = strategyStats || {};
  const byId = {};
  strategyWeights.forEach(w => { byId[w.strategyId || w.id] = w; });

  const strategies = {
    trend_follow: { id: 'trend_follow', name: 'Trend Following', score: 0, displayScore: 0 },
    breakout:     { id: 'breakout',     name: 'Breakout',        score: 0, displayScore: 0 },
    mean_revert:  { id: 'mean_revert',  name: 'Mean Reversion',  score: 0, displayScore: 0 },
    momentum:     { id: 'momentum',     name: 'Momentum',        score: 0, displayScore: 0 },
    scalping:     { id: 'scalping',     name: 'Scalping',        score: 0, displayScore: null },
    swing:        { id: 'swing',        name: 'Swing',           score: 0, displayScore: 0 },
    position:     { id: 'position',     name: 'Position',       score: 0, displayScore: null }
  };

  // Default dimension weights per strategy (used when no learned weights exist)
  // Each strategy emphasizes the dimensions it cares about most.
  // Scalping needs volatility + volume (short-term opportunities). Trend follow needs trend. Etc.
  const DEFAULT_WEIGHTS = {
    trend_follow: { trend: 30, momentum: 20, volume: 10, structure: 15, volatility: 10, riskQuality: 15 },
    breakout:     { trend: 10, momentum: 15, volume: 25, structure: 25, volatility: 15, riskQuality: 10 },
    mean_revert:  { trend: 10, momentum: 30, volume: 10, structure: 20, volatility: 20, riskQuality: 10 },
    momentum:     { trend: 15, momentum: 30, volume: 25, structure: 10, volatility: 10, riskQuality: 10 },
    scalping:     { trend: 5, momentum: 20, volume: 20, structure: 15, volatility: 25, riskQuality: 15 },
    swing:        { trend: 25, momentum: 15, volume: 10, structure: 25, volatility: 15, riskQuality: 10 },
    position:     { trend: 30, momentum: 10, volume: 10, structure: 20, volatility: 10, riskQuality: 20 }
  };

  function weightedScore(s, weights) {
    if (!weights || typeof weights.trend !== 'number') return null;
    const w = weights;
    const total = (w.trend + w.momentum + w.volume + w.structure + w.volatility + w.riskQuality) || 100;
    const v = (s.trend / 20) * (w.trend / total) + (s.momentum / 20) * (w.momentum / total) + (s.volume / 20) * (w.volume / total) +
      (s.structure / 20) * (w.structure / total) + (s.volatility / 10) * (w.volatility / total) + (s.riskQuality / 10) * (w.riskQuality / total);
    return Math.round(Math.min(100, Math.max(0, v * 100)));
  }

  function getWeights(stratId) {
    return (byId[stratId] && byId[stratId].weights) || DEFAULT_WEIGHTS[stratId];
  }

  // Trend following: 1D/4H trend
  strategies.trend_follow.score = s1d.trend * 1.5 + s4h.trend * 1.2;
  if (regime === 'trending') strategies.trend_follow.score += 20;
  const wTf = getWeights('trend_follow');
  strategies.trend_follow.displayScore = weightedScore(s1d, wTf) * 0.55 + weightedScore(s4h, wTf) * 0.45;

  // Breakout: 1H
  strategies.breakout.score = s1h.volatility * 2 + s1h.structure * 1.3;
  if (regime === 'compression') strategies.breakout.score += 25;
  strategies.breakout.displayScore = weightedScore(s1h, getWeights('breakout'));

  // Mean reversion: 1H
  strategies.mean_revert.score = s1h.momentum * 1.2 + s1h.structure * 1.0;
  if (regime === 'ranging') strategies.mean_revert.score += 20;
  strategies.mean_revert.displayScore = weightedScore(s1h, getWeights('mean_revert'));

  // Momentum: 1H
  strategies.momentum.score = s1h.momentum * 1.5 + s1h.volume * 1.3;
  if (regime === 'trending') strategies.momentum.score += 10;
  strategies.momentum.displayScore = weightedScore(s1h, getWeights('momentum'));

  // Scalping: primarily 15m when available, 1h fallback.
  // Apply short-timeframe noise penalty (15m is noisier, shouldn't inflate score).
  if (scores15m) {
    strategies.scalping.score = scores15m.volatility * 1.5 + scores15m.structure * 1.2 + s1h.momentum * 1.0;
    if (regime === 'volatile' || regime === 'compression') strategies.scalping.score += 15;
    const raw15m = weightedScore(scores15m, getWeights('scalping'));
    const raw1h = weightedScore(s1h, getWeights('scalping'));
    // Use 15m as primary (70%) with 1h confirmation (30%), then apply 0.92 noise discount
    strategies.scalping.displayScore = Math.round((raw15m * 0.7 + raw1h * 0.3) * 0.92);
  } else {
    // Without 15m data, scalping has less edge — discount vs strategies that use their native timeframe
    const raw = weightedScore(s1h, getWeights('scalping'));
    strategies.scalping.displayScore = Math.round(raw * 0.90);
  }

  // Swing: 4H + 1D
  strategies.swing.score = s4h.trend * 1.3 + s1d.trend * 1.2 + s4h.structure * 1.0;
  if (regime === 'trending' || regime === 'compression') strategies.swing.score += 15;
  strategies.swing.displayScore = weightedScore(s4h, getWeights('swing')) * 0.5 + weightedScore(s1d, getWeights('swing')) * 0.5;

  // Position: 1D + 1W
  if (scores1w) {
    strategies.position.score = s1d.trend * 1.2 + scores1w.trend * 1.5 + s1d.structure * 1.0;
    if (regime === 'trending') strategies.position.score += 15;
    strategies.position.displayScore = weightedScore(s1d, getWeights('position')) * 0.5 + weightedScore(scores1w, getWeights('position')) * 0.5;
  } else {
    strategies.position.displayScore = weightedScore(s1d, getWeights('position'));
  }

  // Normalize displayScore to 0-100
  Object.values(strategies).forEach(s => {
    if (s.displayScore != null && (s.displayScore < 0 || s.displayScore > 100)) s.displayScore = Math.max(0, Math.min(100, s.displayScore));
  });

  // Pick best: use displayScore (balanced 0-100) with small regime fit bonus
  // Old logic used inflated raw .score which always favored trend_follow
  const REGIME_FIT_BONUS = {
    trend_follow: { trending: 5 },
    breakout:     { compression: 5 },
    mean_revert:  { ranging: 5 },
    momentum:     { trending: 3, volatile: 2 },
    scalping:     { volatile: 2 },           // Only a small bonus in volatile (its niche)
    swing:        { trending: 3, compression: 3 },
    position:     { trending: 3 }
  };
  let best = null;
  const list = Object.values(strategies);
  const allowed = list.filter(s => {
    if (s.displayScore == null) return false;
    const blocked = (REGIME_STRATEGY_BLOCK[s.id] || []).indexOf(regime) >= 0;
    const minTrades = (strategyStats[s.id] || strategyStats[s.id + ''] || {}).totalTrades || 0;
    const underMin = minTrades < MIN_TRADES_FOR_STRATEGY;
    return !blocked && (!underMin || minTrades === 0);
  });
  const candidates = allowed.length > 0 ? allowed : list.filter(s => s.displayScore != null);
  for (const s of candidates) {
    const blocked = (REGIME_STRATEGY_BLOCK[s.id] || []).indexOf(regime) >= 0;
    if (blocked) continue;
    if (s.displayScore == null) continue;
    const bonus = (REGIME_FIT_BONUS[s.id] && REGIME_FIT_BONUS[s.id][regime]) || 0;
    const bestBonus = best ? ((REGIME_FIT_BONUS[best.id] && REGIME_FIT_BONUS[best.id][regime]) || 0) : 0;
    if (!best || (s.displayScore + bonus) > (best.displayScore + bestBonus)) best = s;
  }
  if (!best) best = strategies.trend_follow;

  return {
    best,
    allStrategies: Object.values(strategies)
  };
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
// TRADE LEVELS (dynamic ATR by regime + strategy, multi-TF S/R)
// Strategy-specific: scalping = tighter, position = wider
// ====================================================
const STRATEGY_LEVELS = {
  scalping:     { atrMult: 1.2, tp1R: 1,   tp2R: 1.5, tp3R: 2   },
  momentum:     { atrMult: 1.5, tp1R: 1.5, tp2R: 2.5, tp3R: 3   },
  breakout:     { atrMult: 1.5, tp1R: 1.5, tp2R: 2.5, tp3R: 3   },
  mean_revert:  { atrMult: 1.5, tp1R: 1.5, tp2R: 2.5, tp3R: 3   },
  trend_follow: { atrMult: 2,   tp1R: 1.5, tp2R: 2.5, tp3R: 4   },
  swing:        { atrMult: 2,   tp1R: 1.5, tp2R: 2.5, tp3R: 4   },
  position:     { atrMult: 2.5, tp1R: 2,   tp2R: 3,   tp3R: 5   }
};

function calculateTradeLevels(currentPrice, tf1h, tf4h, tf1d, signal, direction, regime, strategyType) {
  const atr = tf1h.atr || currentPrice * 0.02;
  const support1d = tf1d && tf1d.support > 0 ? tf1d.support : null;
  const resistance1d = tf1d && tf1d.resistance > 0 ? tf1d.resistance : null;
  const support4h = tf4h && tf4h.support > 0 ? tf4h.support : null;
  const resistance4h = tf4h && tf4h.resistance > 0 ? tf4h.resistance : null;
  const support = support1d || support4h || tf1h.support || currentPrice * 0.95;
  const resistance = resistance1d || resistance4h || tf1h.resistance || currentPrice * 1.05;

  let atrMult, tp1R, tp2R, tp3R;
  if (strategyType && STRATEGY_LEVELS[strategyType]) {
    const sl = STRATEGY_LEVELS[strategyType];
    atrMult = sl.atrMult;
    tp1R = sl.tp1R;
    tp2R = sl.tp2R;
    tp3R = sl.tp3R;
  } else {
    atrMult = 2;
    if (regime === 'trending') atrMult = 1.5;
    else if (regime === 'volatile' || regime === 'mixed') atrMult = 2.5;
    else if (regime === 'compression') atrMult = 2;
    tp1R = 1.5;
    tp2R = 2.5;
    tp3R = 4;
  }

  let entry, tp1, tp2, tp3, stopLoss;

  // Strategy-based TPs: scalping=1 TP, momentum/breakout/mean_revert=2, swing/position=3
  const tpCount = !strategyType ? 3
    : strategyType === 'scalping' ? 1
    : ['momentum', 'breakout', 'mean_revert'].includes(strategyType) ? 2
    : 3;

  if (signal === 'STRONG_BUY' || signal === 'BUY') {
    entry = r2(currentPrice);
    stopLoss = r2(Math.max(support * 0.995, entry - atr * atrMult));
    if (stopLoss >= entry) stopLoss = r2(entry - atr * (atrMult + 0.5));
    const risk = entry - stopLoss;
    tp1 = tpCount >= 1 ? r2(entry + risk * tp1R) : null;
    tp2 = tpCount >= 2 ? r2(entry + risk * tp2R) : null;
    tp3 = tpCount >= 3 ? r2(entry + risk * tp3R) : null;
  } else if (signal === 'STRONG_SELL' || signal === 'SELL') {
    entry = r2(currentPrice);
    stopLoss = r2(Math.min(resistance * 1.005, entry + atr * atrMult));
    if (stopLoss <= entry) stopLoss = r2(entry + atr * (atrMult + 0.5));
    const risk = stopLoss - entry;
    tp1 = tpCount >= 1 ? r2(entry - risk * tp1R) : null;
    tp2 = tpCount >= 2 ? r2(entry - risk * tp2R) : null;
    tp3 = tpCount >= 3 ? r2(entry - risk * tp3R) : null;
  } else {
    // HOLD / unknown direction: use direction hint to set levels
    entry = r2(currentPrice);
    if (direction === 'BEAR') {
      stopLoss = r2(resistance * 1.005);
      tp1 = tpCount >= 1 ? r2(support) : null;
      tp2 = tpCount >= 2 ? r2(support * 0.97) : null;
      tp3 = tpCount >= 3 ? r2(support * 0.94) : null;
    } else {
      stopLoss = r2(support * 0.995);
      tp1 = tpCount >= 1 ? r2(resistance) : null;
      tp2 = tpCount >= 2 ? r2(resistance * 1.03) : null;
      tp3 = tpCount >= 3 ? r2(resistance * 1.06) : null;
    }
  }

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs((tp2 || tp1) - entry);
  const riskReward = risk > 0 ? r2(reward / risk) : 0;

  return { entry, tp1, tp2, tp3, stopLoss, riskReward };
}

// Labels for UI: we use ATR with S/R bounds (fixed, not trailing); TP = R multiples
const STOP_TP_LABELS = { stopType: 'ATR_SR', stopLabel: 'ATR + S/R', tpType: 'R_multiple', tpLabel: 'R multiples' };

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
function buildReasoning(s1h, s4h, s1d, confluenceLevel, regime, strategy, signal, finalScore, inSession, tf1h, tf4h, tf1d) {
  const reasons = [];

  if (confluenceLevel === 3) reasons.push('All 3 timeframes agree - strong confluence');
  else if (confluenceLevel === 2) reasons.push('2/3 timeframes agree - moderate confluence');
  else reasons.push('Mixed timeframes - weak confluence, trade with caution');

  if (finalScore !== undefined && (finalScore < ENGINE_CONFIG.MIN_SIGNAL_SCORE || confluenceLevel < ENGINE_CONFIG.MIN_CONFLUENCE_FOR_SIGNAL))
    reasons.push(`Quality gate: score ${finalScore} or confluence ${confluenceLevel} below minimum – held to HOLD`);
  if (inSession === false) reasons.push('Outside peak session (12–22 UTC) – reduced weight');
  reasons.push(`Strategy: ${strategy.name} (best fit for ${regime} regime)`);
  reasons.push(`1H: ${s1h.label} (${s1h.total}/100) | 4H: ${s4h.label} (${s4h.total}/100) | 1D: ${s1d.label} (${s1d.total}/100)`);

  if (s1d.trend >= 12) reasons.push('Daily trend strong - aligned with higher timeframe');
  if (s1h.momentum >= 12) reasons.push('Momentum confirming on 1H');
  if (s4h.volume >= 12) reasons.push('Volume supporting on 4H');
  if (s1h.structure >= 12) reasons.push('Market structure favorable');

  // Divergence & top/bottom context
  const r1 = tf1h.rsiDivergence || {};
  const m1 = tf1h.macdDivergence || {};
  const o1 = tf1h.obvDivergence || {};
  const s1 = tf1h.stochDivergence || {};
  const bullDiv = r1.bullish || m1.bullish || o1.bullish || s1.bullish;
  const bearDiv = r1.bearish || m1.bearish || o1.bearish || s1.bearish;
  if (bullDiv) {
    const types = [r1.bullish && 'RSI', m1.bullish && 'MACD', o1.bullish && 'OBV', s1.bullish && 'Stoch'].filter(Boolean);
    reasons.push('Bullish divergence (' + types.join('/') + ') – potential bottom forming');
  }
  if (bearDiv) {
    const types = [r1.bearish && 'RSI', m1.bearish && 'MACD', o1.bearish && 'OBV', s1.bearish && 'Stoch'].filter(Boolean);
    reasons.push('Bearish divergence (' + types.join('/') + ') – potential top forming');
  }
  if (tf1h.potentialBottom) reasons.push('Potential bottom: divergence + oversold/support – caution on shorts');
  if (tf1h.potentialTop) reasons.push('Potential top: divergence + overbought/resistance – caution on longs');

  // Order blocks / FVG / liquidity clusters (price-action context)
  const tfs = [
    { name: '1H', a: tf1h },
    { name: '4H', a: tf4h },
    { name: '1D', a: tf1d }
  ].filter(x => x.a && (x.a.orderBlocks?.length || x.a.fvgs?.length || x.a.liquidityClusters));
  for (const { name, a } of tfs) {
    if (a.orderBlocks && a.orderBlocks.length > 0) {
      const bull = a.orderBlocks.filter(b => b.type === 'BULL').length;
      const bear = a.orderBlocks.filter(b => b.type === 'BEAR').length;
      if (bull > 0 || bear > 0) reasons.push(`${name}: Order blocks in scope (${bull} bull, ${bear} bear)`);
    }
    if (a.fvgs && a.fvgs.length > 0) {
      const bull = a.fvgs.filter(f => f.type === 'BULL').length;
      const bear = a.fvgs.filter(f => f.type === 'BEAR').length;
      if (bull > 0 || bear > 0) reasons.push(`${name}: FVG zones present (${bull} bull, ${bear} bear)`);
    }
    if (a.liquidityClusters && (a.liquidityClusters.above != null || a.liquidityClusters.below != null))
      reasons.push(`${name}: Liquidity clusters (above/below) in view`);
  }

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
function analyzeWithHistory(coinData, history, options) {
  options = options || {};
  const pricesArr = history && Array.isArray(history.prices) ? history.prices : [];
  const volumesArr = history && Array.isArray(history.volumes) ? history.volumes : [];
  const rawPrices = pricesArr.map(p => (p && typeof p.price !== 'undefined') ? p.price : 0);
  const rawVolumes = volumesArr.map(v => (v && typeof v.volume !== 'undefined') ? v.volume : 0);

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

  return analyzeWithCandles(coinData, candles, options);
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
    topStrategies: [{ id: 'basic', name: 'Basic 24H', score, signal }],
    regime: 'unknown', suggestedLeverage: 1,
    entry, takeProfit1: tp1, takeProfit2: tp2, takeProfit3: tp3, stopLoss: sl,
    riskReward: risk > 0 ? r2(reward / risk) : 0,
    reasoning: reasons,
    scoreBreakdown: { trend: 0, momentum: 0, volume: 0, structure: 0, volatility: 0, riskQuality: 0 },
    timeframes: {
      '1H': { signal: '24h only', score: 0, direction: 'NEUTRAL', rsi: '-', trend: '-', adx: '-' },
      '4H': { signal: '24h only', score: 0, direction: 'NEUTRAL', rsi: '-', trend: '-', adx: '-' },
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

module.exports = { analyzeCoin, analyzeAllCoins, ENGINE_CONFIG };
