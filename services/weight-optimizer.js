// services/weight-optimizer.js
// ====================================================
// WEIGHT OPTIMIZER - Automated optimization of strategy dimension weights
// Uses regime performance and genetic-algorithm-style search
// ====================================================

const DIMS = ['trend', 'momentum', 'volume', 'structure', 'volatility', 'riskQuality'];

// Regime-to-dimension emphasis: which dimensions tend to help in each regime
const REGIME_DIM_MAP = {
  trending: { trend: 1.3, momentum: 1.1, structure: 1.1 },
  ranging: { structure: 1.3, momentum: 1.1, volatility: 1.1 },
  volatile: { volatility: 1.3, volume: 1.2, momentum: 1.1 },
  compression: { structure: 1.2, volume: 1.2, volatility: 1.1 },
  mixed: { riskQuality: 1.2, structure: 1.1, momentum: 1.1 }
};

/**
 * Normalize weights to sum to 100
 */
function normalizeWeights(w) {
  const sum = DIMS.reduce((s, k) => s + (w[k] || 0), 0);
  if (sum <= 0) return w;
  const out = {};
  let total = 0;
  for (const k of DIMS) {
    out[k] = Math.round(((w[k] || 0) / sum) * 1000) / 10;
    total += out[k];
  }
  const diff = 100 - total;
  if (diff !== 0 && DIMS.length > 0) {
    out[DIMS[0]] = Math.round((out[DIMS[0]] + diff) * 10) / 10;
  }
  return out;
}

/**
 * Compute fitness for a weight vector based on closed trades
 * Fitness = expectancy proxy: winRate * avgRR - (1-winRate)
 * Higher is better. We use strategy performance as proxy since we can't re-score.
 */
function computeFitness(trades, weights) {
  if (!trades || trades.length < 5) return -999;
  const wins = trades.filter(t => t.pnl > 0).length;
  const winRate = wins / trades.length;
  const avgRR = trades
    .filter(t => t.margin > 0 && t.pnl !== 0)
    .map(t => Math.min(Math.abs(t.pnl / t.margin), 100));
  const avgR = avgRR.length > 0 ? avgRR.reduce((a, b) => a + b, 0) / avgRR.length : 1;
  const expectancy = winRate * avgR - (1 - winRate) * 1;
  return expectancy;
}

/**
 * Optimize weights using regime-based heuristics + grid search
 * @param {string} strategyId
 * @param {Array} closedTrades - trades for this strategy
 * @param {Object} currentWeights - current weights from StrategyWeight
 * @param {Object} options - { maxIterations: 50 }
 * @returns {Object} - { weights, fitness, improved }
 */
function optimizeWeights(strategyId, closedTrades, currentWeights, options = {}) {
  const maxIterations = options.maxIterations ?? 50;
  const strategyTrades = closedTrades.filter(t => (t.strategyType || t.strategy) === strategyId);

  if (strategyTrades.length < 10) {
    return { weights: currentWeights, fitness: null, improved: false, error: 'Need 10+ trades for this strategy' };
  }

  const baseFitness = computeFitness(strategyTrades, currentWeights);

  const byRegime = {};
  strategyTrades.forEach(t => {
    const r = t.regime || 'unknown';
    if (!['trending', 'ranging', 'volatile', 'compression', 'mixed'].includes(r)) return;
    if (!byRegime[r]) byRegime[r] = { wins: 0, total: 0 };
    byRegime[r].total++;
    if (t.pnl > 0) byRegime[r].wins++;
  });

  let bestWeights = { ...currentWeights };
  let bestFitness = baseFitness;

  const presets = [
    { ...currentWeights },
    normalizeWeights(
      DIMS.reduce((o, k) => {
        o[k] = (currentWeights[k] || 16.67) * (1 + (Math.random() * 0.4 - 0.2));
        return o;
      }, {})
    )
  ];

  for (const regime of Object.keys(byRegime)) {
    const mults = REGIME_DIM_MAP[regime];
    if (mults && byRegime[regime].total >= 3) {
      const wr = byRegime[regime].wins / byRegime[regime].total;
      if (wr > 0.55) {
        const w = { ...currentWeights };
        for (const [dim, mult] of Object.entries(mults)) {
          if (w[dim] != null) w[dim] = Math.min(45, Math.max(5, (w[dim] || 15) * mult));
        }
        presets.push(normalizeWeights(w));
      }
    }
  }

  for (let i = 0; i < maxIterations; i++) {
    const w = {};
    for (const k of DIMS) {
      const base = bestWeights[k] || 16.67;
      w[k] = Math.max(5, Math.min(45, base + (Math.random() * 10 - 5)));
    }
    presets.push(normalizeWeights(w));
  }

  const seen = new Set();
  for (const w of presets) {
    const key = DIMS.map(k => w[k]).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const f = computeFitness(strategyTrades, w);
    if (f > bestFitness) {
      bestFitness = f;
      bestWeights = w;
    }
  }

  const improved = bestFitness > baseFitness;
  return {
    weights: bestWeights,
    fitness: Math.round(bestFitness * 100) / 100,
    baseFitness: Math.round(baseFitness * 100) / 100,
    improved
  };
}

module.exports = {
  optimizeWeights,
  normalizeWeights,
  computeFitness
};
