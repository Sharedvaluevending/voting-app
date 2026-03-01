// services/smc-scenarios/scenario-checks.js
// ====================================================
// SMC SCENARIO CHECK FUNCTIONS
// Each check evaluates a phase condition using candles + analysis
// ====================================================

const { analyzeOHLCV, getSwingPoints, detectOrderBlocks, detectFVGs, detectLiquidityClusters, detectMarketStructure, ATR_OHLC } = require('../trading-engine');

/**
 * Evaluate a scenario at bar index t (0-based). Uses candles slice [0..t+1].
 * @param {Array} candles - Full OHLCV array
 * @param {Object} analysis - From analyzeOHLCV(candles, currentPrice) - optional, computed if not provided
 * @param {string} scenarioId - e.g. 'fvg_liquidity_long'
 * @param {number} t - Bar index (evaluate at close of bar t)
 * @returns {{ phases: Array, score: number, ready: boolean }}
 */
function evaluateScenario(candles, analysis, scenarioId, t) {
  const { getScenario } = require('./scenario-definitions');
  const scenario = getScenario(scenarioId);
  if (!scenario) return { phases: [], score: 0, ready: false };

  const slice = candles.slice(0, (t != null ? t : candles.length - 1) + 1);
  const currentPrice = slice.length > 0 ? slice[slice.length - 1].close : 0;

  if (!analysis && slice.length >= 20) {
    analysis = analyzeOHLCV(slice, currentPrice);
  }
  if (!analysis) return { phases: [], score: 0, ready: false };

  const results = { phases: [], score: 0, ready: false };

  for (const phase of scenario.phases) {
    const passed = runCheck(phase.check, slice, analysis, scenario.direction);
    results.phases.push({ ...phase, passed });
    if (passed) results.score += 1;
  }

  const shortPhases = scenario.shortVersion || scenario.phases.map(p => p.id);
  results.ready = shortPhases.every(id => results.phases.find(p => p.id === id)?.passed);

  return results;
}

function runCheck(checkId, candles, analysis, direction) {
  if (!candles || candles.length < 5 || !analysis) return false;

  const currentPrice = analysis.currentPrice || candles[candles.length - 1].close;
  const highs = analysis.highs || candles.map(c => c.high);
  const lows = analysis.lows || candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const support = analysis.support || Math.min(...lows.slice(-20));
  const resistance = analysis.resistance || Math.max(...highs.slice(-20));
  const srRange = resistance - support;
  const posInSR = srRange > 0 ? (currentPrice - support) / srRange : 0.5;

  const liq = analysis.liquidityClusters || {};
  const fvgs = analysis.fvgs || [];
  const orderBlocks = analysis.orderBlocks || [];
  const marketStructure = analysis.marketStructure || 'UNKNOWN';

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;

  // ATR for threshold checks — computed once per runCheck call
  const atr = candles.length >= 14 ? ATR_OHLC(highs, lows, closes, 14) : currentPrice * 0.01;

  switch (checkId) {
    case 'liquidityClusterBelow': {
      // Require liquidity within 4*ATR of price — swept liquidity should be relatively close
      const distOk = liq.below != null && (currentPrice - liq.below) <= atr * 4;
      return distOk && currentPrice > liq.below;
    }
    case 'liquidityClusterAbove': {
      const distOk = liq.above != null && (liq.above - currentPrice) <= atr * 4;
      return distOk && currentPrice < liq.above;
    }

    // FIX #7: require recent structure shift (last 20 bars), not just current overall structure
    case 'structureShiftBull':
      return recentStructureShift(candles, 'BULL');
    case 'structureShiftBear':
      return recentStructureShift(candles, 'BEAR');

    // FIX #8: hasPOIInDiscount/Premium — only check existence of POI in zone, not proximity
    case 'poiInDiscount':
      return hasPOIInDiscount(analysis);
    case 'poiInPremium':
      return hasPOIInPremium(analysis);

    case 'liquiditySweepBelow':
      return detectLiquiditySweep(candles, analysis, 'below');
    case 'liquiditySweepAbove':
      return detectLiquiditySweep(candles, analysis, 'above');
    case 'buy_side_draw':
      return detectLiquiditySweep(candles, analysis, 'above');
    case 'sell_side_draw':
      return detectLiquiditySweep(candles, analysis, 'below');

    // priceAtPOI — direction-aware: LONG only matches bull OBs/FVGs, SHORT only bear
    case 'priceAtPOI':
      return priceNearOBOrFVG(analysis, direction);

    // FIX #1: entryConfirmation — require meaningful candle body (>= 30% ATR)
    case 'entryConfirmation':
      return lastCandleConfirmsDirection(candles, direction, atr);

    // FIX #4: targetAtLiquidity — require cluster at least 1× ATR away
    case 'targetAtLiquidityAbove':
      return liq.above != null && liq.above > currentPrice + atr;
    case 'targetAtLiquidityBelow':
      return liq.below != null && liq.below < currentPrice - atr;

    case 'accumulationIdentified':
      return (analysis.accDist === 'ACCUMULATING' || analysis.accDist === 'NEUTRAL') && (analysis.volatilityState === 'low' || analysis.volatilityState === 'normal');
    case 'distributionIdentified':
      return (analysis.accDist === 'DISTRIBUTING' || analysis.accDist === 'NEUTRAL') && (analysis.volatilityState === 'low' || analysis.volatilityState === 'normal');
    case 'manipulationSweep':
      return detectManipulationSweep(candles, analysis, 'below');
    case 'manipulationSweepUp':
      return detectManipulationSweep(candles, analysis, 'above');

    // FIX #2: FVG must have formed AFTER the sweep bar
    case 'inverseFVGAfterSweep':
      return fvgFormedAfterSweep(candles, analysis, 'BULL');
    case 'bearishFVGAfterSweep':
      return fvgFormedAfterSweep(candles, analysis, 'BEAR');

    case 'entryAtFVG':
      return priceNearOBOrFVG(analysis) && fvgs.some(f => f.type === 'BULL') && lastCandleConfirmsDirection(candles, 'LONG', atr);
    case 'entryAtBearFVG':
      return priceNearOBOrFVG(analysis) && fvgs.some(f => f.type === 'BEAR') && lastCandleConfirmsDirection(candles, 'SHORT', atr);

    case 'fvgBullPresent':
      return fvgs.some(f => f.type === 'BULL');
    case 'fvgBearPresent':
      return fvgs.some(f => f.type === 'BEAR');
    case 'fvgInDiscount':
      return posInSR < 0.5 && fvgs.some(f => f.type === 'BULL');
    case 'fvgInPremium':
      return posInSR > 0.5 && fvgs.some(f => f.type === 'BEAR');
    case 'priceAtBullFVG':
      return priceNearFVG(analysis, 'BULL');
    case 'priceAtBearFVG':
      return priceNearFVG(analysis, 'BEAR');
    case 'obBullPresent':
      return orderBlocks.some(ob => ob.type === 'BULL');
    case 'obBearPresent':
      return orderBlocks.some(ob => ob.type === 'BEAR');

    // FIX #3: priceNearZone tolerance tightened inside helper
    case 'priceAtBullOB':
      return orderBlocks.some(ob => ob.type === 'BULL' && priceNearZone(currentPrice, ob.top, ob.bottom));
    case 'priceAtBearOB':
      return orderBlocks.some(ob => ob.type === 'BEAR' && priceNearZone(currentPrice, ob.top, ob.bottom));

    // FIX #5: reversal candle requires meaningful body >= 40% of 2-bar range
    case 'reversalCandleBull':
      return isReversalCandle(lastCandle, prevCandle, 'BULL');
    case 'reversalCandleBear':
      return isReversalCandle(lastCandle, prevCandle, 'BEAR');

    case 'fvgObStackBull':
      return fvgs.some(f => f.type === 'BULL') && orderBlocks.some(ob => ob.type === 'BULL') && priceNearOBOrFVG(analysis, 'LONG');
    case 'fvgObStackBear':
      return fvgs.some(f => f.type === 'BEAR') && orderBlocks.some(ob => ob.type === 'BEAR') && priceNearOBOrFVG(analysis, 'SHORT');
    case 'priceInDiscount':
      return posInSR < 0.5;
    case 'priceInPremium':
      return posInSR > 0.5;
    // Existence-only checks — does a bull/bear POI exist (any location)?
    // Used where sweep already implies discount/premium context
    case 'poiBullExists':
      return orderBlocks.some(ob => ob.type === 'BULL') || fvgs.some(f => f.type === 'BULL');
    case 'poiBearExists':
      return orderBlocks.some(ob => ob.type === 'BEAR') || fvgs.some(f => f.type === 'BEAR');
    default:
      return false;
  }
}

// FIX #3: tolerance tightened from < 2 to < 0.5 (price within half the zone width of midpoint)
function priceNearZone(price, top, bottom) {
  if (!top || !bottom) return false;
  const mid = (top + bottom) / 2;
  const range = Math.abs(top - bottom) || price * 0.01;
  return Math.abs(price - mid) / range < 0.5;
}

function priceNearFVG(analysis, type) {
  const fvgs = analysis.fvgs || [];
  const price = analysis.currentPrice;
  const match = fvgs.find(f => f.type === type);
  if (!match) return false;
  const top = Math.max(match.top, match.bottom);
  const bottom = Math.min(match.top, match.bottom);
  const fvgWidth = top - bottom;
  // Allow price within 1× FVG width above/below the zone (or 0.5% if FVG is tiny)
  const tolerance = Math.max(fvgWidth, price * 0.005);
  return price >= bottom - tolerance && price <= top + tolerance;
}

// FIX #8: hasPOIInDiscount — only check that a bull POI *exists* in the discount zone
// (price proximity is checked separately by priceAtPOI)
function hasPOIInDiscount(analysis) {
  const posInSR = getPosInSR(analysis);
  if (posInSR >= 0.5) return false;
  return analysis.orderBlocks?.some(ob => ob.type === 'BULL') || analysis.fvgs?.some(f => f.type === 'BULL');
}

// FIX #8: hasPOIInPremium — only check that a bear POI *exists* in the premium zone
function hasPOIInPremium(analysis) {
  const posInSR = getPosInSR(analysis);
  if (posInSR <= 0.5) return false;
  return analysis.orderBlocks?.some(ob => ob.type === 'BEAR') || analysis.fvgs?.some(f => f.type === 'BEAR');
}

function getPosInSR(analysis) {
  const support = analysis.support;
  const resistance = analysis.resistance;
  const price = analysis.currentPrice;
  const range = resistance - support;
  return range > 0 ? (price - support) / range : 0.5;
}

// direction: 'LONG' = only bull OBs/FVGs, 'SHORT' = only bear OBs/FVGs, null = any
function priceNearOBOrFVG(analysis, direction) {
  const price = analysis.currentPrice;
  const obType = direction === 'LONG' ? 'BULL' : direction === 'SHORT' ? 'BEAR' : null;
  const fvgType = obType;
  for (const ob of analysis.orderBlocks || []) {
    if (obType && ob.type !== obType) continue;
    if (priceNearZone(price, ob.top, ob.bottom)) return true;
  }
  for (const fvg of analysis.fvgs || []) {
    if (fvgType && fvg.type !== fvgType) continue;
    const top = Math.max(fvg.top, fvg.bottom);
    const bottom = Math.min(fvg.top, fvg.bottom);
    if (price >= bottom * 0.995 && price <= top * 1.005) return true;
  }
  return false;
}

// FIX #1: require body >= 30% of ATR for a meaningful confirmation candle
function lastCandleConfirmsDirection(candles, direction, atr) {
  if (!candles || candles.length < 2) return false;
  const last = candles[candles.length - 1];
  const body = Math.abs(last.close - last.open);
  const minBody = atr ? atr * 0.3 : 0;
  if (body < minBody) return false;
  if (direction === 'LONG') return last.close > last.open;
  if (direction === 'SHORT') return last.close < last.open;
  return false;
}

// FIX #5: reversal candle — bull/bear engulf with body >= 40% of 2-bar high-to-low range
function isReversalCandle(lastCandle, prevCandle, direction) {
  if (!lastCandle || !prevCandle) return false;
  const twoBarHigh = Math.max(lastCandle.high, prevCandle.high);
  const twoBarLow = Math.min(lastCandle.low, prevCandle.low);
  const twoBarRange = twoBarHigh - twoBarLow;
  if (twoBarRange <= 0) return false;
  const body = Math.abs(lastCandle.close - lastCandle.open);
  if (body / twoBarRange < 0.4) return false;
  if (direction === 'BULL') {
    return lastCandle.close > lastCandle.open &&
      prevCandle.close < prevCandle.open &&
      lastCandle.close > prevCandle.open;
  }
  if (direction === 'BEAR') {
    return lastCandle.close < lastCandle.open &&
      prevCandle.close > prevCandle.open &&
      lastCandle.close < prevCandle.open;
  }
  return false;
}

// FIX #7: structureShiftBull/Bear — look for a recent BOS within the last 20 bars.
// Bullish BOS: a close above the swing high of the 20 bars prior to the last 20.
// Bearish BOS: a close below the swing low of the 20 bars prior to the last 20.
function recentStructureShift(candles, bos) {
  const LOOKBACK = 20;
  if (candles.length < LOOKBACK * 2) return false;
  const recent = candles.slice(-LOOKBACK);
  const prior = candles.slice(-LOOKBACK * 2, -LOOKBACK);

  if (bos === 'BULL') {
    const priorSwingHigh = Math.max(...prior.map(c => c.high));
    // Any close in the recent window above the prior swing high = BOS up
    return recent.some(c => c.close > priorSwingHigh);
  }
  if (bos === 'BEAR') {
    const priorSwingLow = Math.min(...prior.map(c => c.low));
    // Any close in the recent window below the prior swing low = BOS down
    return recent.some(c => c.close < priorSwingLow);
  }
  return false;
}

function detectLiquiditySweep(candles, analysis, side) {
  if (!candles || candles.length < 15) return false;
  const { swingLows, swingHighs } = getSwingPoints(analysis.lows || candles.map(c => c.low), analysis.highs || candles.map(c => c.high), 30);
  const recent = candles.slice(-8);
  const liq = analysis.liquidityClusters || {};

  if (side === 'below') {
    const clusterLevel = liq.below;
    if (!clusterLevel && swingLows.length === 0) return false;
    const level = clusterLevel || (swingLows.length > 0 ? Math.min(...swingLows.map(s => s.val)) : null);
    if (!level) return false;
    const swept = recent.some(c => c.low < level * 1.002);
    const recovered = candles[candles.length - 1].close > level;
    return swept && recovered;
  }

  if (side === 'above') {
    const clusterLevel = liq.above;
    if (!clusterLevel && swingHighs.length === 0) return false;
    const level = clusterLevel || (swingHighs.length > 0 ? Math.max(...swingHighs.map(s => s.val)) : null);
    if (!level) return false;
    const swept = recent.some(c => c.high > level * 0.998);
    const recovered = candles[candles.length - 1].close < level;
    return swept && recovered;
  }

  return false;
}

function detectManipulationSweep(candles, analysis, side) {
  if (!candles || candles.length < 20) return false;
  const lows = candles.map(c => c.low);
  const highs = candles.map(c => c.high);
  const lookback = Math.min(30, Math.floor(candles.length / 2));
  const rangeLows = lows.slice(-lookback);
  const rangeHighs = highs.slice(-lookback);
  const rangeLow = Math.min(...rangeLows);
  const rangeHigh = Math.max(...rangeHighs);
  const recent = candles.slice(-5);

  if (side === 'below') {
    const swept = recent.some(c => c.low < rangeLow * 1.001);
    const lastClose = candles[candles.length - 1].close;
    const recovered = lastClose > rangeLow;
    return swept && recovered;
  }

  if (side === 'above') {
    const swept = recent.some(c => c.high > rangeHigh * 0.999);
    const lastClose = candles[candles.length - 1].close;
    const recovered = lastClose < rangeHigh;
    return swept && recovered;
  }

  return false;
}

// FIX #2: FVG must have formed AFTER the sweep bar.
// Finds the most recent sweep bar, then scans for a 3-bar FVG gap in candles after it.
function fvgFormedAfterSweep(candles, analysis, fvgType) {
  if (candles.length < 10) return false;

  // Find the sweep bar index — most recent candle that dipped below rangeLow (bull) or above rangeHigh (bear)
  const lookback = Math.min(30, Math.floor(candles.length / 2));
  const lows = candles.map(c => c.low);
  const highs = candles.map(c => c.high);
  const rangeLow = Math.min(...lows.slice(-lookback));
  const rangeHigh = Math.max(...highs.slice(-lookback));

  let sweepBarIdx = -1;
  if (fvgType === 'BULL') {
    // Sweep: wick below rangeLow then closes back above
    for (let i = candles.length - 5; i < candles.length; i++) {
      if (i < 0) continue;
      if (candles[i].low < rangeLow * 1.001) { sweepBarIdx = i; break; }
    }
  } else {
    // Sweep: wick above rangeHigh then closes back below
    for (let i = candles.length - 5; i < candles.length; i++) {
      if (i < 0) continue;
      if (candles[i].high > rangeHigh * 0.999) { sweepBarIdx = i; break; }
    }
  }

  if (sweepBarIdx < 0) return false;

  // Scan candles AFTER the sweep for a 3-bar FVG pattern
  for (let i = sweepBarIdx + 1; i < candles.length - 2; i++) {
    if (fvgType === 'BULL') {
      // Bullish FVG: bar[i].high < bar[i+2].low (gap up)
      if (candles[i].high < candles[i + 2].low) return true;
    } else {
      // Bearish FVG: bar[i].low > bar[i+2].high (gap down)
      if (candles[i].low > candles[i + 2].high) return true;
    }
  }

  return false;
}

/**
 * Extract price details from analysis for a phase (for setup explanation popup).
 * @param {string} checkId - e.g. 'liquidityClusterBelow'
 * @param {Object} analysis - from analyzeOHLCV
 * @returns {{ prices: string[], note?: string }}
 */
function getPhasePriceDetails(checkId, analysis) {
  const fmt = (v) => v != null && Number.isFinite(v) ? '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : null;
  const cp = analysis.currentPrice;
  const liq = analysis.liquidityClusters || {};
  const fvgs = analysis.fvgs || [];
  const orderBlocks = analysis.orderBlocks || [];
  const support = analysis.support;
  const resistance = analysis.resistance;

  const prices = [];
  let note = '';

  switch (checkId) {
    case 'liquidityClusterBelow':
      if (liq.below != null) prices.push('Liquidity below: ' + fmt(liq.below));
      prices.push('Current price: ' + fmt(cp));
      if (liq.below != null && cp != null) note = 'Distance: ' + ((cp - liq.below) / cp * 100).toFixed(2) + '%';
      break;
    case 'liquidityClusterAbove':
      if (liq.above != null) prices.push('Liquidity above: ' + fmt(liq.above));
      prices.push('Current price: ' + fmt(cp));
      if (liq.above != null && cp != null) note = 'Distance: ' + ((liq.above - cp) / cp * 100).toFixed(2) + '%';
      break;
    case 'structureShiftBull':
    case 'structureShiftBear':
      prices.push('Price: ' + fmt(cp));
      note = 'BOS in last 20 bars';
      break;
    case 'poiBullExists': {
      const poiBull = orderBlocks.find(b => b.type === 'BULL') || fvgs.find(f => f.type === 'BULL');
      if (poiBull) prices.push('POI zone: ' + fmt(Math.min(poiBull.top, poiBull.bottom)) + ' – ' + fmt(Math.max(poiBull.top, poiBull.bottom)));
      prices.push('Price: ' + fmt(cp));
      break;
    }
    case 'poiBearExists': {
      const poiBear = orderBlocks.find(b => b.type === 'BEAR') || fvgs.find(f => f.type === 'BEAR');
      if (poiBear) prices.push('POI zone: ' + fmt(Math.min(poiBear.top, poiBear.bottom)) + ' – ' + fmt(Math.max(poiBear.top, poiBear.bottom)));
      prices.push('Price: ' + fmt(cp));
      break;
    }
    case 'liquiditySweepBelow':
    case 'sell_side_draw':
      if (liq.below != null) prices.push('Swept level: ' + fmt(liq.below));
      prices.push('Price (recovered): ' + fmt(cp));
      break;
    case 'liquiditySweepAbove':
    case 'buy_side_draw':
      if (liq.above != null) prices.push('Swept level: ' + fmt(liq.above));
      prices.push('Price (recovered): ' + fmt(cp));
      break;
    case 'priceAtPOI':
    case 'priceAtBullFVG':
    case 'priceAtBearFVG':
    case 'priceAtBullOB':
    case 'priceAtBearOB':
      const zone = orderBlocks.find(b => (checkId.includes('Bull') && b.type === 'BULL') || (checkId.includes('Bear') && b.type === 'BEAR')) || fvgs.find(f => (checkId.includes('Bull') && f.type === 'BULL') || (checkId.includes('Bear') && f.type === 'BEAR'));
      if (zone) prices.push('Zone: ' + fmt(Math.min(zone.top, zone.bottom)) + ' – ' + fmt(Math.max(zone.top, zone.bottom)));
      prices.push('Price: ' + fmt(cp));
      break;
    case 'entryConfirmation':
      const last = analysis.closes && analysis.closes.length ? analysis.closes[analysis.closes.length - 1] : cp;
      prices.push('Price: ' + fmt(last));
      break;
    case 'targetAtLiquidityAbove':
      if (liq.above != null) prices.push('Target: ' + fmt(liq.above));
      prices.push('Current: ' + fmt(cp));
      break;
    case 'targetAtLiquidityBelow':
      if (liq.below != null) prices.push('Target: ' + fmt(liq.below));
      prices.push('Current: ' + fmt(cp));
      break;
    case 'poiInDiscount':
    case 'poiInPremium':
    case 'priceInDiscount':
    case 'priceInPremium':
      if (support != null && resistance != null) prices.push('S/R: ' + fmt(support) + ' – ' + fmt(resistance));
      prices.push('Price: ' + fmt(cp));
      break;
    case 'accumulationIdentified':
    case 'distributionIdentified':
      prices.push('Price: ' + fmt(cp));
      break;
    case 'manipulationSweep':
    case 'manipulationSweepUp':
      const lookback = Math.min(30, Math.floor((analysis.highs?.length || 0) / 2));
      const lows = analysis.lows || [];
      const highs = analysis.highs || [];
      const rLow = lows.length ? Math.min(...lows.slice(-lookback)) : null;
      const rHigh = highs.length ? Math.max(...highs.slice(-lookback)) : null;
      if (checkId === 'manipulationSweep' && rLow != null) prices.push('Range low: ' + fmt(rLow));
      if (checkId === 'manipulationSweepUp' && rHigh != null) prices.push('Range high: ' + fmt(rHigh));
      prices.push('Price: ' + fmt(cp));
      break;
    case 'reversalCandleBull':
    case 'reversalCandleBear':
      prices.push('Price: ' + fmt(cp));
      break;
    case 'fvgBullPresent':
    case 'fvgBearPresent':
    case 'fvgInDiscount':
    case 'fvgInPremium':
    case 'inverseFVGAfterSweep':
    case 'bearishFVGAfterSweep':
    case 'entryAtFVG':
    case 'entryAtBearFVG':
      const fvg = fvgs.find(f => f.type === 'BULL' || f.type === 'BEAR');
      if (fvg) prices.push('FVG: ' + fmt(Math.min(fvg.top, fvg.bottom)) + ' – ' + fmt(Math.max(fvg.top, fvg.bottom)));
      prices.push('Price: ' + fmt(cp));
      break;
    case 'obBullPresent':
    case 'obBearPresent':
      const ob = orderBlocks.find(b => b.type === 'BULL' || b.type === 'BEAR');
      if (ob) prices.push('OB: ' + fmt(Math.min(ob.top, ob.bottom)) + ' – ' + fmt(Math.max(ob.top, ob.bottom)));
      prices.push('Price: ' + fmt(cp));
      break;
    case 'fvgObStackBull':
    case 'fvgObStackBear':
      const ob2 = orderBlocks[0];
      const fvg2 = fvgs[0];
      if (ob2) prices.push('OB: ' + fmt(Math.min(ob2.top, ob2.bottom)) + ' – ' + fmt(Math.max(ob2.top, ob2.bottom)));
      if (fvg2) prices.push('FVG: ' + fmt(Math.min(fvg2.top, fvg2.bottom)) + ' – ' + fmt(Math.max(fvg2.top, fvg2.bottom)));
      prices.push('Price: ' + fmt(cp));
      break;
    default:
      prices.push('Price: ' + fmt(cp));
  }

  return { prices: prices.filter(Boolean), note };
}

// FIX #6: Raise threshold from 2 to 3 — only show setups with meaningful confluence
/**
 * Score scenarios for a coin. Returns array of { scenarioId, name, direction, score, totalPhases, ready, phases }
 * Each phase now includes priceDetails: { prices: string[], note?: string }
 */
function scoreScenariosForCoin(candles, analysis) {
  const { getAllScenarios } = require('./scenario-definitions');
  const scenarios = [];
  for (const def of getAllScenarios()) {
    const result = evaluateScenario(candles, analysis, def.id);
    if (result.score >= 3) {
      const phasesWithPrices = result.phases.map(p => {
        const details = getPhasePriceDetails(p.check, analysis);
        return { ...p, priceDetails: details };
      });
      scenarios.push({
        scenarioId: def.id,
        name: def.name,
        direction: def.direction,
        score: result.score,
        totalPhases: result.phases.length,
        ready: result.ready,
        phases: phasesWithPrices
      });
    }
  }
  return scenarios.sort((a, b) => b.score - a.score);
}

module.exports = {
  evaluateScenario,
  runCheck,
  scoreScenariosForCoin,
  recentStructureShift,
  getPhasePriceDetails
};
