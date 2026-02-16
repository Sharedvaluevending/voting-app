// services/analytics.js
// ====================================================
// ADVANCED ANALYTICS
// Correlation matrix, drawdown analysis, risk metrics by strategy/regime
// ====================================================

const { TRACKED_COINS, COIN_META } = require('./crypto-api');

/**
 * Compute Pearson correlation between two return series
 */
function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 5) return null;
  const xSlice = x.slice(-n);
  const ySlice = y.slice(-n);
  const meanX = xSlice.reduce((a, b) => a + b, 0) / n;
  const meanY = ySlice.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - meanX;
    const dy = ySlice[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;
  return num / den;
}

/**
 * Compute returns from price series (percent change)
 */
function priceToReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
  }
  return returns;
}

/**
 * Correlation matrix: Coin vs BTC and coin vs coin
 * candles: { coinId: { '1h': [...], '1d': [...] } }
 */
function computeCorrelationMatrix(candles) {
  const btcCandles = candles.bitcoin;
  if (!btcCandles) return { btcCorrelations: {}, coinCorrelations: {}, error: 'No BTC data' };

  const tf = btcCandles['1d'] && btcCandles['1d'].length >= 20 ? '1d' : '1h';
  const btcCloses = (btcCandles[tf] || []).map(c => c.close).filter(Boolean);
  const btcReturns = priceToReturns(btcCloses);
  if (btcReturns.length < 5) return { btcCorrelations: {}, coinCorrelations: {}, error: 'Insufficient BTC data' };

  const btcCorrelations = {};
  const coinCorrelations = {};

  for (const coinId of TRACKED_COINS) {
    if (coinId === 'bitcoin') continue;
    const c = candles[coinId];
    if (!c || !c[tf] || c[tf].length < 5) continue;
    const closes = c[tf].map(x => x.close).filter(Boolean);
    const returns = priceToReturns(closes);
    const corr = pearsonCorrelation(btcReturns, returns);
    if (corr != null) {
      btcCorrelations[COIN_META[coinId]?.symbol || coinId] = Math.round(corr * 100) / 100;
    }
  }

  // Coin vs coin (top 5 alts vs each other for brevity)
  const symbols = Object.keys(btcCorrelations).slice(0, 6);
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const coinIdA = Object.keys(COIN_META).find(k => COIN_META[k].symbol === symbols[i]);
      const coinIdB = Object.keys(COIN_META).find(k => COIN_META[k].symbol === symbols[j]);
      if (!coinIdA || !coinIdB) continue;
      const ca = candles[coinIdA]?.[tf];
      const cb = candles[coinIdB]?.[tf];
      if (!ca || !cb || ca.length < 5 || cb.length < 5) continue;
      const retA = priceToReturns(ca.map(x => x.close));
      const retB = priceToReturns(cb.map(x => x.close));
      const corr = pearsonCorrelation(retA, retB);
      if (corr != null) {
        const key = `${symbols[i]}-${symbols[j]}`;
        coinCorrelations[key] = Math.round(corr * 100) / 100;
      }
    }
  }

  return { btcCorrelations, coinCorrelations, timeframe: tf };
}

/**
 * Drawdown analysis: max drawdown, recovery time, underwater periods
 * equityCurve: [{ date, equity, drawdown, drawdownPct }, ...]
 */
function computeDrawdownAnalysis(equityCurve) {
  if (!equityCurve || equityCurve.length < 2) {
    return { maxDrawdown: 0, maxDrawdownPct: 0, avgRecoveryHours: null, underwaterPeriods: [], longestUnderwaterHours: null };
  }

  let peak = equityCurve[0].equity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let troughIdx = -1;
  let peakIdx = -1;

  for (let i = 1; i < equityCurve.length; i++) {
    const e = equityCurve[i].equity;
    if (e > peak) {
      peak = e;
      peakIdx = i;
    }
    const dd = peak - e;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPct = ddPct;
      troughIdx = i;
    }
  }

  // Recovery time: from trough to next peak (hours)
  const recoveryTimes = [];
  let inDrawdown = false;
  let drawdownStart = null;
  let drawdownPeak = null;
  const underwaterPeriods = [];

  for (let i = 0; i < equityCurve.length; i++) {
    const eq = equityCurve[i].equity;
    const dt = equityCurve[i].date ? new Date(equityCurve[i].date).getTime() : 0;

    if (!inDrawdown) {
      if (drawdownPeak == null || eq > drawdownPeak) drawdownPeak = eq;
      if (eq < drawdownPeak * 0.99) {
        inDrawdown = true;
        drawdownStart = { idx: i, equity: eq, date: dt };
      }
    } else {
      if (eq >= drawdownPeak) {
        const recoveryMs = dt - drawdownStart.date;
        recoveryTimes.push(recoveryMs / (1000 * 60 * 60));
        underwaterPeriods.push({
          start: drawdownStart.date,
          end: dt,
          depth: drawdownPeak - Math.min(...equityCurve.slice(drawdownStart.idx, i + 1).map(x => x.equity)),
          depthPct: drawdownPeak > 0 ? ((drawdownPeak - Math.min(...equityCurve.slice(drawdownStart.idx, i + 1).map(x => x.equity))) / drawdownPeak) * 100 : 0
        });
        inDrawdown = false;
        drawdownPeak = eq;
      }
    }
  }

  const avgRecoveryHours = recoveryTimes.length > 0
    ? Math.round((recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length) * 10) / 10
    : null;
  const longestUnderwaterHours = underwaterPeriods.length > 0
    ? Math.round(Math.max(...underwaterPeriods.map(p => (p.end - p.start) / (1000 * 60 * 60))) * 10) / 10
    : null;

  return {
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    avgRecoveryHours,
    underwaterPeriods: underwaterPeriods.slice(-10),
    longestUnderwaterHours,
    recoveryTimes
  };
}

/**
 * Risk metrics for a set of returns: Sharpe, Sortino, Calmar, profit factor
 */
function computeRiskMetrics(returns, equityCurve, initialBalance) {
  if (!returns || returns.length < 2) {
    return { sharpe: null, sortino: null, calmar: null, profitFactor: null };
  }
  const meanRet = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (returns.length - 1);
  const stdRet = Math.sqrt(variance);
  const downsideReturns = returns.filter(r => r < 0);
  const downsideVar = downsideReturns.length > 0
    ? downsideReturns.reduce((s, r) => s + r * r, 0) / downsideReturns.length
    : 0;
  const downsideStd = Math.sqrt(downsideVar);

  const sharpe = stdRet > 0 ? meanRet / stdRet : (meanRet >= 0 ? 99 : -99);
  const sortino = downsideStd > 0 ? meanRet / downsideStd : (meanRet >= 0 ? 99 : -99);

  let calmar = null;
  if (equityCurve && equityCurve.length >= 2 && initialBalance > 0) {
    const lastEquity = equityCurve[equityCurve.length - 1].equity;
    const totalReturn = (lastEquity - initialBalance) / initialBalance;
    const dd = computeDrawdownAnalysis(equityCurve);
    if (dd.maxDrawdownPct > 0) {
      calmar = (totalReturn * 100) / dd.maxDrawdownPct;
    }
  }

  const grossProfit = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

  return {
    sharpe: Math.round(sharpe * 100) / 100,
    sortino: Math.round(sortino * 100) / 100,
    calmar: calmar != null ? Math.round(calmar * 100) / 100 : null,
    profitFactor: Math.round(profitFactor * 100) / 100
  };
}

/**
 * Risk metrics by strategy and by regime
 */
function computeRiskMetricsByStrategyAndRegime(closedTrades, initialBalance, equityCurve) {
  const byStrategy = {};
  const byRegime = {};

  const addMetrics = (bucket, trades, label) => {
    if (trades.length < 2) return;
    const returns = trades.filter(t => t.margin > 0).map(t => (t.pnl || 0) / t.margin);
    const subCurve = [];
    let eq = initialBalance;
    const sorted = [...trades].filter(t => t.exitTime).sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
    for (const t of sorted) {
      eq += t.pnl || 0;
      subCurve.push({ date: t.exitTime, equity: eq });
    }
    bucket[label] = {
      trades: trades.length,
      wins: trades.filter(t => t.pnl > 0).length,
      pnl: trades.reduce((s, t) => s + (t.pnl || 0), 0),
      ...computeRiskMetrics(returns, subCurve.length >= 2 ? subCurve : null, initialBalance)
    };
  };

  for (const t of closedTrades) {
    const strat = t.strategyType || 'unknown';
    const regime = t.regime || 'unknown';
    if (!byStrategy[strat]) byStrategy[strat] = [];
    if (!byRegime[regime]) byRegime[regime] = [];
    byStrategy[strat].push(t);
    byRegime[regime].push(t);
  }

  const stratResult = {};
  const regimeResult = {};
  Object.keys(byStrategy).forEach(s => addMetrics(stratResult, byStrategy[s], s));
  Object.keys(byRegime).forEach(r => addMetrics(regimeResult, byRegime[r], r));

  return { byStrategy: stratResult, byRegime: regimeResult };
}

module.exports = {
  computeCorrelationMatrix,
  computeDrawdownAnalysis,
  computeRiskMetrics,
  computeRiskMetricsByStrategyAndRegime
};
