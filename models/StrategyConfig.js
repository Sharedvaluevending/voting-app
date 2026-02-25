// models/StrategyConfig.js
// ====================================================
// Saved strategy configurations from Strategy Builder
// ====================================================

const mongoose = require('mongoose');

const strategyConfigSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  presetId: { type: String, default: null },
  timeframe: { type: String, enum: ['15m', '1h', '4h', '1d'], default: '1h' },
  entry: { type: mongoose.Schema.Types.Mixed, required: true },
  exit: { type: mongoose.Schema.Types.Mixed, required: true },
  indicators: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

strategyConfigSchema.index({ userId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('StrategyConfig', strategyConfigSchema);
