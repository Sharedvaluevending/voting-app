const mongoose = require('mongoose');

/**
 * Stores massive backtest results so they persist through platform resets.
 * Reset operations (account reset, full platform reset) do NOT delete this collection.
 */
const backtestResultSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  monthRanges: { type: Number },
  top10: [{ type: mongoose.Schema.Types.Mixed }],
  allCoins: [{ type: mongoose.Schema.Types.Mixed }],
  // Full payload for compatibility with file format
  payload: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

backtestResultSchema.index({ createdAt: -1 });

module.exports = mongoose.model('BacktestResult', backtestResultSchema);
