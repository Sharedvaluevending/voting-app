const mongoose = require('mongoose');

const setupNotificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  coinId: { type: String, required: true },
  setupId: { type: String, required: true },
  setupName: { type: String, required: true },
  direction: { type: String, enum: ['LONG', 'SHORT'], required: true },
  entry: { type: Number },
  sl: { type: Number },
  tp1: { type: Number },
  tp2: { type: Number },
  tp3: { type: Number },
  score: { type: Number },
  htfBias: { type: String },
  source: { type: String, enum: ['llm_scan', 'llm_autonomous'], default: 'llm_scan' },
  seenAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SetupNotification', setupNotificationSchema);
