// services/candlestick-patterns.js
// ====================================================
// CANDLESTICK PATTERN DETECTION & RECOGNITION ENGINE
//
// Detects single-candle, multi-candle, and complex patterns
// from OHLCV data. Returns scored patterns with directional
// bias (BULL/BEAR) for integration into the trading engine.
//
// Every pattern is direction-aware:
//   BULL patterns → support LONG signals (bullPoints)
//   BEAR patterns → support SHORT signals (bearPoints)
// ====================================================

// ====================================================
// HELPERS
// ====================================================
function bodySize(c) {
  return Math.abs(c.close - c.open);
}

function fullRange(c) {
  return c.high - c.low;
}

function upperShadow(c) {
  return c.high - Math.max(c.open, c.close);
}

function lowerShadow(c) {
  return Math.min(c.open, c.close) - c.low;
}

function isBullish(c) {
  return c.close > c.open;
}

function isBearish(c) {
  return c.close < c.open;
}

function bodyMidpoint(c) {
  return (c.open + c.close) / 2;
}

function bodyTop(c) {
  return Math.max(c.open, c.close);
}

function bodyBottom(c) {
  return Math.min(c.open, c.close);
}

// Average body size over last N candles (for relative sizing)
function avgBody(candles, n) {
  const slice = candles.slice(-n);
  if (slice.length === 0) return 0;
  return slice.reduce((s, c) => s + bodySize(c), 0) / slice.length;
}

// Average full range over last N candles
function avgRange(candles, n) {
  const slice = candles.slice(-n);
  if (slice.length === 0) return 0;
  return slice.reduce((s, c) => s + fullRange(c), 0) / slice.length;
}

// Is the candle a doji? (body < threshold% of range)
function isDoji(c, threshold) {
  threshold = threshold || 0.1;
  const range = fullRange(c);
  if (range === 0) return true;
  return bodySize(c) / range < threshold;
}

// Simple trend check: are last N candles trending up or down?
function recentTrend(candles, n) {
  if (candles.length < n + 1) return 'NONE';
  const slice = candles.slice(-(n + 1));
  let ups = 0, downs = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].close > slice[i - 1].close) ups++;
    else downs++;
  }
  if (ups >= Math.ceil(n * 0.7)) return 'UP';
  if (downs >= Math.ceil(n * 0.7)) return 'DOWN';
  return 'MIXED';
}

// ====================================================
// TIER 1: SINGLE-CANDLE PATTERNS
// ====================================================
function detectSingleCandle(candles) {
  if (candles.length < 6) return [];
  const patterns = [];
  const c = candles[candles.length - 1];        // current candle
  const prev = candles[candles.length - 2];      // previous candle
  const range = fullRange(c);
  const body = bodySize(c);
  const upper = upperShadow(c);
  const lower = lowerShadow(c);
  const ab = avgBody(candles.slice(0, -1), 10);  // avg body of prior candles
  const trend = recentTrend(candles.slice(0, -1), 5);

  if (range === 0 || ab === 0) return patterns;

  // === HAMMER (bullish reversal at bottom of downtrend) ===
  // Long lower shadow (>= 2x body), small upper shadow, after downtrend
  if (lower >= body * 2 && upper <= body * 0.5 && body > 0 && trend === 'DOWN') {
    patterns.push({
      name: 'Hammer',
      direction: 'BULL',
      type: 'reversal',
      strength: lower >= body * 3 ? 3 : 2,
      description: 'Hammer at bottom - buyers stepping in'
    });
  }

  // === INVERTED HAMMER (bullish reversal at bottom of downtrend) ===
  // Long upper shadow (>= 2x body), small lower shadow, after downtrend
  if (upper >= body * 2 && lower <= body * 0.5 && body > 0 && trend === 'DOWN') {
    patterns.push({
      name: 'Inverted Hammer',
      direction: 'BULL',
      type: 'reversal',
      strength: 2,
      description: 'Inverted hammer at bottom - buying pressure emerging'
    });
  }

  // === SHOOTING STAR (bearish reversal at top of uptrend) ===
  // Long upper shadow (>= 2x body), small lower shadow, after uptrend
  if (upper >= body * 2 && lower <= body * 0.5 && body > 0 && trend === 'UP') {
    patterns.push({
      name: 'Shooting Star',
      direction: 'BEAR',
      type: 'reversal',
      strength: upper >= body * 3 ? 3 : 2,
      description: 'Shooting star at top - sellers rejecting higher prices'
    });
  }

  // === HANGING MAN (bearish reversal - hammer shape at top of uptrend) ===
  if (lower >= body * 2 && upper <= body * 0.5 && body > 0 && trend === 'UP') {
    patterns.push({
      name: 'Hanging Man',
      direction: 'BEAR',
      type: 'reversal',
      strength: 2,
      description: 'Hanging man at top - potential reversal warning'
    });
  }

  // === DOJI VARIANTS ===
  if (isDoji(c, 0.1) && range > 0) {
    // Dragonfly Doji (long lower shadow, no upper) - bullish at bottom
    if (lower >= range * 0.65 && upper <= range * 0.1) {
      patterns.push({
        name: 'Dragonfly Doji',
        direction: trend === 'DOWN' ? 'BULL' : 'NEUTRAL',
        type: 'reversal',
        strength: trend === 'DOWN' ? 3 : 1,
        description: 'Dragonfly doji - strong rejection of lower prices'
      });
    }
    // Gravestone Doji (long upper shadow, no lower) - bearish at top
    else if (upper >= range * 0.65 && lower <= range * 0.1) {
      patterns.push({
        name: 'Gravestone Doji',
        direction: trend === 'UP' ? 'BEAR' : 'NEUTRAL',
        type: 'reversal',
        strength: trend === 'UP' ? 3 : 1,
        description: 'Gravestone doji - strong rejection of higher prices'
      });
    }
    // Long-legged Doji (long shadows both sides) - extreme indecision
    else if (upper >= range * 0.3 && lower >= range * 0.3) {
      patterns.push({
        name: 'Long-Legged Doji',
        direction: 'NEUTRAL',
        type: 'indecision',
        strength: 2,
        description: 'Long-legged doji - extreme indecision, watch for breakout'
      });
    }
    // Standard Doji
    else {
      patterns.push({
        name: 'Doji',
        direction: 'NEUTRAL',
        type: 'indecision',
        strength: 1,
        description: 'Doji - indecision, potential trend change'
      });
    }
  }

  // === MARUBOZU (strong continuation - full body, no shadows) ===
  if (body > ab * 1.5 && upper <= range * 0.05 && lower <= range * 0.05) {
    if (isBullish(c)) {
      patterns.push({
        name: 'Bullish Marubozu',
        direction: 'BULL',
        type: 'continuation',
        strength: 3,
        description: 'Bullish marubozu - dominant buying, full control'
      });
    } else {
      patterns.push({
        name: 'Bearish Marubozu',
        direction: 'BEAR',
        type: 'continuation',
        strength: 3,
        description: 'Bearish marubozu - dominant selling, full control'
      });
    }
  }

  // === SPINNING TOP (small body, roughly equal shadows) ===
  if (body < ab * 0.3 && body > 0 && range > ab * 0.5) {
    const shadowRatio = upper > 0 && lower > 0 ? Math.min(upper, lower) / Math.max(upper, lower) : 0;
    if (shadowRatio > 0.5) {
      patterns.push({
        name: 'Spinning Top',
        direction: 'NEUTRAL',
        type: 'indecision',
        strength: 1,
        description: 'Spinning top - indecision between buyers and sellers'
      });
    }
  }

  // === PIN BAR (extremely long wick on one side, >= 3x body) ===
  if (body > 0 && !isDoji(c, 0.1)) {
    if (lower >= body * 3 && upper < body) {
      const dir = trend === 'DOWN' ? 'BULL' : (trend === 'UP' ? 'BEAR' : 'NEUTRAL');
      patterns.push({
        name: 'Bullish Pin Bar',
        direction: 'BULL',
        type: 'reversal',
        strength: 3,
        description: 'Bullish pin bar - extreme rejection of lower prices'
      });
    } else if (upper >= body * 3 && lower < body) {
      patterns.push({
        name: 'Bearish Pin Bar',
        direction: 'BEAR',
        type: 'reversal',
        strength: 3,
        description: 'Bearish pin bar - extreme rejection of higher prices'
      });
    }
  }

  return patterns;
}

// ====================================================
// TIER 2: MULTI-CANDLE PATTERNS (2-3 candle)
// ====================================================
function detectMultiCandle(candles) {
  if (candles.length < 6) return [];
  const patterns = [];
  const c = candles[candles.length - 1];     // current
  const p = candles[candles.length - 2];     // previous
  const pp = candles[candles.length - 3];    // two back
  const ab = avgBody(candles.slice(0, -1), 10);
  const trend = recentTrend(candles.slice(0, -2), 5);

  if (ab === 0) return patterns;

  // === BULLISH ENGULFING (strong bull reversal) ===
  // Previous bearish, current bullish, current body fully engulfs previous body
  if (isBearish(p) && isBullish(c) &&
      c.close > p.open && c.open < p.close &&
      bodySize(c) > bodySize(p) * 1.1) {
    patterns.push({
      name: 'Bullish Engulfing',
      direction: 'BULL',
      type: 'reversal',
      strength: trend === 'DOWN' ? 3 : 2,
      description: 'Bullish engulfing - buyers overwhelm sellers' + (trend === 'DOWN' ? ' after downtrend' : '')
    });
  }

  // === BEARISH ENGULFING (strong bear reversal) ===
  if (isBullish(p) && isBearish(c) &&
      c.open > p.close && c.close < p.open &&
      bodySize(c) > bodySize(p) * 1.1) {
    patterns.push({
      name: 'Bearish Engulfing',
      direction: 'BEAR',
      type: 'reversal',
      strength: trend === 'UP' ? 3 : 2,
      description: 'Bearish engulfing - sellers overwhelm buyers' + (trend === 'UP' ? ' after uptrend' : '')
    });
  }

  // === BULLISH HARAMI (smaller bull inside bear - reversal) ===
  if (isBearish(p) && isBullish(c) &&
      bodyTop(c) < bodyTop(p) && bodyBottom(c) > bodyBottom(p) &&
      bodySize(c) < bodySize(p) * 0.6 && trend === 'DOWN') {
    patterns.push({
      name: 'Bullish Harami',
      direction: 'BULL',
      type: 'reversal',
      strength: 2,
      description: 'Bullish harami - selling pressure diminishing'
    });
  }

  // === BEARISH HARAMI (smaller bear inside bull - reversal) ===
  if (isBullish(p) && isBearish(c) &&
      bodyTop(c) < bodyTop(p) && bodyBottom(c) > bodyBottom(p) &&
      bodySize(c) < bodySize(p) * 0.6 && trend === 'UP') {
    patterns.push({
      name: 'Bearish Harami',
      direction: 'BEAR',
      type: 'reversal',
      strength: 2,
      description: 'Bearish harami - buying pressure diminishing'
    });
  }

  // === PIERCING LINE (bullish reversal - 2 candle) ===
  // Prev bearish, current bullish, opens below prev low, closes above prev midpoint
  if (isBearish(p) && isBullish(c) &&
      c.open < p.low && c.close > bodyMidpoint(p) && c.close < p.open &&
      trend === 'DOWN') {
    patterns.push({
      name: 'Piercing Line',
      direction: 'BULL',
      type: 'reversal',
      strength: 2,
      description: 'Piercing line - strong buying reversal from lows'
    });
  }

  // === DARK CLOUD COVER (bearish reversal - 2 candle) ===
  // Prev bullish, current bearish, opens above prev high, closes below prev midpoint
  if (isBullish(p) && isBearish(c) &&
      c.open > p.high && c.close < bodyMidpoint(p) && c.close > p.open &&
      trend === 'UP') {
    patterns.push({
      name: 'Dark Cloud Cover',
      direction: 'BEAR',
      type: 'reversal',
      strength: 2,
      description: 'Dark cloud cover - selling pressure from highs'
    });
  }

  // === TWEEZER BOTTOM (bullish reversal - matching lows) ===
  if (trend === 'DOWN' && Math.abs(p.low - c.low) / (fullRange(c) || 1) < 0.05 &&
      isBearish(p) && isBullish(c) && bodySize(c) > ab * 0.3) {
    patterns.push({
      name: 'Tweezer Bottom',
      direction: 'BULL',
      type: 'reversal',
      strength: 2,
      description: 'Tweezer bottom - support confirmed by matching lows'
    });
  }

  // === TWEEZER TOP (bearish reversal - matching highs) ===
  if (trend === 'UP' && Math.abs(p.high - c.high) / (fullRange(c) || 1) < 0.05 &&
      isBullish(p) && isBearish(c) && bodySize(c) > ab * 0.3) {
    patterns.push({
      name: 'Tweezer Top',
      direction: 'BEAR',
      type: 'reversal',
      strength: 2,
      description: 'Tweezer top - resistance confirmed by matching highs'
    });
  }

  // === MORNING STAR (3-candle bullish reversal) ===
  // 1st bearish (large), 2nd small body (star), 3rd bullish closes into 1st body
  if (candles.length >= 4) {
    if (isBearish(pp) && bodySize(pp) > ab * 0.8 &&
        bodySize(p) < ab * 0.4 &&
        isBullish(c) && bodySize(c) > ab * 0.6 &&
        c.close > bodyMidpoint(pp) &&
        trend === 'DOWN') {
      patterns.push({
        name: 'Morning Star',
        direction: 'BULL',
        type: 'reversal',
        strength: 3,
        description: 'Morning star - powerful 3-bar bullish reversal'
      });
    }

    // === EVENING STAR (3-candle bearish reversal) ===
    if (isBullish(pp) && bodySize(pp) > ab * 0.8 &&
        bodySize(p) < ab * 0.4 &&
        isBearish(c) && bodySize(c) > ab * 0.6 &&
        c.close < bodyMidpoint(pp) &&
        trend === 'UP') {
      patterns.push({
        name: 'Evening Star',
        direction: 'BEAR',
        type: 'reversal',
        strength: 3,
        description: 'Evening star - powerful 3-bar bearish reversal'
      });
    }
  }

  // === THREE WHITE SOLDIERS (strong bullish continuation) ===
  if (candles.length >= 4) {
    if (isBullish(pp) && isBullish(p) && isBullish(c) &&
        bodySize(pp) > ab * 0.6 && bodySize(p) > ab * 0.6 && bodySize(c) > ab * 0.6 &&
        p.close > pp.close && c.close > p.close &&
        p.open > pp.open && c.open > p.open &&
        upperShadow(pp) < bodySize(pp) * 0.3 &&
        upperShadow(p) < bodySize(p) * 0.3 &&
        upperShadow(c) < bodySize(c) * 0.3) {
      patterns.push({
        name: 'Three White Soldiers',
        direction: 'BULL',
        type: 'continuation',
        strength: 3,
        description: 'Three white soldiers - sustained bullish pressure'
      });
    }

    // === THREE BLACK CROWS (strong bearish continuation) ===
    if (isBearish(pp) && isBearish(p) && isBearish(c) &&
        bodySize(pp) > ab * 0.6 && bodySize(p) > ab * 0.6 && bodySize(c) > ab * 0.6 &&
        p.close < pp.close && c.close < p.close &&
        p.open < pp.open && c.open < p.open &&
        lowerShadow(pp) < bodySize(pp) * 0.3 &&
        lowerShadow(p) < bodySize(p) * 0.3 &&
        lowerShadow(c) < bodySize(c) * 0.3) {
      patterns.push({
        name: 'Three Black Crows',
        direction: 'BEAR',
        type: 'continuation',
        strength: 3,
        description: 'Three black crows - sustained bearish pressure'
      });
    }
  }

  return patterns;
}

// ====================================================
// TIER 3: COMPLEX PATTERNS (3-5 candle)
// ====================================================
function detectComplexPatterns(candles) {
  if (candles.length < 7) return [];
  const patterns = [];
  const c0 = candles[candles.length - 1];
  const c1 = candles[candles.length - 2];
  const c2 = candles[candles.length - 3];
  const c3 = candles[candles.length - 4];
  const c4 = candles.length >= 8 ? candles[candles.length - 5] : null;
  const ab = avgBody(candles.slice(0, -1), 10);
  const trend = recentTrend(candles.slice(0, -3), 5);

  if (ab === 0) return patterns;

  // === THREE INSIDE UP (bullish reversal - harami + confirmation) ===
  // c2 large bearish, c1 small bullish inside c2, c0 bullish closes above c2 open
  if (isBearish(c2) && bodySize(c2) > ab * 0.8 &&
      isBullish(c1) && bodyTop(c1) < bodyTop(c2) && bodyBottom(c1) > bodyBottom(c2) &&
      isBullish(c0) && c0.close > c2.open && trend === 'DOWN') {
    patterns.push({
      name: 'Three Inside Up',
      direction: 'BULL',
      type: 'reversal',
      strength: 3,
      description: 'Three inside up - confirmed bullish harami reversal'
    });
  }

  // === THREE INSIDE DOWN (bearish reversal) ===
  if (isBullish(c2) && bodySize(c2) > ab * 0.8 &&
      isBearish(c1) && bodyTop(c1) < bodyTop(c2) && bodyBottom(c1) > bodyBottom(c2) &&
      isBearish(c0) && c0.close < c2.open && trend === 'UP') {
    patterns.push({
      name: 'Three Inside Down',
      direction: 'BEAR',
      type: 'reversal',
      strength: 3,
      description: 'Three inside down - confirmed bearish harami reversal'
    });
  }

  // === ABANDONED BABY BULLISH ===
  // c2 large bearish, c1 doji with gap down (c1.high < c2.low), c0 bullish with gap up (c0.low > c1.high)
  if (isBearish(c2) && bodySize(c2) > ab * 0.7 &&
      isDoji(c1, 0.15) && c1.high < c2.low &&
      isBullish(c0) && c0.low > c1.high && trend === 'DOWN') {
    patterns.push({
      name: 'Abandoned Baby (Bull)',
      direction: 'BULL',
      type: 'reversal',
      strength: 4,
      description: 'Abandoned baby bullish - rare, very strong reversal signal'
    });
  }

  // === ABANDONED BABY BEARISH ===
  if (isBullish(c2) && bodySize(c2) > ab * 0.7 &&
      isDoji(c1, 0.15) && c1.low > c2.high &&
      isBearish(c0) && c0.high < c1.low && trend === 'UP') {
    patterns.push({
      name: 'Abandoned Baby (Bear)',
      direction: 'BEAR',
      type: 'reversal',
      strength: 4,
      description: 'Abandoned baby bearish - rare, very strong reversal signal'
    });
  }

  // === RISING THREE METHODS (bullish continuation) ===
  // c4 large bullish, c3/c2/c1 small bearish within c4 range, c0 large bullish closes above c4 close
  if (c4 && isBullish(c4) && bodySize(c4) > ab * 0.8) {
    const smallBears = [c3, c2, c1].every(x =>
      isBearish(x) && bodySize(x) < bodySize(c4) * 0.5 &&
      x.low >= c4.low && x.high <= c4.high
    );
    if (smallBears && isBullish(c0) && c0.close > c4.close && bodySize(c0) > ab * 0.7) {
      patterns.push({
        name: 'Rising Three Methods',
        direction: 'BULL',
        type: 'continuation',
        strength: 3,
        description: 'Rising three methods - bullish continuation after brief pullback'
      });
    }
  }

  // === FALLING THREE METHODS (bearish continuation) ===
  if (c4 && isBearish(c4) && bodySize(c4) > ab * 0.8) {
    const smallBulls = [c3, c2, c1].every(x =>
      isBullish(x) && bodySize(x) < bodySize(c4) * 0.5 &&
      x.low >= c4.low && x.high <= c4.high
    );
    if (smallBulls && isBearish(c0) && c0.close < c4.close && bodySize(c0) > ab * 0.7) {
      patterns.push({
        name: 'Falling Three Methods',
        direction: 'BEAR',
        type: 'continuation',
        strength: 3,
        description: 'Falling three methods - bearish continuation after brief bounce'
      });
    }
  }

  // === THREE-LINE STRIKE BULLISH ===
  // Three bullish candles + one large bearish that engulfs all three
  if (isBullish(c3) && isBullish(c2) && isBullish(c1) &&
      c2.close > c3.close && c1.close > c2.close &&
      isBearish(c0) && c0.open >= c1.close && c0.close <= c3.open) {
    patterns.push({
      name: 'Three-Line Strike (Bull)',
      direction: 'BULL',
      type: 'continuation',
      strength: 2,
      description: 'Bullish three-line strike - pattern usually resolves upward'
    });
  }

  // === THREE-LINE STRIKE BEARISH ===
  if (isBearish(c3) && isBearish(c2) && isBearish(c1) &&
      c2.close < c3.close && c1.close < c2.close &&
      isBullish(c0) && c0.open <= c1.close && c0.close >= c3.open) {
    patterns.push({
      name: 'Three-Line Strike (Bear)',
      direction: 'BEAR',
      type: 'continuation',
      strength: 2,
      description: 'Bearish three-line strike - pattern usually resolves downward'
    });
  }

  return patterns;
}

// ====================================================
// MAIN DETECTION: Run all tiers
// ====================================================
function detectAllPatterns(candles) {
  if (!candles || candles.length < 6) return [];
  const all = [
    ...detectSingleCandle(candles),
    ...detectMultiCandle(candles),
    ...detectComplexPatterns(candles)
  ];
  return all;
}

// ====================================================
// CONTEXT-AWARE SCORING
//
// Pattern alone = minor signal. Pattern + context = strong signal.
// Returns { structureBonus, momentumBonus, bullPoints, bearPoints, patterns, reasoning }
// ====================================================
function scorePatterns(patterns, context) {
  if (!patterns || patterns.length === 0) {
    return { structureBonus: 0, momentumBonus: 0, bullPoints: 0, bearPoints: 0, patterns: [], reasoning: [] };
  }

  context = context || {};
  let structureBonus = 0;
  let momentumBonus = 0;
  let bullPoints = 0;
  let bearPoints = 0;
  const reasoning = [];
  const scoredPatterns = [];

  for (const p of patterns) {
    let weight = 1.0;
    const contextFactors = [];

    // === CONTEXT MULTIPLIERS ===

    // At support/resistance (from S/R detection)
    if (p.direction === 'BULL' && context.nearSupport) {
      weight *= 1.5;
      contextFactors.push('at support');
    }
    if (p.direction === 'BEAR' && context.nearResistance) {
      weight *= 1.5;
      contextFactors.push('at resistance');
    }

    // Against S/R = pattern fighting the level, reduce
    if (p.direction === 'BULL' && context.nearResistance && p.type === 'continuation') {
      weight *= 0.6;
      contextFactors.push('against resistance');
    }
    if (p.direction === 'BEAR' && context.nearSupport && p.type === 'continuation') {
      weight *= 0.6;
      contextFactors.push('against support');
    }

    // With RSI divergence confirming
    if (p.direction === 'BULL' && context.rsiDivBullish) {
      weight *= 1.3;
      contextFactors.push('RSI divergence confirming');
    }
    if (p.direction === 'BEAR' && context.rsiDivBearish) {
      weight *= 1.3;
      contextFactors.push('RSI divergence confirming');
    }

    // Volume confirmation
    if (context.volumeConfirm) {
      weight *= 1.3;
      contextFactors.push('high volume');
    }

    // In squeeze (compressed, about to break)
    if (context.bbSqueeze) {
      weight *= 1.2;
      contextFactors.push('BB squeeze');
    }

    // Higher TF trend agreement
    if (p.direction === 'BULL' && context.htfTrend === 'UP') {
      weight *= 1.2;
      contextFactors.push('HTF trend aligned');
    } else if (p.direction === 'BEAR' && context.htfTrend === 'DOWN') {
      weight *= 1.2;
      contextFactors.push('HTF trend aligned');
    }
    // Against HTF trend = reduced weight
    if (p.direction === 'BULL' && context.htfTrend === 'DOWN') {
      weight *= 0.6;
      contextFactors.push('against HTF trend');
    } else if (p.direction === 'BEAR' && context.htfTrend === 'UP') {
      weight *= 0.6;
      contextFactors.push('against HTF trend');
    }

    // At order block
    if (p.direction === 'BULL' && context.nearBullOB) {
      weight *= 1.3;
      contextFactors.push('at bull OB');
    }
    if (p.direction === 'BEAR' && context.nearBearOB) {
      weight *= 1.3;
      contextFactors.push('at bear OB');
    }

    // RSI extreme confirming pattern
    if (p.direction === 'BULL' && context.rsiOversold) {
      weight *= 1.2;
      contextFactors.push('RSI oversold');
    }
    if (p.direction === 'BEAR' && context.rsiOverbought) {
      weight *= 1.2;
      contextFactors.push('RSI overbought');
    }

    // === CALCULATE BONUSES ===
    const baseStructure = p.strength * 0.6;
    const baseMomentum = p.type === 'continuation' ? p.strength * 0.5 : p.strength * 0.3;

    const adjStructure = baseStructure * weight;
    const adjMomentum = baseMomentum * weight;

    structureBonus += adjStructure;
    momentumBonus += adjMomentum;

    // Direction points for bull/bear tally
    if (p.direction === 'BULL') {
      bullPoints += Math.ceil(p.strength * weight);
    } else if (p.direction === 'BEAR') {
      bearPoints += Math.ceil(p.strength * weight);
    }

    // Build reasoning string
    const ctxStr = contextFactors.length > 0 ? ' (' + contextFactors.join(', ') + ')' : '';
    reasoning.push(p.name + ctxStr);

    scoredPatterns.push({
      name: p.name,
      direction: p.direction,
      type: p.type,
      strength: p.strength,
      weight: Math.round(weight * 100) / 100,
      contextFactors,
      description: p.description
    });
  }

  // Cap bonuses so patterns can't dominate
  structureBonus = Math.min(structureBonus, 5);
  momentumBonus = Math.min(momentumBonus, 3);

  return {
    structureBonus: Math.round(structureBonus * 10) / 10,
    momentumBonus: Math.round(momentumBonus * 10) / 10,
    bullPoints,
    bearPoints,
    patterns: scoredPatterns,
    reasoning
  };
}

// ====================================================
// PATTERN EDUCATION DATA (for learn page)
// ====================================================
function getPatternEducation() {
  return {
    singleCandle: [
      { name: 'Hammer', direction: 'BULL', type: 'Reversal', desc: 'Long lower shadow (2x+ body), small upper shadow. Found at bottom of downtrends. Buyers stepped in and pushed price back up.', strength: 'Medium-High' },
      { name: 'Inverted Hammer', direction: 'BULL', type: 'Reversal', desc: 'Long upper shadow (2x+ body), small lower shadow. Found at bottom. Attempted rally shows buying interest emerging.', strength: 'Medium' },
      { name: 'Shooting Star', direction: 'BEAR', type: 'Reversal', desc: 'Long upper shadow (2x+ body), small lower shadow. Found at top of uptrends. Sellers rejected higher prices forcefully.', strength: 'Medium-High' },
      { name: 'Hanging Man', direction: 'BEAR', type: 'Reversal', desc: 'Hammer shape at the TOP of uptrend. Warning that support is weakening despite the recovery.', strength: 'Medium' },
      { name: 'Doji', direction: 'Neutral', type: 'Indecision', desc: 'Open equals close. Market is undecided. At extremes, signals potential reversal. 4 variants: Standard, Dragonfly (bull), Gravestone (bear), Long-legged.', strength: 'Low-Medium' },
      { name: 'Marubozu', direction: 'Both', type: 'Continuation', desc: 'Full body with no shadows. Bullish = total buyer control. Bearish = total seller control. Very strong directional conviction.', strength: 'High' },
      { name: 'Pin Bar', direction: 'Both', type: 'Reversal', desc: 'Extremely long shadow (3x+ body) on one side. Shows violent rejection of a price level. One of the strongest single-candle signals.', strength: 'High' },
      { name: 'Spinning Top', direction: 'Neutral', type: 'Indecision', desc: 'Small body with roughly equal shadows. Neither side has control. Often seen before breakouts.', strength: 'Low' }
    ],
    multiCandle: [
      { name: 'Bullish Engulfing', direction: 'BULL', type: 'Reversal', desc: 'Bullish candle completely engulfs previous bearish candle. Buyers overwhelmed sellers in one bar. Very reliable at support.', strength: 'High' },
      { name: 'Bearish Engulfing', direction: 'BEAR', type: 'Reversal', desc: 'Bearish candle completely engulfs previous bullish candle. Sellers overwhelmed buyers. Very reliable at resistance.', strength: 'High' },
      { name: 'Morning Star', direction: 'BULL', type: 'Reversal', desc: '3-candle pattern: large bearish, small indecision, large bullish. Powerful bottom reversal - the "star" shows selling exhaustion.', strength: 'Very High' },
      { name: 'Evening Star', direction: 'BEAR', type: 'Reversal', desc: '3-candle pattern: large bullish, small indecision, large bearish. Powerful top reversal - buying exhaustion into distribution.', strength: 'Very High' },
      { name: 'Piercing Line', direction: 'BULL', type: 'Reversal', desc: 'Opens below prior low, closes above prior midpoint. Shows buyers stepped in aggressively at lower prices.', strength: 'Medium' },
      { name: 'Dark Cloud Cover', direction: 'BEAR', type: 'Reversal', desc: 'Opens above prior high, closes below prior midpoint. Shows sellers stepped in aggressively at higher prices.', strength: 'Medium' },
      { name: 'Three White Soldiers', direction: 'BULL', type: 'Continuation', desc: 'Three consecutive bullish candles with strong bodies and small wicks. Sustained buying pressure, very strong trend signal.', strength: 'Very High' },
      { name: 'Three Black Crows', direction: 'BEAR', type: 'Continuation', desc: 'Three consecutive bearish candles with strong bodies. Sustained selling pressure, very strong downtrend signal.', strength: 'Very High' },
      { name: 'Tweezer Bottom', direction: 'BULL', type: 'Reversal', desc: 'Two candles with matching lows (bear then bull). The level was tested twice and held - strong support confirmation.', strength: 'Medium' },
      { name: 'Tweezer Top', direction: 'BEAR', type: 'Reversal', desc: 'Two candles with matching highs (bull then bear). Resistance tested twice - strong rejection confirmation.', strength: 'Medium' }
    ],
    complex: [
      { name: 'Three Inside Up', direction: 'BULL', type: 'Reversal', desc: 'Harami + confirmation candle. More reliable than harami alone because the third candle confirms the reversal.', strength: 'High' },
      { name: 'Three Inside Down', direction: 'BEAR', type: 'Reversal', desc: 'Bearish harami + confirmation. Third candle confirms sellers have taken control after the inside bar.', strength: 'High' },
      { name: 'Abandoned Baby', direction: 'Both', type: 'Reversal', desc: 'Doji star with gaps on both sides. Extremely rare but one of the most reliable reversal patterns in existence.', strength: 'Very High' },
      { name: 'Rising Three Methods', direction: 'BULL', type: 'Continuation', desc: 'Large bull candle, 3 small bears within its range, then another large bull. Brief pullback in strong uptrend.', strength: 'High' },
      { name: 'Falling Three Methods', direction: 'BEAR', type: 'Continuation', desc: 'Large bear candle, 3 small bulls within its range, then another large bear. Brief bounce in strong downtrend.', strength: 'High' },
      { name: 'Three-Line Strike', direction: 'Both', type: 'Continuation', desc: 'Three same-direction candles followed by one large opposite candle. Despite looking bearish/bullish, the pattern usually resolves in the original direction.', strength: 'Medium' }
    ]
  };
}

module.exports = {
  detectAllPatterns,
  detectSingleCandle,
  detectMultiCandle,
  detectComplexPatterns,
  scorePatterns,
  getPatternEducation
};
