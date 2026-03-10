const mongoose = require('mongoose');

const candleCacheSchema = new mongoose.Schema({
  coinId: { type: String, required: true, index: true },
  timeframe: { type: String, required: true, index: true }, // 15m, 1h, 4h, 1d
  timestamp: { type: Number, required: true, index: true }, // unix ms
  open: { type: Number, required: true },
  high: { type: Number, required: true },
  low: { type: Number, required: true },
  close: { type: Number, required: true },
  volume: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now, index: true }
}, {
  versionKey: false
});

candleCacheSchema.index({ coinId: 1, timeframe: 1, timestamp: 1 }, { unique: true });
candleCacheSchema.index({ coinId: 1, timeframe: 1, updatedAt: -1 });

module.exports = mongoose.model('CandleCache', candleCacheSchema);
