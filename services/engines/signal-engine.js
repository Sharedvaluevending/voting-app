// services/engines/signal-engine.js
// ====================================================
// SIGNAL ENGINE - Single source of truth for signal evaluation
// Wraps trading-engine.analyzeCoin; normalizes output to canonical decision object.
// Used by paper-trading, live, and backtest.
// ====================================================

const { analyzeCoin } = require('../trading-engine');

/**
 * Evaluate market snapshot and produce a trading decision.
 * @param {Object} snapshot - { coinData, candles, history, options }
 * @returns {Object} decision - { side, strategy, score, reasons, entry, stopLoss, takeProfit1/2/3, riskReward, regime, indicators, ... }
 */
function evaluate(snapshot) {
  const { coinData, candles, history, options } = snapshot;
  const result = analyzeCoin(coinData, candles, history || {}, options || {});

  // Map signal to side: LONG, SHORT, or null (HOLD)
  let side = null;
  if (result.signal === 'STRONG_BUY' || result.signal === 'BUY') side = 'LONG';
  else if (result.signal === 'STRONG_SELL' || result.signal === 'SELL') side = 'SHORT';

  // Pick best strategy for levels (matches runAutoTrade / backtest logic)
  let bestStrat = null;
  if (result.topStrategies && Array.isArray(result.topStrategies)) {
    for (const strat of result.topStrategies) {
      const s = strat.signal || '';
      if (s === 'STRONG_BUY' || s === 'BUY' || s === 'STRONG_SELL' || s === 'SELL') {
        if (!bestStrat || (strat.score || 0) > (bestStrat.score || 0)) {
          bestStrat = strat;
        }
      }
    }
  }

  // Use best strategy levels when direction matches; otherwise blended signal levels
  const sigDirMatches = (side === 'LONG')
    ? (result.signal === 'STRONG_BUY' || result.signal === 'BUY')
    : (result.signal === 'STRONG_SELL' || result.signal === 'SELL');
  const levelsSource = bestStrat || (sigDirMatches ? result : null);

  const coin = result.coin || coinData;
  const decision = {
    side,
    coinId: coin?.id || coinData?.id,
    symbol: coin?.symbol || coinData?.symbol || (coinData?.id || '').toUpperCase(),
    strategy: result.strategyType || (bestStrat?.id) || 'default',
    strategyName: result.strategyName || (bestStrat?.name) || 'Default',
    score: result.score ?? 0,
    strength: result.strength ?? result.score ?? 0,
    reasons: result.reasoning || [],
    signal: result.signal,
    entry: levelsSource?.entry ?? result.entry,
    stopLoss: levelsSource?.stopLoss ?? result.stopLoss,
    takeProfit1: levelsSource?.takeProfit1 ?? result.takeProfit1,
    takeProfit2: levelsSource?.takeProfit2 ?? result.takeProfit2,
    takeProfit3: levelsSource?.takeProfit3 ?? result.takeProfit3,
    riskReward: levelsSource?.riskReward ?? result.riskReward,
    regime: result.regime,
    indicators: result.indicators || {},
    scoreBreakdown: result.scoreBreakdown || {},
    topStrategies: result.topStrategies || [],
    suggestedLeverage: result.suggestedLeverage ?? 1,
    coin: result.coin,
    confluenceLevel: result.confluenceLevel,
    stopType: result.stopType,
    stopLabel: result.stopLabel,
    tpType: result.tpType,
    tpLabel: result.tpLabel,
    timestamp: result.timestamp
  };

  return decision;
}

module.exports = {
  evaluate
};
