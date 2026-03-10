const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  twitterHandle: { type: String, default: '', trim: true },
  discordUsername: { type: String, default: '', trim: true },
  referralCode: { type: String, required: true, unique: true, trim: true, uppercase: true },
  commissionRate: { type: Number, default: 10, min: 0, max: 100 },
  status: { type: String, enum: ['active', 'paused', 'cancelled'], default: 'active' },
  tier: { type: String, default: 'partner' },
  stripeConnectId: { type: String, default: '' },
  totalSignups: { type: Number, default: 0 },
  activeSubscribers: { type: Number, default: 0 },
  pendingEarnings: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

referralSchema.index({ referralCode: 1 }, { unique: true });

module.exports = mongoose.model('Referral', referralSchema);
