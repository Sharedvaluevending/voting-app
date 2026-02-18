// services/monte-carlo.js
// ====================================================
// MONTE CARLO SIMULATION
// Bootstrap trade returns to simulate equity paths and risk of ruin
// ====================================================

const { computeDrawdownAnalysis } = require('./analytics');

/**
 * Run Monte Carlo simulation by bootstrapping trade returns
 * @param {Array} closedTrades - Trades with pnl and margin
 * @param {number} initialBalance
 * @param {Object} options - { paths: 1000, horizonTrades: 50, ruinThresholds: [0.2, 0.5] }
 * @returns {Object} - { paths, percentiles, maxDrawdownDistribution, riskOfRuin }
 */
function runMonteCarlo(closedTrades, initialBalance, options = {}) {
  const paths = options.paths ?? 1000;
  const horizonTrades = options.horizonTrades ?? 50;
  const ruinThresholds = options.ruinThresholds ?? [0.2, 0.5];

  const returns = closedTrades
    .filter(t => t.margin > 0 && t.pnl != null)
    .map(t => (t.pnl || 0) / t.margin);

  if (returns.length < 5) {
    return {
      error: 'Need at least 5 closed trades with margin for Monte Carlo',
      paths: [],
      percentiles: null,
      maxDrawdownDistribution: null,
      riskOfRuin: null
    };
  }

  const pathEquityCurves = [];
  const pathMaxDrawdowns = [];
  const pathMaxDrawdownPcts = [];

  for (let p = 0; p < paths; p++) {
    let equity = initialBalance;
    const curve = [{ date: 0, equity, drawdown: 0, drawdownPct: 0 }];
    let peak = equity;

    for (let i = 0; i < horizonTrades; i++) {
      const idx = Math.floor(Math.random() * returns.length);
      const ret = returns[idx];
      const pnl = (equity * 0.02) * ret;
      equity += pnl;
      if (equity <= 0) equity = 0.01;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
      curve.push({ date: i + 1, equity, drawdown: dd, drawdownPct: ddPct });
    }

    pathEquityCurves.push(curve);
    const ddAnalysis = computeDrawdownAnalysis(curve);
    pathMaxDrawdowns.push(ddAnalysis.maxDrawdown);
    pathMaxDrawdownPcts.push(ddAnalysis.maxDrawdownPct);
  }

  const finalEquities = pathEquityCurves.map(c => c[c.length - 1].equity);
  const sorted = [...finalEquities].sort((a, b) => a - b);

  const percentile = (arr, p) => {
    const idx = Math.max(0, Math.min(arr.length - 1, Math.floor((p / 100) * arr.length)));
    return arr[idx];
  };

  const percentiles = {
    p5: Math.round(percentile(sorted, 5) * 100) / 100,
    p25: Math.round(percentile(sorted, 25) * 100) / 100,
    p50: Math.round(percentile(sorted, 50) * 100) / 100,
    p75: Math.round(percentile(sorted, 75) * 100) / 100,
    p95: Math.round(percentile(sorted, 95) * 100) / 100
  };

  const sortedDD = [...pathMaxDrawdownPcts].sort((a, b) => a - b);
  const maxDrawdownDistribution = {
    p50: Math.round(percentile(sortedDD, 50) * 100) / 100,
    p75: Math.round(percentile(sortedDD, 75) * 100) / 100,
    p90: Math.round(percentile(sortedDD, 90) * 100) / 100,
    p95: Math.round(percentile(sortedDD, 95) * 100) / 100
  };

  const riskOfRuin = {};
  for (const thresh of ruinThresholds) {
    const pctThresh = thresh * 100;
    const count = pathMaxDrawdownPcts.filter(dd => dd >= pctThresh).length;
    riskOfRuin[`${Math.round(thresh * 100)}%`] = Math.round((count / paths) * 1000) / 10;
  }

  return {
    paths: pathEquityCurves.slice(0, 20),
    percentiles,
    maxDrawdownDistribution,
    riskOfRuin,
    sampleSize: returns.length,
    pathsRun: paths
  };
}

module.exports = { runMonteCarlo };
