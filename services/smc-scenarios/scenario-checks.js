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

  switch (checkId) {
    case 'liquidityClusterBelow':
      return liq.below != null && currentPrice > liq.below;
    case 'liquidityClusterAbove':
      return liq.above != null && currentPrice < liq.above;
    case 'structureShiftBull':
      return ['BULLISH', 'BREAK_UP'].includes(marketStructure);
    case 'structureShiftBear':
      return ['BEARISH', 'BREAK_DOWN'].includes(marketStructure);
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
    case 'priceAtPOI':
      return priceNearOBOrFVG(analysis);
    case 'entryConfirmation':
      return lastCandleConfirmsDirection(candles, direction);
    case 'targetAtLiquidityAbove':
      return liq.above != null;
    case 'targetAtLiquidityBelow':
      return liq.below != null;
    case 'accumulationIdentified':
      return (analysis.accDist === 'ACCUMULATING' || analysis.accDist === 'NEUTRAL') && (analysis.volatilityState === 'low' || analysis.volatilityState === 'normal');
    case 'distributionIdentified':
      return (analysis.accDist === 'DISTRIBUTING' || analysis.accDist === 'NEUTRAL') && (analysis.volatilityState === 'low' || analysis.volatilityState === 'normal');
    case 'manipulationSweep':
      return detectManipulationSweep(candles, analysis, 'below');
    case 'manipulationSweepUp':
      return detectManipulationSweep(candles, analysis, 'above');
    case 'inverseFVGAfterSweep':
      return fvgFormedAfterSweep(candles, analysis, 'BULL');
    case 'bearishFVGAfterSweep':
      return fvgFormedAfterSweep(candles, analysis, 'BEAR');
    case 'entryAtFVG':
      return priceNearOBOrFVG(analysis) && fvgs.some(f => f.type === 'BULL') && lastCandleConfirmsDirection(candles, 'LONG');
    case 'entryAtBearFVG':
      return priceNearOBOrFVG(analysis) && fvgs.some(f => f.type === 'BEAR') && lastCandleConfirmsDirection(candles, 'SHORT');
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
    case 'priceAtBullOB':
      return orderBlocks.some(ob => ob.type === 'BULL' && priceNearZone(currentPrice, ob.top, ob.bottom));
    case 'priceAtBearOB':
      return orderBlocks.some(ob => ob.type === 'BEAR' && priceNearZone(currentPrice, ob.top, ob.bottom));
    case 'reversalCandleBull':
      return lastCandle && prevCandle && lastCandle.close > lastCandle.open && prevCandle.close < prevCandle.open && lastCandle.close > prevCandle.open;
    case 'reversalCandleBear':
      return lastCandle && prevCandle && lastCandle.close < lastCandle.open && prevCandle.close > prevCandle.open && lastCandle.close < prevCandle.open;
    case 'fvgObStackBull':
      return fvgs.some(f => f.type === 'BULL') && orderBlocks.some(ob => ob.type === 'BULL') && priceNearOBOrFVG(analysis);
    case 'fvgObStackBear':
      return fvgs.some(f => f.type === 'BEAR') && orderBlocks.some(ob => ob.type === 'BEAR') && priceNearOBOrFVG(analysis);
    case 'priceInDiscount':
      return posInSR < 0.5;
    case 'priceInPremium':
      return posInSR > 0.5;
    default:
      return false;
  }
}

function priceNearZone(price, top, bottom) {
  if (!top || !bottom) return false;
  const mid = (top + bottom) / 2;
  const range = Math.abs(top - bottom) || price * 0.01;
  return Math.abs(price - mid) / range < 2;
}

function priceNearFVG(analysis, type) {
  const fvgs = analysis.fvgs || [];
  const price = analysis.currentPrice;
  const match = fvgs.find(f => f.type === type);
  if (!match) return false;
  const top = Math.max(match.top, match.bottom);
  const bottom = Math.min(match.top, match.bottom);
  return price >= bottom * 0.998 && price <= top * 1.002;
}

function hasPOIInDiscount(analysis) {
  const posInSR = getPosInSR(analysis);
  if (posInSR >= 0.5) return false;
  return (analysis.orderBlocks?.some(ob => ob.type === 'BULL') || analysis.fvgs?.some(f => f.type === 'BULL')) && priceNearOBOrFVG(analysis);
}

function hasPOIInPremium(analysis) {
  const posInSR = getPosInSR(analysis);
  if (posInSR <= 0.5) return false;
  return (analysis.orderBlocks?.some(ob => ob.type === 'BEAR') || analysis.fvgs?.some(f => f.type === 'BEAR')) && priceNearOBOrFVG(analysis);
}

function getPosInSR(analysis) {
  const support = analysis.support;
  const resistance = analysis.resistance;
  const price = analysis.currentPrice;
  const range = resistance - support;
  return range > 0 ? (price - support) / range : 0.5;
}

function priceNearOBOrFVG(analysis) {
  const price = analysis.currentPrice;
  for (const ob of analysis.orderBlocks || []) {
    if (priceNearZone(price, ob.top, ob.bottom)) return true;
  }
  for (const fvg of analysis.fvgs || []) {
    const top = Math.max(fvg.top, fvg.bottom);
    const bottom = Math.min(fvg.top, fvg.bottom);
    if (price >= bottom * 0.995 && price <= top * 1.005) return true;
  }
  return false;
}

function lastCandleConfirmsDirection(candles, direction) {
  if (!candles || candles.length < 2) return false;
  const last = candles[candles.length - 1];
  const body = last.close - last.open;
  if (direction === 'LONG') return body > 0 && last.close > last.open;
  if (direction === 'SHORT') return body < 0 && last.close < last.open;
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

function fvgFormedAfterSweep(candles, analysis, fvgType) {
  const fvgs = analysis.fvgs || [];
  const hasFVG = fvgs.some(f => f.type === fvgType);
  if (!hasFVG) return false;
  if (candles.length < 10) return false;
  return true;
}

/**
 * Score scenarios for a coin. Returns array of { scenarioId, name, direction, score, totalPhases, ready, phases }
 */
function scoreScenariosForCoin(candles, analysis) {
  const { getAllScenarios } = require('./scenario-definitions');
  const scenarios = [];
  for (const def of getAllScenarios()) {
    const result = evaluateScenario(candles, analysis, def.id);
    if (result.score >= 2) {
      scenarios.push({
        scenarioId: def.id,
        name: def.name,
        direction: def.direction,
        score: result.score,
        totalPhases: result.phases.length,
        ready: result.ready,
        phases: result.phases
      });
    }
  }
  return scenarios.sort((a, b) => b.score - a.score);
}

module.exports = {
  evaluateScenario,
  runCheck,
  scoreScenariosForCoin
};
