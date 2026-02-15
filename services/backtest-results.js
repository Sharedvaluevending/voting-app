// services/backtest-results.js
// ====================================================
// Backtest results storage — DB first (persists through resets), fallback to files.
// Reset operations do NOT delete BacktestResult collection.
// ====================================================

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, '..', 'data', 'backtest-results');

/**
 * Transform runBacktest API output to backtest-results page format
 */
function transformBacktestToResultFormat(apiResult) {
  const results = (apiResult.results || []).filter(r => !r.error);
  const days = apiResult.startMs && apiResult.endMs
    ? Math.round((apiResult.endMs - apiResult.startMs) / (24 * 60 * 60 * 1000))
    : 0;
  const monthRanges = Math.round(days / 30) || 1;

  // Build allCoins with strategyBreakdown
  const allCoins = results.map(r => ({
    coinId: r.coinId,
    symbol: r.symbol || r.coinId,
    totalPnl: r.totalPnl || 0,
    winRate: r.winRate || 0,
    totalTrades: r.totalTrades || 0,
    returnPct: r.returnPct,
    profitFactor: r.profitFactor,
    maxDrawdownPct: r.maxDrawdownPct,
    sharpeRatio: r.sharpeRatio,
    strategyBreakdown: r.strategyBreakdown || {}
  }));

  // Top 10 by composite (totalPnl primary, then winRate)
  const top10 = [...allCoins]
    .sort((a, b) => (b.totalPnl || 0) - (a.totalPnl || 0))
    .slice(0, 10)
    .map(c => ({
      symbol: c.symbol,
      totalPnl: c.totalPnl,
      winRate: c.winRate,
      profitFactor: c.profitFactor,
      maxDrawdownPct: c.maxDrawdownPct,
      sharpeRatio: c.sharpeRatio,
      returnPct: c.returnPct
    }));

  return {
    timestamp: new Date().toISOString(),
    monthRanges,
    top10,
    allCoins,
    summary: apiResult.summary,
    startMs: apiResult.startMs,
    endMs: apiResult.endMs
  };
}

/**
 * Get latest backtest result: DB first, then files. When loading from files, save to DB.
 */
async function getLatestBacktestResult() {
  try {
    const BacktestResult = require('../models/BacktestResult');
    const latest = await BacktestResult.findOne().sort({ createdAt: -1 }).lean();
    if (latest) {
      return {
        timestamp: latest.timestamp || latest.createdAt,
        monthRanges: latest.monthRanges,
        top10: latest.top10 || [],
        allCoins: latest.allCoins || [],
        ...(latest.payload || {})
      };
    }
  } catch (e) {
    // DB not connected or model error
  }

  // Fallback: read from files
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.startsWith('massive-') && f.endsWith('.json'));
  if (files.length === 0) return null;

  const latestFile = files.sort().reverse()[0];
  const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, latestFile), 'utf8'));

  // Save to DB for future persistence (migration)
  try {
    const BacktestResult = require('../models/BacktestResult');
    await BacktestResult.create({
      timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
      monthRanges: data.monthRanges,
      top10: data.top10 || [],
      allCoins: data.allCoins || [],
      payload: data
    });
    console.log('[BacktestResults] Migrated file results to DB for persistence');
  } catch (e) {
    // Non-fatal
  }

  return data;
}

/**
 * Save backtest result to DB (from in-app backtest or API)
 */
async function saveBacktestResult(data) {
  const BacktestResult = require('../models/BacktestResult');
  const doc = await BacktestResult.create({
    timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
    monthRanges: data.monthRanges,
    top10: data.top10 || [],
    allCoins: data.allCoins || [],
    payload: data
  });
  return doc;
}

module.exports = {
  getLatestBacktestResult,
  saveBacktestResult,
  transformBacktestToResultFormat,
  RESULTS_DIR
};
