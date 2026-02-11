// services/learning-engine.js
// ====================================================
// LEARNING ENGINE - Tracks outcomes, adjusts strategy weights
// Records what works, what fails, and in which market regime.
// Adjusts scoring weights over time based on performance.
// ====================================================

const StrategyWeight = require('../models/StrategyWeight');
const Trade = require('../models/Trade');

const DEFAULT_STRATEGIES = [
  {
    strategyId: 'trend_follow',
    name: 'Trend Following',
    description: 'Rides established trends using EMA alignment and ADX',
    weights: { trend: 30, momentum: 25, volume: 15, structure: 15, volatility: 10, riskQuality: 5 }
  },
  {
    strategyId: 'breakout',
    name: 'Breakout',
    description: 'Catches volatility expansion from compression zones',
    weights: { trend: 15, momentum: 20, volume: 25, structure: 20, volatility: 15, riskQuality: 5 }
  },
  {
    strategyId: 'mean_revert',
    name: 'Mean Reversion',
    description: 'Fades extremes back to value zones',
    weights: { trend: 10, momentum: 25, volume: 20, structure: 15, volatility: 20, riskQuality: 10 }
  },
  {
    strategyId: 'momentum',
    name: 'Momentum',
    description: 'Follows strong directional moves with volume confirmation',
    weights: { trend: 20, momentum: 30, volume: 20, structure: 10, volatility: 10, riskQuality: 10 }
  },
  {
    strategyId: 'scalping',
    name: 'Scalping',
    description: 'Short-term 15m/1H: needs volatility and volume for quick entries',
    weights: { trend: 5, momentum: 20, volume: 20, structure: 15, volatility: 25, riskQuality: 15 }
  },
  {
    strategyId: 'swing',
    name: 'Swing',
    description: 'Multi-day 4H/1D: trend and structure on higher timeframes',
    weights: { trend: 30, momentum: 25, volume: 15, structure: 20, volatility: 5, riskQuality: 5 }
  },
  {
    strategyId: 'position',
    name: 'Position',
    description: 'Long-term 1D/1W: macro trend and daily structure',
    weights: { trend: 35, momentum: 20, volume: 15, structure: 20, volatility: 5, riskQuality: 5 }
  }
];

async function initializeStrategies() {
  for (const strategy of DEFAULT_STRATEGIES) {
    await StrategyWeight.findOneAndUpdate(
      { strategyId: strategy.strategyId },
      { $set: { weights: strategy.weights, description: strategy.description }, $setOnInsert: { name: strategy.name } },
      { upsert: true, new: true }
    );
  }
  console.log('[Learning] Strategies initialized/updated');
}

async function getActiveStrategies() {
  let strategies = await StrategyWeight.find({ active: true }).lean();
  if (strategies.length === 0) {
    await initializeStrategies();
    strategies = await StrategyWeight.find({ active: true }).lean();
  }
  return strategies;
}

async function recordTradeOutcome(trade) {
  if (!trade.strategyType) return;

  const strategy = await StrategyWeight.findOne({ strategyId: trade.strategyType });
  if (!strategy) return;

  const isWin = trade.pnl > 0;
  const regime = trade.regime || 'unknown';

  strategy.performance.totalTrades += 1;
  if (isWin) {
    strategy.performance.wins += 1;
  } else {
    strategy.performance.losses += 1;
  }

  const total = strategy.performance.totalTrades;
  strategy.performance.winRate = (strategy.performance.wins / total) * 100;

  if (trade.pnl && trade.margin) {
    const rr = Math.abs(trade.pnl / trade.margin);
    strategy.performance.avgRR =
      ((strategy.performance.avgRR * (total - 1)) + rr) / total;
  }

  if (regime && regime !== 'unknown') {
    if (!strategy.performance.byRegime[regime]) {
      strategy.performance.byRegime[regime] = { wins: 0, losses: 0 };
    }
    if (isWin) strategy.performance.byRegime[regime].wins += 1;
    else strategy.performance.byRegime[regime].losses += 1;
  }

  strategy.updatedAt = new Date();
  await strategy.save();
}

function selectBestStrategy(scores, regime) {
  let bestId = 'trend_follow';
  let bestScore = -Infinity;

  for (const [stratId, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestId = stratId;
    }
  }

  return { strategyId: bestId, score: bestScore };
}

async function adjustWeights() {
  const strategies = await StrategyWeight.find({ active: true });

  for (const strategy of strategies) {
    if (strategy.performance.totalTrades < 10) continue;

    const winRate = strategy.performance.winRate / 100;
    const avgRR = strategy.performance.avgRR;
    const expectancy = (winRate * avgRR) - ((1 - winRate) * 1);

    if (expectancy < -0.3 && strategy.performance.totalTrades > 20) {
      // Strongly negative — faster decay
      const adjustment = 0.90;
      for (const key of Object.keys(strategy.weights)) {
        strategy.weights[key] = Math.max(5, Math.round(strategy.weights[key] * adjustment));
      }
    } else if (expectancy < 0 && strategy.performance.totalTrades > 15) {
      // Mildly negative — moderate decay
      const adjustment = 0.95;
      for (const key of Object.keys(strategy.weights)) {
        strategy.weights[key] = Math.max(5, Math.round(strategy.weights[key] * adjustment));
      }
    } else if (expectancy > 1.0) {
      // Strongly positive — boost faster
      const adjustment = 1.05;
      for (const key of Object.keys(strategy.weights)) {
        strategy.weights[key] = Math.min(45, Math.round(strategy.weights[key] * adjustment));
      }
    } else if (expectancy > 0.3) {
      // Mildly positive — steady growth
      const adjustment = 1.02;
      for (const key of Object.keys(strategy.weights)) {
        strategy.weights[key] = Math.min(40, Math.round(strategy.weights[key] * adjustment));
      }
    }

    strategy.updatedAt = new Date();
    await strategy.save();
  }
}

async function getPerformanceReport() {
  const strategies = await StrategyWeight.find({}).lean();
  return strategies.map(s => ({
    id: s.strategyId,
    name: s.name,
    winRate: s.performance.winRate.toFixed(1),
    avgRR: s.performance.avgRR.toFixed(2),
    totalTrades: s.performance.totalTrades,
    byRegime: s.performance.byRegime
  }));
}

module.exports = {
  initializeStrategies,
  getActiveStrategies,
  recordTradeOutcome,
  selectBestStrategy,
  adjustWeights,
  getPerformanceReport
};
