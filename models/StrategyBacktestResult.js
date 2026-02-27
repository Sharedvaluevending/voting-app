// models/StrategyBacktestResult.js
// ====================================================
// Backtest results for Strategy Builder configs
// ====================================================

const mongoose = require('mongoose');

const strategyBacktestResultSchema = new mongoose.Schema({
  strategyConfigId: { type: mongoose.Schema.Types.ObjectId, ref: 'StrategyConfig', index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  coinId: { type: String, required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  timeframe: { type: String, default: '1h' },
  totalTrades: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  winRate: { type: Number, default: 0 },
  totalPnl: { type: Number, default: 0 },
  totalPnlPercent: { type: Number, default: 0 },
  maxDrawdown: { type: Number, default: 0 },
  maxDrawdownPct: { type: Number, default: 0 },
  profitFactor: { type: Number, default: 0 },
  initialBalance: { type: Number, default: 10000 },
  finalBalance: { type: Number, default: 10000 },
  trades: [{ type: mongoose.Schema.Types.Mixed }],
  equityCurve: [{ type: mongoose.Schema.Types.Mixed }],
  createdAt: { type: Date, default: Date.now }
});

strategyBacktestResultSchema.index({ userId: 1, strategyConfigId: 1, coinId: 1 });

module.exports = mongoose.model('StrategyBacktestResult', strategyBacktestResultSchema);
