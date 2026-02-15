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
    defaultLeverage: { type: Number, default: 2, min: 1, max: 20 },
    useFixedLeverage: { type: Boolean, default: false },
    riskPerTrade: { type: Number, default: 2, min: 0.5, max: 10 },
    maxOpenTrades: { type: Number, default: 3, min: 1, max: 10 },
    maxBalancePercentPerTrade: { type: Number, default: 25, min: 5, max: 100 },
    cooldownHours: { type: Number, default: 4, min: 0, max: 168 },
    autoExecuteActions: { type: Boolean, default: false },
    autoTrade: { type: Boolean, default: false },
    autoTradeMinScore: { type: Number, default: 70, min: 30, max: 95 },
    disableLeverage: { type: Boolean, default: false },
    autoMoveBreakeven: { type: Boolean, default: true },
    autoTrailingStop: { type: Boolean, default: true },
    paperLiveSync: { type: Boolean, default: true },
    scoreCheckGraceMinutes: { type: Number, default: 10, min: 0, max: 60 },
    stopCheckGraceMinutes: { type: Number, default: 2, min: 0, max: 30 },
    notifyTradeOpen: { type: Boolean, default: true },
    notifyTradeClose: { type: Boolean, default: true },
    makerFeePercent: { type: Number, default: 0.1, min: 0, max: 1 },
    takerFeePercent: { type: Number, default: 0.1, min: 0, max: 1 },
    // Feature toggles (match backtest toggles for 1:1 config transfer)
    featureBtcFilter: { type: Boolean, default: true },
    featureBtcCorrelation: { type: Boolean, default: true },
    featureSessionFilter: { type: Boolean, default: true },
    featurePartialTP: { type: Boolean, default: true },
    featureLockIn: { type: Boolean, default: true },
    featureScoreRecheck: { type: Boolean, default: true },
    featureSlCap: { type: Boolean, default: true },
    featureMinSlDistance: { type: Boolean, default: true },
    featureConfidenceSizing: { type: Boolean, default: true }
  },
  excludedCoins: [{ type: String }], // Coins excluded from auto-trade (e.g. ['dogecoin', 'cardano']),
  // Coin weights from backtest (1.0 = normal, 1.2 = 20% more allocation, 0.8 = 20% less)
  coinWeights: { type: mongoose.Schema.Types.Mixed, default: {} },
  coinWeightEnabled: { type: Boolean, default: false },
  coinWeightStrength: { type: String, enum: ['conservative', 'moderate', 'aggressive'], default: 'moderate' },
  resetToken: { type: String },
  resetTokenExpiry: { type: Date },
  pushSubscriptions: [{ type: mongoose.Schema.Types.Mixed }],
  bitget: {
    apiKey: { type: String, default: '' },
    secretKey: { type: String, default: '' },
    passphrase: { type: String, default: '' },
    connected: { type: Boolean, default: false },
    lastVerified: { type: Date }
  },
  liveTrading: {
    enabled: { type: Boolean, default: false },
    mode: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    tradingType: { type: String, enum: ['spot', 'futures', 'both'], default: 'futures' },
    liveLeverage: { type: Number, default: 2, min: 1, max: 50 },
    maxLiveTradesOpen: { type: Number, default: 3, min: 1, max: 10 },
    riskPerLiveTrade: { type: Number, default: 1, min: 0.5, max: 5 },
    autoOpenMinScore: { type: Number, default: 75, min: 50, max: 95 }
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
