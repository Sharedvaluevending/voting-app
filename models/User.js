const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 20 },
  password: { type: String, required: true },
  paperBalance: { type: Number, default: 10000 },
  initialBalance: { type: Number, default: 10000 },
  tier: { type: String, enum: ['free', 'premium'], default: 'free' },
  settings: {
    defaultLeverage: { type: Number, default: 1, min: 1, max: 20 },
    riskPerTrade: { type: Number, default: 2, min: 0.5, max: 10 },
    maxOpenTrades: { type: Number, default: 3, min: 1, max: 10 },
    maxBalancePercentPerTrade: { type: Number, default: 25, min: 5, max: 100 },
    cooldownHours: { type: Number, default: 4, min: 0, max: 168 },
    autoExecuteActions: { type: Boolean, default: false },
    autoMoveBreakeven: { type: Boolean, default: true },
    autoTrailingStop: { type: Boolean, default: true }
  },
  stats: {
    totalTrades: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    totalPnl: { type: Number, default: 0 },
    bestTrade: { type: Number, default: 0 },
    worstTrade: { type: Number, default: 0 },
    currentStreak: { type: Number, default: 0 },
    bestStreak: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now }
});

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.getWinRate = function() {
  const total = this.stats.wins + this.stats.losses;
  return total > 0 ? ((this.stats.wins / total) * 100).toFixed(1) : '0.0';
};

userSchema.methods.getPnlPercent = function() {
  return this.initialBalance > 0
    ? (((this.paperBalance - this.initialBalance) / this.initialBalance) * 100).toFixed(2)
    : '0.00';
};

module.exports = mongoose.model('User', userSchema);
