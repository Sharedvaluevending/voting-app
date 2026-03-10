// models/SetupBacktestResult.js
// ====================================================
// Backtest results for SMC setups
// ====================================================

const mongoose = require('mongoose');

const setupBacktestResultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  setupId: { type: String, required: true, index: true },
  coinId: { type: String, required: true, index: true },
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

setupBacktestResultSchema.index({ userId: 1, setupId: 1, coinId: 1 });
setupBacktestResultSchema.index({ setupId: 1, createdAt: -1 });

module.exports = mongoose.model('SetupBacktestResult', setupBacktestResultSchema);
