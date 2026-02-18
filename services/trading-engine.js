// services/trading-engine.js
// ====================================================
// ADVANCED MULTI-STRATEGY TRADING ENGINE v5.0
//
// Uses Bitget/Kraken OHLCV candles across 15m, 1H, 4H, 1D, 1W.
// Scores signals 0-100 using 6 categories (learned weights optional).
// Min score/confluence gate, regime-strategy gating, BTC filter,
// MTF divergence, dynamic stops, multi-TF S/R, VWAP bands,
// order blocks, liquidity clusters, session filter.
// v5.0: Stricter regime detection, regime-aware scoring, improved thresholds.
// ====================================================
const { detectAllPatterns, scorePatterns } = require('./candlestick-patterns');
const { detectChartPatterns, scoreChartPatterns } = require('./chart-patterns');

// Config: quality gates and filters (quant-desk upgrades)
const ENGINE_CONFIG = {
  MIN_SIGNAL_SCORE: 52,         // Raised from 50 — reduces weak signals
  MIN_CONFLUENCE_FOR_SIGNAL: 2,
  MTF_DIVERGENCE_PENALTY: 10,
  SESSION_START_UTC: 12,        // Configurable session hours
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

  // Try Bitget candles first, fall back to CoinGecko history
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

  const fundingRates = options.fundingRates || {};
  const signals = allPrices.map(coinData => {
    const candles = allCandles[coinData.id] || null;
    const history = allHistory[coinData.id] || { prices: [], volumes: [] };
    const coinOptions = Object.assign({}, options, {
      fundingRate: fundingRates[coinData.id] || null
    });
    return analyzeCoin(coinData, candles, history, coinOptions);
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
function trendToHtfDir(trend) {
  if (trend === 'UP' || trend === 'STRONG_UP') return 'UP';
  if (trend === 'DOWN' || trend === 'STRONG_DOWN') return 'DOWN';
  return null;
}

function analyzeWithCandles(coinData, candles, options) {
  options = options || {};
  const currentPrice = coinData.price;
  const strategyWeights = options.strategyWeights || [];

  // Analyze each real timeframe (higher TF first so lower TF pattern scoring can use HTF trend context)
  const tf1d = analyzeOHLCV(candles['1d'], currentPrice);
  const tf4h = analyzeOHLCV(candles['4h'], currentPrice, { htfTrend: trendToHtfDir(tf1d.trend) });
  const tf1h = analyzeOHLCV(candles['1h'], currentPrice, { htfTrend: trendToHtfDir(tf4h.trend) });

  // Optional 15m and 1w for scalping / position strategies
  let scores15m = null;
  let scores1w = null;
  let tf15m = null;
  let tf1w = null;
  if (candles['15m'] && candles['15m'].length >= 20) {
    tf15m = analyzeOHLCV(candles['15m'], currentPrice, { htfTrend: trendToHtfDir(tf1h.trend) });
    scores15m = scoreCandles(tf15m, currentPrice, '15m');
  }
  if (candles['1w'] && candles['1w'].length >= 5) {
    tf1w = analyzeOHLCV(candles['1w'], currentPrice, { htfTrend: trendToHtfDir(tf1d.trend) });
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

  // Save pre-penalty score for penalty stacking floor
  const preModifierScore = finalScore;

  // MTF divergence penalty: 1H vs 4H direction disagree
  const directions = [scores1h.direction, scores4h.direction, scores1d.direction];
  const bullCount = directions.filter(d => d === 'BULL').length;
  const bearCount = directions.filter(d => d === 'BEAR').length;
  const confluenceLevel = Math.max(bullCount, bearCount);
  // Stricter tie-breaker: require 2/3 agreement; 1-1 uses 1D direction + score
  let dominantDir;
  if (bullCount >= 2 && bullCount > bearCount) dominantDir = 'BULL';
  else if (bearCount >= 2 && bearCount > bullCount) dominantDir = 'BEAR';
  else if (bullCount === bearCount) {
    // Tie: defer to daily direction first, then score
    if (scores1d.direction === 'BULL' && finalScore >= 52) dominantDir = 'BULL';
    else if (scores1d.direction === 'BEAR' && finalScore <= 48) dominantDir = 'BEAR';
    else if (finalScore >= 58 && (scores1d.direction === 'BULL' || scores1d.direction === 'BEAR')) dominantDir = scores1d.direction;
    else dominantDir = 'NEUTRAL';
  } else {
    dominantDir = bullCount > bearCount ? 'BULL' : bearCount > bullCount ? 'BEAR' : 'NEUTRAL';
  }
  if (scores1h.direction !== scores4h.direction && scores1h.direction !== 'NEUTRAL' && scores4h.direction !== 'NEUTRAL') {
    finalScore = Math.max(0, finalScore - ENGINE_CONFIG.MTF_DIVERGENCE_PENALTY);
  }

  // Session filter: outside 12–22 UTC reduce score slightly
  // In backtest, use the bar's timestamp (options.barTime) instead of current clock.
  const utcHour = options.barTime ? new Date(options.barTime).getUTCHours() : new Date().getUTCHours();
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

  // Funding rate modifier: extreme funding = contrarian signal
  const fundingData = options.fundingRate || null;
  if (fundingData && fundingData.rate != null) {
    const fr = fundingData.rate;
    // Positive funding > 0.05% = overleveraged longs (bearish contrarian)
    // Negative funding < -0.05% = overleveraged shorts (bullish contrarian)
    if (fr > 0.001) {  // >0.1% = extreme positive
      if (dominantDir === 'BULL') finalScore = Math.max(0, finalScore - 8);
      else if (dominantDir === 'BEAR') finalScore = Math.min(100, finalScore + 5);
    } else if (fr > 0.0005) {  // >0.05%
      if (dominantDir === 'BULL') finalScore = Math.max(0, finalScore - 4);
      else if (dominantDir === 'BEAR') finalScore = Math.min(100, finalScore + 3);
    } else if (fr < -0.001) {  // <-0.1% extreme negative
      if (dominantDir === 'BEAR') finalScore = Math.max(0, finalScore - 8);
      else if (dominantDir === 'BULL') finalScore = Math.min(100, finalScore + 5);
    } else if (fr < -0.0005) {  // <-0.05%
      if (dominantDir === 'BEAR') finalScore = Math.max(0, finalScore - 4);
      else if (dominantDir === 'BULL') finalScore = Math.min(100, finalScore + 3);
    }
  }

  // BTC correlation modifier: alts correlated with BTC should respect BTC direction
  const btcCandles = options.btcCandles || null;
  let btcCorrelation = null;
  if (btcCandles && candles['1h'] && coinData.id !== 'bitcoin') {
    btcCorrelation = calculateCorrelation(candles['1h'], btcCandles);
    // If correlation > 0.7 and BTC direction disagrees with signal, penalize
    if (btcCorrelation > 0.7 && options.btcDirection) {
      const btcAgrees = (options.btcDirection === 'BULL' && dominantDir === 'BULL') ||
                         (options.btcDirection === 'BEAR' && dominantDir === 'BEAR');
      if (!btcAgrees) {
        finalScore = Math.max(0, finalScore - Math.round(btcCorrelation * 8));
      }
    }
  }

  // Volume Profile / POC: adds confluence when price near high-volume node
  const poc = calculatePOC(candles['1h'] || []);
  if (poc > 0) {
    const distFromPOC = Math.abs(currentPrice - poc) / poc;
    if (distFromPOC < 0.005) {  // within 0.5% of POC = strong level
      finalScore = Math.min(100, finalScore + 3);
    }
  }

  // Penalty stacking floor: independent penalties (MTF -10, session -5, BTC -8,
  // potential top -12, funding -8) can stack to -43, killing viable signals.
  // Cap total penalty reduction to -25 so a score-70 signal can't drop below 45.
  const MAX_TOTAL_PENALTY = 25;
  if (finalScore < preModifierScore - MAX_TOTAL_PENALTY) {
    finalScore = preModifierScore - MAX_TOTAL_PENALTY;
  }

  // Final score clamp: ensure score stays within 0-100 after all modifiers
  finalScore = Math.max(0, Math.min(100, finalScore));

  // Fibonacci retracement levels (used in trade levels calculation too)
  const fibLevels = calculateFibonacci(tf4h.highs || [], tf4h.lows || []);

  // Detect market regime (adaptive per-coin volatility)
  const regime = detectRegime(tf1d, tf4h);

  // Best strategy + all strategies (with regime gating and optional learned weights)
  const strategyStats = options.strategyStats || {};
  const { best: bestStrategy, allStrategies: allStrategiesWithScores } = pickStrategy(
    scores1h, scores4h, scores1d, regime, scores15m, scores1w, strategyWeights, strategyStats
  );

  // Determine signal from score (with min score/confluence gate)
  let { signal, strength } = scoreToSignal(finalScore, confluenceLevel, dominantDir);
  // Relax confluence for high scores: 58+ needs only 1 TF; 52–57 needs 2 TF
  const minConfluence = finalScore >= 58 ? 1 : ENGINE_CONFIG.MIN_CONFLUENCE_FOR_SIGNAL;
  if (finalScore < ENGINE_CONFIG.MIN_SIGNAL_SCORE || confluenceLevel < minConfluence) {
    if (signal !== 'HOLD') {
      signal = 'HOLD';
      strength = finalScore;
    }
  }

  // Quality filters (optional, from options.feature*)
  if (signal !== 'HOLD') {
    const reqPriceAction = options.featurePriceActionConfluence === true;
    const reqVolFilter = options.featureVolatilityFilter === true;
    const reqVolume = options.featureVolumeConfirmation === true;
    if (reqPriceAction) {
      const hasOB = (tf1h.orderBlocks?.length || tf4h.orderBlocks?.length || 0) > 0;
      const hasFVG = (tf1h.fvgs?.length || tf4h.fvgs?.length || 0) > 0;
      const hasLiq = (tf1h.liquidityClusters && (tf1h.liquidityClusters.above != null || tf1h.liquidityClusters.below != null)) ||
        (tf4h.liquidityClusters && (tf4h.liquidityClusters.above != null || tf4h.liquidityClusters.below != null));
      if (!hasOB && !hasFVG && !hasLiq) { signal = 'HOLD'; strength = finalScore; }
    }
    if (reqVolFilter && (tf1h.volatilityState === 'extreme' || tf4h.volatilityState === 'extreme')) {
      signal = 'HOLD'; strength = finalScore;
    }
    if (reqVolume && (tf1h.relativeVolume || 0) < 1.0) {
      signal = 'HOLD'; strength = finalScore;
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

  // Build reasoning (include session, MTF divergence, quality gate, new features)
  const reasoning = buildReasoning(scores1h, scores4h, scores1d, confluenceLevel, regime, bestStrategy, signal, finalScore, inSession, tf1h, tf4h, tf1d, {
    btcCorrelation, poc, fibLevels, fundingRate: fundingData ? fundingData.rate : null
  });

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
      regime,
      btcCorrelation: btcCorrelation != null ? r2(btcCorrelation) : null,
      poc: poc > 0 ? r2(poc) : null,
      fundingRate: fundingData ? fundingData.rate : null,
      fibLevels,
      candlestickPatterns: {
        '1H': tf1h.candlestickPatterns || {},
        '4H': tf4h.candlestickPatterns || {},
        '1D': tf1d.candlestickPatterns || {}
      },
      chartPatterns: {
        '1H': tf1h.chartPatterns || {},
        '4H': tf4h.chartPatterns || {},
        '1D': tf1d.chartPatterns || {}
      }
    },
    timestamp: new Date().toISOString()
  };
}

// ====================================================
// OHLCV ANALYSIS - the real deal with proper candles
// ====================================================
function analyzeOHLCV(candles, currentPrice, options) {
  options = options || {};
  if (!candles || candles.length < 5) {
    return defaultAnalysis(currentPrice);
  }

  // Filter out invalid candles (NaN, zero, negative, impossible OHLC)
  const validCandles = candles.filter(c =>
    Number.isFinite(c.open) && c.open > 0 &&
    Number.isFinite(c.high) && c.high > 0 &&
    Number.isFinite(c.low) && c.low > 0 &&
    Number.isFinite(c.close) && c.close > 0 &&
    c.high >= c.low
  );
  if (validCandles.length < 5) {
    return defaultAnalysis(currentPrice);
  }

  const closes = validCandles.map(c => c.close);
  const highs = validCandles.map(c => c.high);
  const lows = validCandles.map(c => c.low);
  const volumes = validCandles.map(c => c.volume);
  const opens = validCandles.map(c => c.open);

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
  const vwap = calculateVWAP(validCandles);

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

  // Volatility state (adaptive per-coin: compares to own history)
  const volatilityState = classifyVolatility(atr, closes, highs, lows);

  // Momentum acceleration: is momentum speeding up or slowing down?
  // MACD histogram slope (last 3 bars) — positive = momentum accelerating bullish
  let macdHistSlope = 0;
  if (macdHistHistory && macdHistHistory.length >= 3) {
    const last3 = macdHistHistory.slice(-3);
    macdHistSlope = (last3[2] - last3[0]) / 2;
  }
  // RSI rate of change (last 5 bars)
  let rsiROC = 0;
  if (rsiHistory && rsiHistory.length >= 5) {
    const last5 = rsiHistory.slice(-5);
    rsiROC = last5[4] - last5[0];
  }

  // Candlestick pattern detection (v4.1)
  const candlestickPatterns = detectAllPatterns(validCandles);

  // Build context for pattern scoring
  const srRange = sr.resistance - sr.support;
  const posInSR = srRange > 0 ? (currentPrice - sr.support) / srRange : 0.5;
  const nearSupport = posInSR < 0.25;
  const nearResistance = posInSR > 0.75;

  // Check if near a bull/bear order block
  let nearBullOB = false, nearBearOB = false;
  for (const ob of (orderBlocks || [])) {
    const mid = (ob.top + ob.bottom) / 2;
    const dist = mid > 0 ? Math.abs(currentPrice - mid) / mid : 1;
    if (dist < 0.01) {
      if (ob.type === 'BULL') nearBullOB = true;
      if (ob.type === 'BEAR') nearBearOB = true;
    }
  }

  const patternContext = {
    nearSupport,
    nearResistance,
    rsiDivBullish: rsiDiv && rsiDiv.bullish,
    rsiDivBearish: rsiDiv && rsiDiv.bearish,
    rsiOversold: rsi < 30,
    rsiOverbought: rsi > 70,
    volumeConfirm: volumeAnalysis.relativeVolume > 1.5,
    bbSqueeze,
    nearBullOB,
    nearBearOB,
    htfTrend: options.htfTrend || null
  };

  const patternScore = scorePatterns(candlestickPatterns, patternContext);

  // Chart pattern detection (v4.2) — geometric formations (flags, wedges, triangles, H&S, etc.)
  const chartPatterns = detectChartPatterns(validCandles);
  const chartPatternContext = {
    trendUp: trend === 'UP' || trend === 'STRONG_UP',
    trendDown: trend === 'DOWN' || trend === 'STRONG_DOWN',
    volumeHigh: volumeAnalysis.relativeVolume > 1.5
  };
  const chartPatternScore = scoreChartPatterns(chartPatterns, chartPatternContext);

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
    macdHistSlope,
    rsiROC,
    candlestickPatterns: patternScore,
    chartPatterns: chartPatternScore,
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
  // RSI — extreme levels + directional bias
  if (analysis.rsi < 20) { momentum += 7; bullPoints += 2; }  // deeply oversold = strong reversal signal
  else if (analysis.rsi < 30) { momentum += 5; bullPoints += 2; }
  else if (analysis.rsi < 40) { momentum += 3; bullPoints += 1; }
  else if (analysis.rsi > 80) { momentum += 7; bearPoints += 2; }  // deeply overbought
  else if (analysis.rsi > 70) { momentum += 5; bearPoints += 2; }
  else if (analysis.rsi > 60) { momentum += 3; bearPoints += 1; }
  else { momentum += 1; }  // 40-60 = dead zone, minimal score

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

  // Stochastic crossover — directional momentum confirmation
  if (analysis.stochK > analysis.stochD && analysis.stochK < 40) {
    momentum += 3; bullPoints += 1;
  } else if (analysis.stochK < analysis.stochD && analysis.stochK > 60) {
    momentum += 3; bearPoints += 1;
  }

  // Momentum acceleration — MACD histogram slope (is momentum speeding up?)
  if (analysis.macdHistSlope > 0 && analysis.macdHistogram > 0) {
    momentum += 2; bullPoints += 1;  // bullish momentum accelerating
  } else if (analysis.macdHistSlope < 0 && analysis.macdHistogram < 0) {
    momentum += 2; bearPoints += 1;  // bearish momentum accelerating
  }
  // Decelerating momentum = early warning (no points, but no penalty either)

  // Candlestick pattern momentum confirmation (v4.1)
  const cpMom = analysis.candlestickPatterns || {};
  if (cpMom.momentumBonus) {
    momentum += Math.min(cpMom.momentumBonus, 3);
  }

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

  // Candlestick pattern bonus (v4.1)
  // Patterns boost structure (up to +5) and momentum (up to +3)
  // Direction points (bullPoints/bearPoints) feed into LONG vs SHORT decision
  const cpScore = analysis.candlestickPatterns || {};
  if (cpScore.structureBonus) {
    structure += Math.min(cpScore.structureBonus, 5);
  }
  if (cpScore.bullPoints) bullPoints += cpScore.bullPoints;
  if (cpScore.bearPoints) bearPoints += cpScore.bearPoints;

  // Chart pattern bonus (v4.2) — geometric formations (flags, wedges, H&S, etc.)
  // These are larger multi-candle structural formations with high reliability
  const geoScore = analysis.chartPatterns || {};
  if (geoScore.structureBonus) {
    structure += Math.min(geoScore.structureBonus, 6);
  }
  if (geoScore.bullPoints) bullPoints += geoScore.bullPoints;
  if (geoScore.bearPoints) bearPoints += geoScore.bearPoints;

  structure = Math.min(20, structure);

  // === VOLATILITY (0-10) ===
  // BB squeeze = pending move = high quality setup
  if (analysis.bbSqueeze) { volatility += 5; }
  // Low/normal vol = predictable, good for entries. High/extreme = risky, penalize
  if (analysis.volatilityState === 'low') { volatility += 3; }
  else if (analysis.volatilityState === 'normal') { volatility += 3; }
  else if (analysis.volatilityState === 'high') { volatility += 1; }  // high vol = risky
  else { volatility += 0; }  // extreme = dangerous

  // Strong trend + manageable vol = good setup
  if (analysis.adx > 25 && analysis.volatilityState !== 'extreme' && analysis.volatilityState !== 'high') { volatility += 2; }

  volatility = Math.min(10, volatility);

  // === RISK QUALITY (0-10) ===
  // Clear S/R = defined risk. Tight range = better R:R
  if (analysis.support > 0 && analysis.resistance > analysis.support) {
    const srPct = (analysis.resistance - analysis.support) / analysis.support * 100;
    if (srPct > 0 && srPct < 5) riskQuality += 4;     // tight range = precise levels
    else if (srPct < 10) riskQuality += 3;             // reasonable range
    else riskQuality += 2;                              // wide range = less precise
  }
  // ATR present = can size stops properly
  if (analysis.atr > 0) { riskQuality += 1; }
  // Clear trend (ADX) = more predictable movement
  if (analysis.adx > 30) { riskQuality += 2; }
  else if (analysis.adx > 20) { riskQuality += 1; }
  // Enough data for reliable indicators
  if (analysis.closes && analysis.closes.length >= 100) { riskQuality += 3; }
  else if (analysis.closes && analysis.closes.length >= 50) { riskQuality += 2; }
  else if (analysis.closes && analysis.closes.length >= 20) { riskQuality += 1; }

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
    else if (adjScore >= 48) { signal = 'BUY'; strength = adjScore; }  // mild bullish lean (was 45)
    else { signal = 'HOLD'; strength = adjScore; }
  } else if (dominantDir === 'BEAR') {
    if (adjScore >= 75) { signal = 'STRONG_SELL'; strength = Math.min(98, adjScore); }
    else if (adjScore >= 55) { signal = 'SELL'; strength = adjScore; }
    else if (adjScore >= 48) { signal = 'SELL'; strength = adjScore; }  // mild bearish lean (was 45)
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
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100; // Zero movement = neutral, not overbought
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

/**
 * Support/Resistance with role reversal.
 * When price breaks above resistance → that level becomes support, new resistance above.
 * When price breaks below support → that level becomes resistance, new support below.
 * Returns { support, resistance } for chart drawing. Redraws on each timeframe switch.
 */
function findSRWithRoleReversal(highs, lows, closes) {
  if (!highs?.length || !lows?.length || !closes?.length) return { support: 0, resistance: 0 };
  const lookback = Math.min(80, highs.length);
  const recentH = highs.slice(-lookback);
  const recentL = lows.slice(-lookback);
  const currentPrice = closes[closes.length - 1];

  const swingLows = [];
  const swingHighs = [];
  for (let i = 2; i < recentH.length - 2; i++) {
    if (recentL[i] < recentL[i-1] && recentL[i] < recentL[i+1]) swingLows.push(recentL[i]);
    if (recentH[i] > recentH[i-1] && recentH[i] > recentH[i+1]) swingHighs.push(recentH[i]);
  }

  const lastSwingLow = swingLows.length > 0 ? swingLows[swingLows.length - 1] : Math.min(...recentL);
  const lastSwingHigh = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1] : Math.max(...recentH);

  // Breakout above resistance: old resistance becomes support, find new resistance above
  if (currentPrice > lastSwingHigh) {
    const above = swingHighs.filter(h => h > currentPrice);
    const newResistance = above.length > 0 ? Math.min(...above) : currentPrice * 1.02; // fallback: 2% above price
    return { support: lastSwingHigh, resistance: newResistance };
  }

  // Breakdown below support: old support becomes resistance, find new support below
  if (currentPrice < lastSwingLow) {
    const below = swingLows.filter(l => l < currentPrice);
    const newSupport = below.length > 0 ? Math.max(...below) : currentPrice * 0.98; // fallback: 2% below price
    return { support: newSupport, resistance: lastSwingLow };
  }

  // Price in range: standard S/R
  return { support: lastSwingLow, resistance: lastSwingHigh };
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

  // Aligned with regime detection: ADX 30+ = strong trend, 25-30 = moderate
  if (adx >= 30) {
    if (bull >= 5) return 'STRONG_UP';
    if (bull >= 4) return 'UP';
    if (bull <= 1) return 'STRONG_DOWN';
    if (bull <= 2) return 'DOWN';
  }
  if (adx >= 25) {
    if (bull >= 5) return 'UP';
    if (bull <= 1) return 'DOWN';
  }

  if (bull >= 5) return 'UP';
  if (bull <= 1) return 'DOWN';
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
// VOLATILITY STATE — adaptive per-coin (z-score based)
// Instead of fixed ATR% thresholds (which make all altcoins "volatile"),
// we compare each coin's CURRENT ATR to its own rolling history.
// A coin that normally has 5% ATR will classify 5% as "normal", not "high".
//
// OPTIMIZED: No array allocations in inner loop, capped lookback window
// so backtesting (which calls this thousands of times) stays fast.
// ====================================================
const VOL_LOOKBACK = 100; // Only look at last 100 ATR readings for stats

function classifyVolatility(atr, closes, highs, lows) {
  if (closes.length < 30) return 'normal'; // Need 14 for ATR + at least 16 more for stats

  const n = closes.length;
  // How far back to compute ATR history: cap at VOL_LOOKBACK data points
  // Each data point starts at index 14, so we need startIdx >= 14
  const startIdx = Math.max(14, n - VOL_LOOKBACK);

  // Build ATR% history in-place (no array slicing)
  const atrHistory = [];
  for (let i = startIdx; i < n; i++) {
    // Compute 14-period ATR inline (avoids slice + function call overhead)
    let trSum = 0;
    for (let j = i - 13; j <= i; j++) {
      const tr = Math.max(
        highs[j] - lows[j],
        Math.abs(highs[j] - closes[j - 1]),
        Math.abs(lows[j] - closes[j - 1])
      );
      trSum += tr;
    }
    const pointATR = trSum / 14;
    const price = closes[i];
    if (price > 0) atrHistory.push((pointATR / price) * 100);
  }

  if (atrHistory.length < 20) {
    // Fall back to wider fixed thresholds if not enough history
    const price = closes[n - 1];
    const atrPct = (atr / price) * 100;
    if (atrPct > 8) return 'extreme';
    if (atrPct > 5) return 'high';
    if (atrPct > 1) return 'normal';
    return 'low';
  }

  // Mean and standard deviation (single pass)
  let sum = 0, sumSq = 0;
  for (let i = 0; i < atrHistory.length; i++) {
    sum += atrHistory[i];
    sumSq += atrHistory[i] * atrHistory[i];
  }
  const mean = sum / atrHistory.length;
  const stdDev = Math.sqrt(sumSq / atrHistory.length - mean * mean);

  // Current ATR as percentage of price
  const currentAtrPct = (atr / closes[n - 1]) * 100;

  // Z-score: how many standard deviations above this coin's own average
  const zScore = stdDev > 0 ? (currentAtrPct - mean) / stdDev : 0;

  // Percentile rank (what % of historical readings are below current)
  let below = 0;
  for (let i = 0; i < atrHistory.length; i++) {
    if (atrHistory[i] < currentAtrPct) below++;
  }
  const percentile = below / atrHistory.length;

  // Classify using BOTH z-score and percentile for robustness
  // extreme: z > 2.0 AND above 95th percentile (truly unusual for THIS coin)
  // high:    z > 1.2 AND above 80th percentile (elevated for THIS coin)
  // low:     z < -1.0 AND below 20th percentile (unusually calm for THIS coin)
  // normal:  everything else (typical behavior for THIS coin)
  if (zScore > 2.0 && percentile > 0.95) return 'extreme';
  if (zScore > 1.2 && percentile > 0.80) return 'high';
  if (zScore < -1.0 && percentile < 0.20) return 'low';
  return 'normal';
}

// ====================================================
// BTC CORRELATION - Pearson correlation of close returns
// ====================================================
function calculateCorrelation(coinCandles, btcCandles) {
  if (!coinCandles || !btcCandles || coinCandles.length < 20 || btcCandles.length < 20) return null;
  // Match by time, calculate returns
  const btcMap = {};
  btcCandles.forEach(c => { btcMap[c.openTime] = c.close; });
  const matched = [];
  for (let i = 1; i < coinCandles.length; i++) {
    const t = coinCandles[i].openTime;
    const tPrev = coinCandles[i - 1].openTime;
    if (btcMap[t] && btcMap[tPrev] && coinCandles[i - 1].close > 0 && btcMap[tPrev] > 0) {
      matched.push({
        coinRet: (coinCandles[i].close - coinCandles[i - 1].close) / coinCandles[i - 1].close,
        btcRet: (btcMap[t] - btcMap[tPrev]) / btcMap[tPrev]
      });
    }
  }
  if (matched.length < 10) return null;
  const n = matched.length;
  const meanCoin = matched.reduce((s, m) => s + m.coinRet, 0) / n;
  const meanBtc = matched.reduce((s, m) => s + m.btcRet, 0) / n;
  let num = 0, denCoin = 0, denBtc = 0;
  for (const m of matched) {
    const dc = m.coinRet - meanCoin;
    const db = m.btcRet - meanBtc;
    num += dc * db;
    denCoin += dc * dc;
    denBtc += db * db;
  }
  const den = Math.sqrt(denCoin * denBtc);
  const raw = den > 0 ? num / den : 0;
  return Math.max(-1, Math.min(1, raw)); // Clamp to [-1, 1] for floating point safety
}

// ====================================================
// VOLUME PROFILE / POINT OF CONTROL (POC)
// POC = price level with highest volume traded — strong S/R
// ====================================================
function calculatePOC(candles) {
  if (!candles || candles.length < 10) return 0;
  // Bucket prices by volume
  const allPrices = [];
  let minP = Infinity, maxP = -Infinity;
  for (const c of candles) {
    if (c.high > maxP) maxP = c.high;
    if (c.low < minP) minP = c.low;
  }
  if (maxP <= minP || minP <= 0) return 0;
  const range = maxP - minP;
  const bucketSize = range / 50;  // 50 price buckets
  const buckets = new Array(50).fill(0);
  for (const c of candles) {
    const mid = (c.high + c.low) / 2;
    const idx = Math.min(49, Math.floor((mid - minP) / bucketSize));
    buckets[idx] += c.volume || 0;
  }
  let maxVol = 0, maxIdx = 0;
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i] > maxVol) { maxVol = buckets[i]; maxIdx = i; }
  }
  return minP + (maxIdx + 0.5) * bucketSize;
}

// ====================================================
// FIBONACCI RETRACEMENT LEVELS
// Uses swing high/low from recent candles to calculate key fib levels
// ====================================================
function calculateFibonacci(highs, lows) {
  if (!highs || !lows || highs.length < 10 || lows.length < 10) {
    return { fib236: 0, fib382: 0, fib500: 0, fib618: 0, fib786: 0, swingHigh: 0, swingLow: 0 };
  }
  // Use last 50 candles for swing detection
  const lookback = Math.min(50, highs.length);
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  const swingHigh = Math.max(...recentHighs);
  const swingLow = Math.min(...recentLows);
  const range = swingHigh - swingLow;
  if (range <= 0) {
    return { fib236: 0, fib382: 0, fib500: 0, fib618: 0, fib786: 0, swingHigh, swingLow };
  }
  return {
    fib236: swingHigh - range * 0.236,
    fib382: swingHigh - range * 0.382,
    fib500: swingHigh - range * 0.5,
    fib618: swingHigh - range * 0.618,
    fib786: swingHigh - range * 0.786,
    swingHigh,
    swingLow
  };
}

// ====================================================
// REGIME DETECTION (use both 1D and 4H so we don't default everything to ranging)
// Stricter thresholds: check compression/volatile first; higher ADX bar for trending.
// ====================================================
function detectRegime(tf1d, tf4h) {
  const adx1d = tf1d.adx || 0;
  const adx4h = tf4h.adx || 0;
  const adx = Math.max(adx1d, adx4h);
  const bbSqueeze = tf4h.bbSqueeze;
  const trend = tf1d.trend;
  // Use 4H volatilityState: 1D only has ~30 candles → <20 ATR history → fallback to fixed thresholds
  // that classify most crypto as "high/extreme" → always "volatile". 4H has 100 candles → adaptive.
  const vol = tf4h.volatilityState || tf1d.volatilityState;

  // Check compression and volatile first (more specific conditions)
  if (bbSqueeze) return 'compression';
  if (vol === 'extreme' || vol === 'high') return 'volatile';

  // Trending: ADX 30+ for crypto (was 25); ADX 25-30 only if STRONG trend
  if (adx >= 30 && (trend === 'STRONG_UP' || trend === 'STRONG_DOWN' || trend === 'UP' || trend === 'DOWN')) return 'trending';
  if (adx >= 25 && adx < 30 && (trend === 'STRONG_UP' || trend === 'STRONG_DOWN')) return 'trending';

  // Widen ranging: ADX < 20 instead of 15
  if (adx > 0 && adx < 20) return 'ranging';

  return 'mixed';
}

// Regime–strategy gating: hard block for worst mismatches, soft penalty for borderline
const REGIME_STRATEGY_BLOCK = {
  mean_revert: ['trending'],                  // MR hard-blocked only in trending (not compression)
  trend_follow: ['volatile'],                 // TF hard-blocked only in volatile
  breakout: ['trending'],                     // Breakout needs consolidation
  position: ['volatile']                      // Position can't handle wild vol
};
// Soft penalty: reduce score instead of hard block for borderline matches
const REGIME_STRATEGY_PENALTY = {
  mean_revert: { compression: -10 },
  trend_follow: { ranging: -15 },
  momentum: { ranging: -10 },
  scalping: { trending: -8, ranging: -8 },
  swing: { volatile: -12 },
  position: { compression: -10 }
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

  // Apply soft regime penalties to displayScore (before normalization)
  Object.values(strategies).forEach(s => {
    const penalty = (REGIME_STRATEGY_PENALTY[s.id] && REGIME_STRATEGY_PENALTY[s.id][regime]) || 0;
    if (penalty && s.displayScore != null) {
      s.displayScore = Math.max(0, s.displayScore + penalty);
    }
  });

  // Normalize displayScore to 0-100
  Object.values(strategies).forEach(s => {
    if (s.displayScore != null && (s.displayScore < 0 || s.displayScore > 100)) s.displayScore = Math.max(0, Math.min(100, s.displayScore));
  });

  // Pick best: use displayScore (balanced 0-100) with regime fit bonus
  const REGIME_FIT_BONUS = {
    trend_follow: { trending: 8 },
    breakout:     { compression: 8 },
    mean_revert:  { ranging: 8 },
    momentum:     { trending: 5, volatile: 3 },
    scalping:     { volatile: 5, compression: 4 },
    swing:        { trending: 5, compression: 5 },
    position:     { trending: 5 }
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
// Unified leverage suggestion (same thresholds as paper-trading.js)
function suggestLeverage(score, regime, volatilityState) {
  let maxLev = 1;
  if (score >= 85) maxLev = 10;
  else if (score >= 75) maxLev = 7;
  else if (score >= 65) maxLev = 5;
  else if (score >= 55) maxLev = 3;
  else if (score >= 45) maxLev = 2;
  else maxLev = 1;

  if (regime === 'ranging' || regime === 'mixed') maxLev = Math.max(1, Math.floor(maxLev * 0.6));
  if (regime === 'volatile') maxLev = Math.max(1, Math.floor(maxLev * 0.5));
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

  // Fibonacci levels for additional S/R confluence
  const fib = calculateFibonacci(tf4h.highs || [], tf4h.lows || []);
  // Use fibonacci as support/resistance when close to price (within 2% and closer than ATR-based S/R)
  let fibSupport = null, fibResist = null;
  if (fib.fib618 > 0 && fib.fib618 < currentPrice && currentPrice - fib.fib618 < atr * 3) {
    fibSupport = fib.fib618;  // 0.618 is the golden ratio level — strongest fib
  } else if (fib.fib500 > 0 && fib.fib500 < currentPrice && currentPrice - fib.fib500 < atr * 3) {
    fibSupport = fib.fib500;
  }
  if (fib.fib382 > 0 && fib.fib382 > currentPrice && fib.fib382 - currentPrice < atr * 3) {
    fibResist = fib.fib382;
  } else if (fib.fib236 > 0 && fib.fib236 > currentPrice && fib.fib236 - currentPrice < atr * 3) {
    fibResist = fib.fib236;
  }

  // Volume Profile POC for additional confluence
  const poc = calculatePOC(tf4h.closes ? tf4h.closes.map((c, i) => ({
    high: (tf4h.highs || [])[i] || c, low: (tf4h.lows || [])[i] || c,
    close: c, volume: (tf4h.volumes || [])[i] || 0
  })) : []);

  const support = support1d || support4h || tf1h.support || fibSupport || currentPrice * 0.95;
  const resistance = resistance1d || resistance4h || tf1h.resistance || fibResist || currentPrice * 1.05;

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
    // Minimum stop distance floor: prevent noise-level stops from S/R proximity
    const minStopDist = atr * Math.max(0.5, atrMult * 0.3);
    if (entry - stopLoss < minStopDist) stopLoss = r2(entry - minStopDist);
  } else if (signal === 'STRONG_SELL' || signal === 'SELL') {
    entry = r2(currentPrice);
    stopLoss = r2(Math.min(resistance * 1.005, entry + atr * atrMult));
    if (stopLoss <= entry) stopLoss = r2(entry + atr * (atrMult + 0.5));
    // Minimum stop distance floor
    const minStopDist = atr * Math.max(0.5, atrMult * 0.3);
    if (stopLoss - entry < minStopDist) stopLoss = r2(entry + minStopDist);
  } else {
    // HOLD / unknown direction: use direction hint to set levels with R-multiples
    entry = r2(currentPrice);
    if (direction === 'BEAR') {
      stopLoss = r2(resistance * 1.005);
      // Guard: ensure SL is above entry for SHORT-direction
      if (stopLoss <= entry) stopLoss = r2(entry + atr * 2);
    } else {
      stopLoss = r2(support * 0.995);
      // Guard: ensure SL is below entry for LONG-direction
      if (stopLoss >= entry) stopLoss = r2(entry - atr * 2);
    }
  }

  // Fibonacci stop refinement: if a strong fib level (0.618, 0.786) sits between entry and stop, use it
  // Guard: respect strategy minimum stop distance (don't tighten below atrMult * 0.4)
  const minFibStopDist = atr * Math.max(0.5, atrMult * 0.4);
  if (entry && stopLoss) {
    const fibLevelsArr = [fib.fib618, fib.fib786, fib.fib500].filter(f => f > 0);
    if (signal === 'STRONG_BUY' || signal === 'BUY') {
      for (const fl of fibLevelsArr) {
        if (fl < entry && fl > stopLoss && (entry - fl) > minFibStopDist) {
          stopLoss = r2(fl - atr * 0.2);
          break;
        }
      }
    } else if (signal === 'STRONG_SELL' || signal === 'SELL') {
      for (const fl of fibLevelsArr) {
        if (fl > entry && fl < stopLoss && (fl - entry) > minFibStopDist) {
          stopLoss = r2(fl + atr * 0.2);
          break;
        }
      }
    }
  }

  // Calculate TPs AFTER Fibonacci refinement so R-multiples use the final stop distance
  if (signal === 'STRONG_BUY' || signal === 'BUY') {
    const risk = entry - stopLoss;
    tp1 = tpCount >= 1 ? r2(entry + risk * tp1R) : null;
    tp2 = tpCount >= 2 ? r2(entry + risk * tp2R) : null;
    tp3 = tpCount >= 3 ? r2(entry + risk * tp3R) : null;
  } else if (signal === 'STRONG_SELL' || signal === 'SELL') {
    const risk = stopLoss - entry;
    tp1 = tpCount >= 1 ? r2(entry - risk * tp1R) : null;
    tp2 = tpCount >= 2 ? r2(entry - risk * tp2R) : null;
    tp3 = tpCount >= 3 ? r2(entry - risk * tp3R) : null;
  } else {
    // HOLD path: use R-multiples from final stop (consistent with BUY/SELL paths)
    if (direction === 'BEAR') {
      const risk = stopLoss - entry;
      tp1 = tpCount >= 1 ? r2(entry - risk * tp1R) : null;
      tp2 = tpCount >= 2 ? r2(entry - risk * tp2R) : null;
      tp3 = tpCount >= 3 ? r2(entry - risk * tp3R) : null;
    } else {
      const risk = entry - stopLoss;
      tp1 = tpCount >= 1 ? r2(entry + risk * tp1R) : null;
      tp2 = tpCount >= 2 ? r2(entry + risk * tp2R) : null;
      tp3 = tpCount >= 3 ? r2(entry + risk * tp3R) : null;
    }
  }

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs((tp2 || tp1) - entry);
  const riskReward = risk > 0 ? r2(reward / risk) : 0;

  return { entry, tp1, tp2, tp3, stopLoss, riskReward, fibLevels: fib, poc: poc > 0 ? r2(poc) : null };
}

// Labels for UI: we use ATR with S/R bounds (fixed, not trailing); TP = R multiples + Fib
const STOP_TP_LABELS = { stopType: 'ATR_SR_FIB', stopLabel: 'ATR + S/R + Fib', tpType: 'R_multiple', tpLabel: 'R multiples' };

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
function buildReasoning(s1h, s4h, s1d, confluenceLevel, regime, strategy, signal, finalScore, inSession, tf1h, tf4h, tf1d, extras) {
  extras = extras || {};
  const reasons = [];

  if (confluenceLevel === 3) reasons.push('All 3 timeframes agree - strong confluence');
  else if (confluenceLevel === 2) reasons.push('2/3 timeframes agree - moderate confluence');
  else reasons.push('Mixed timeframes - weak confluence, trade with caution');

  const minConf = (finalScore || 0) >= 58 ? 1 : ENGINE_CONFIG.MIN_CONFLUENCE_FOR_SIGNAL;
  if (finalScore !== undefined && (finalScore < ENGINE_CONFIG.MIN_SIGNAL_SCORE || confluenceLevel < minConf))
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

  // Candlestick patterns (v4.1)
  const tfPatterns = [
    { name: '1H', a: tf1h },
    { name: '4H', a: tf4h },
    { name: '1D', a: tf1d }
  ];
  for (const { name, a } of tfPatterns) {
    const cp = a && a.candlestickPatterns;
    if (cp && cp.patterns && cp.patterns.length > 0) {
      const bullP = cp.patterns.filter(p => p.direction === 'BULL');
      const bearP = cp.patterns.filter(p => p.direction === 'BEAR');
      if (bullP.length > 0) {
        const names = bullP.map(p => {
          const ctx = p.contextFactors && p.contextFactors.length > 0 ? ' (' + p.contextFactors.join(', ') + ')' : '';
          return p.name + ctx;
        }).join(', ');
        reasons.push(`${name}: Bullish candle patterns: ${names}`);
      }
      if (bearP.length > 0) {
        const names = bearP.map(p => {
          const ctx = p.contextFactors && p.contextFactors.length > 0 ? ' (' + p.contextFactors.join(', ') + ')' : '';
          return p.name + ctx;
        }).join(', ');
        reasons.push(`${name}: Bearish candle patterns: ${names}`);
      }
    }
  }

  // Chart patterns (v4.2) — geometric formations
  const tfChartPats = [
    { name: '1H', a: tf1h },
    { name: '4H', a: tf4h },
    { name: '1D', a: tf1d }
  ];
  for (const { name, a } of tfChartPats) {
    const gp = a && a.chartPatterns;
    if (gp && gp.patterns && gp.patterns.length > 0) {
      for (const pat of gp.patterns) {
        const ctx = pat.contextFactors && pat.contextFactors.length > 0 ? ' (' + pat.contextFactors.join(', ') + ')' : '';
        const wr = pat.reliability ? ' [' + Math.round(pat.reliability.winRate * 100) + '% win rate]' : '';
        const comp = pat.completion != null ? ' ' + pat.completion + '% complete' : '';
        const dir = pat.direction === 'BULL' ? 'Bullish' : pat.direction === 'BEAR' ? 'Bearish' : '';
        reasons.push(`${name}: ${dir} chart pattern: ${pat.name}${ctx}${wr}${comp}`);
      }
    }
  }

  // v5 features context
  if (extras.fundingRate != null) {
    const fr = extras.fundingRate;
    if (Math.abs(fr) > 0.0005) {
      const pct = (fr * 100).toFixed(3);
      reasons.push(`Funding rate: ${pct}% (${fr > 0 ? 'longs crowded' : 'shorts crowded'})`);
    }
  }
  if (extras.btcCorrelation != null && extras.btcCorrelation > 0.5) {
    reasons.push(`BTC correlation: ${(extras.btcCorrelation * 100).toFixed(0)}% — ${extras.btcCorrelation > 0.7 ? 'high, watch BTC' : 'moderate'}`);
  }
  if (extras.poc > 0) {
    reasons.push(`Volume POC at $${extras.poc.toFixed(2)}`);
  }
  if (extras.fibLevels && extras.fibLevels.fib618 > 0) {
    reasons.push(`Fib 0.618 at $${extras.fibLevels.fib618.toFixed(2)}`);
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
    volatilityState: 'normal',
    candlestickPatterns: { structureBonus: 0, momentumBonus: 0, bullPoints: 0, bearPoints: 0, patterns: [], reasoning: [] },
    chartPatterns: { structureBonus: 0, bullPoints: 0, bearPoints: 0, patterns: [], reasoning: [] },
    currentPrice, closes: [], highs: [], lows: [], volumes: []
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

module.exports = { analyzeCoin, analyzeAllCoins, ENGINE_CONFIG, findSR, findSRWithRoleReversal, calculatePOC };
