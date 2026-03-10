const mongoose = require('mongoose');

const betaCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },
  label: { type: String, default: '', trim: true },
  active: { type: Boolean, default: true },
  usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  usedByEmail: { type: String, default: '' },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

betaCodeSchema.index({ code: 1 }, { unique: true });
betaCodeSchema.index({ active: 1, usedBy: 1 });

module.exports = mongoose.model('BetaCode', betaCodeSchema);
