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
      { $set: { weights: strategy.weights, description: strategy.description, active: true }, $setOnInsert: { name: strategy.name } },
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
  const isLoss = trade.pnl < 0;
  const regime = trade.regime || 'unknown';

  strategy.performance.totalTrades += 1;
  if (isWin) {
    strategy.performance.wins += 1;
  } else if (isLoss) {
    strategy.performance.losses += 1;
  }
  // Breakeven trades (pnl === 0) count toward totalTrades but NOT wins or losses

  const total = strategy.performance.totalTrades;
  strategy.performance.winRate = total > 0 ? (strategy.performance.wins / total) * 100 : 0;

  if (trade.pnl !== 0 && trade.margin && trade.margin > 0.01) {
    const rr = Math.min(Math.abs(trade.pnl / trade.margin), 100); // Cap at 100R to prevent outlier corruption
    strategy.performance.avgRR =
      ((strategy.performance.avgRR * (total - 1)) + rr) / total;
  }

  // Only record known regimes that exist in the schema
  const VALID_REGIMES = ['trending', 'ranging', 'volatile', 'compression', 'mixed'];
  if (regime && regime !== 'unknown' && VALID_REGIMES.includes(regime)) {
    if (!strategy.performance.byRegime[regime]) {
      strategy.performance.byRegime[regime] = { wins: 0, losses: 0 };
    }
    if (isWin) strategy.performance.byRegime[regime].wins += 1;
    else if (isLoss) strategy.performance.byRegime[regime].losses += 1;
  }

  strategy.updatedAt = new Date();
  strategy.markModified('performance');
  await strategy.save();
}

// Regime-aware strategy selection: prefer strategies that perform well in current regime
function selectBestStrategy(scores, regime, strategies) {
  let bestId = 'trend_follow';
  let bestScore = -Infinity;

  for (const [stratId, score] of Object.entries(scores)) {
    let adjustedScore = score;

    // If we have regime performance data, adjust score based on regime win rate
    if (strategies && regime && regime !== 'unknown') {
      const strat = strategies.find(s => s.strategyId === stratId || s.id === stratId);
      if (strat && strat.performance && strat.performance.byRegime && strat.performance.byRegime[regime]) {
        const regimeData = strat.performance.byRegime[regime];
        const total = (regimeData.wins || 0) + (regimeData.losses || 0);
        if (total >= 5) {
          const winRate = regimeData.wins / total;
          // Boost strategies with >55% win rate in this regime, penalize <40%
          if (winRate > 0.55) adjustedScore += 5;
          else if (winRate < 0.40) adjustedScore -= 5;
        }
      }
    }

    if (adjustedScore > bestScore) {
      bestScore = adjustedScore;
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

    // Calculate profit factor: gross profit / gross loss
    const wins = strategy.performance.wins || 0;
    const losses = strategy.performance.losses || 0;
    const grossProfit = wins * avgRR;
    const grossLoss = losses * 1; // normalize to 1R
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

    // Combined decision: use both expectancy and profit factor
    if ((expectancy < -0.3 || profitFactor < 0.5) && strategy.performance.totalTrades > 20) {
      // Strongly negative — faster decay
      const adjustment = 0.90;
      for (const key of Object.keys(strategy.weights)) {
        strategy.weights[key] = Math.max(5, Math.round(strategy.weights[key] * adjustment));
      }
    } else if ((expectancy < 0 || profitFactor < 0.8) && strategy.performance.totalTrades > 15) {
      // Mildly negative — moderate decay
      const adjustment = 0.95;
      for (const key of Object.keys(strategy.weights)) {
        strategy.weights[key] = Math.max(5, Math.round(strategy.weights[key] * adjustment));
      }
    } else if (expectancy > 1.0 && profitFactor > 2.0) {
      // Strongly positive — boost faster
      const adjustment = 1.05;
      for (const key of Object.keys(strategy.weights)) {
        strategy.weights[key] = Math.min(45, Math.round(strategy.weights[key] * adjustment));
      }
    } else if (expectancy > 0.3 && profitFactor > 1.2) {
      // Mildly positive — steady growth
      const adjustment = 1.02;
      for (const key of Object.keys(strategy.weights)) {
        strategy.weights[key] = Math.min(40, Math.round(strategy.weights[key] * adjustment));
      }
    }

    // Normalize weights back to 100 to prevent drift
    const weightTotal = Object.values(strategy.weights).reduce((a, b) => a + b, 0);
    if (weightTotal > 0 && weightTotal !== 100) {
      for (const key of Object.keys(strategy.weights)) {
        strategy.weights[key] = Math.max(5, Math.round((strategy.weights[key] / weightTotal) * 100));
      }
      // Fix rounding drift by adjusting the largest weight
      const newTotal = Object.values(strategy.weights).reduce((a, b) => a + b, 0);
      if (newTotal !== 100) {
        const largestKey = Object.entries(strategy.weights).sort((a, b) => b[1] - a[1])[0][0];
        strategy.weights[largestKey] += (100 - newTotal);
      }
    }

    // Store profit factor for reporting
    strategy.performance.profitFactor = Math.round(profitFactor * 100) / 100;
    strategy.updatedAt = new Date();
    strategy.markModified('weights');
    strategy.markModified('performance');
    await strategy.save();
  }
}

async function resetStrategyWeights() {
  for (const strategy of DEFAULT_STRATEGIES) {
    await StrategyWeight.findOneAndUpdate(
      { strategyId: strategy.strategyId },
      {
        $set: {
          weights: strategy.weights,
          description: strategy.description,
          'performance.totalTrades': 0,
          'performance.wins': 0,
          'performance.losses': 0,
          'performance.winRate': 0,
          'performance.avgRR': 0,
          'performance.profitFactor': 0,
          'performance.avgScore': 0,
          'performance.byRegime': {
            trending: { wins: 0, losses: 0 },
            ranging: { wins: 0, losses: 0 },
            volatile: { wins: 0, losses: 0 },
            compression: { wins: 0, losses: 0 },
            mixed: { wins: 0, losses: 0 }
          },
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  }
  console.log('[Learning] Strategy weights and performance reset to defaults');
}

async function getPerformanceReport() {
  const strategies = await StrategyWeight.find({}).lean();
  return strategies.map(s => {
    const perf = s.performance || {};
    return {
      id: s.strategyId,
      name: s.name,
      winRate: (perf.winRate || 0).toFixed(1),
      avgRR: (perf.avgRR || 0).toFixed(2),
      totalTrades: perf.totalTrades || 0,
      byRegime: perf.byRegime || {}
    };
  });
}

module.exports = {
  initializeStrategies,
  getActiveStrategies,
  recordTradeOutcome,
  selectBestStrategy,
  adjustWeights,
  getPerformanceReport,
  resetStrategyWeights
};
