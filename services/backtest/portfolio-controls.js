// services/backtest/portfolio-controls.js
// ====================================================
// PORTFOLIO & RISK CONTROLS
// Max concurrent trades, symbol exposure, correlated exposure,
// daily loss limit, kill switch
// ====================================================

/**
 * Check if we can open a new trade given portfolio state
 */
function canOpenTrade(state, config) {
  config = config || {};
  const openTrades = state.openTrades || [];
  const maxConcurrent = config.maxConcurrentTrades ?? 3;
  const maxSymbolExposure = config.maxSymbolExposure ?? 1;
  const killSwitch = state.killSwitch ?? false;
  const dailyLossLimit = config.dailyLossLimit;
  const initialBalance = config.initialBalance ?? 10000;

  if (killSwitch) return { ok: false, reason: 'Kill switch active' };
  if (openTrades.length >= maxConcurrent) return { ok: false, reason: 'Max concurrent trades reached' };

  if (dailyLossLimit != null && state.equity != null) {
    const dailyStart = state.dailyStartEquity ?? state.equity;
    const dailyLoss = ((dailyStart - state.equity) / dailyStart) * 100;
    if (dailyLoss >= dailyLossLimit) return { ok: false, reason: 'Daily loss limit hit' };
  }

  return { ok: true };
}

/**
 * Check symbol exposure (how many trades per symbol)
 */
function getSymbolExposure(openTrades) {
  const bySymbol = {};
  for (const t of openTrades) {
    const s = t.coinId || t.symbol;
    bySymbol[s] = (bySymbol[s] || 0) + 1;
  }
  return bySymbol;
}

/**
 * Check if adding a trade would exceed max symbol exposure
 */
function wouldExceedSymbolExposure(openTrades, coinId, maxPerSymbol) {
  maxPerSymbol = maxPerSymbol ?? 1;
  const bySymbol = getSymbolExposure(openTrades);
  const current = bySymbol[coinId] || 0;
  return current >= maxPerSymbol;
}

/**
 * Compute BTC beta / correlated exposure (simplified: sum of BTC-like exposure)
 */
function getCorrelatedExposure(openTrades, btcCandles) {
  if (!btcCandles || openTrades.length === 0) return 0;
  return openTrades.filter(t => t.coinId === 'bitcoin').length;
}

/**
 * Check daily loss limit
 */
function checkDailyLossLimit(state, config) {
  const limit = config.dailyLossLimit;
  if (limit == null) return false;
  const dailyStart = state.dailyStartEquity ?? state.equity;
  if (dailyStart <= 0) return false;
  const dailyLossPct = ((dailyStart - state.equity) / dailyStart) * 100;
  return dailyLossPct >= limit;
}

/**
 * Activate kill switch
 */
function activateKillSwitch(state) {
  return { ...state, killSwitch: true };
}

/**
 * Reset daily equity at start of new day (call when bar crosses midnight)
 */
function maybeResetDaily(state, barTimestamp) {
  const lastReset = state.lastDailyReset ?? 0;
  const dayMs = 24 * 60 * 60 * 1000;
  const lastDay = Math.floor(lastReset / dayMs);
  const barDay = Math.floor(barTimestamp / dayMs);
  if (barDay > lastDay) {
    return {
      ...state,
      dailyStartEquity: state.equity,
      lastDailyReset: barTimestamp
    };
  }
  return state;
}

module.exports = {
  canOpenTrade,
  getSymbolExposure,
  wouldExceedSymbolExposure,
  getCorrelatedExposure,
  checkDailyLossLimit,
  activateKillSwitch,
  maybeResetDaily
};
