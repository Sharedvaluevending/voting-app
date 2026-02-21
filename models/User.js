const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 20 },
  password: { type: String, required: true },
  paperBalance: { type: Number, default: 10000 },
  initialBalance: { type: Number, default: 10000 },
  trenchPaperBalance: { type: Number, default: 1000 },
  trenchPaperBalanceInitial: { type: Number, default: 1000 },
  trenchBot: {
    privateKeyEncrypted: { type: String, default: '' },
    publicKey: { type: String, default: '' },
    connected: { type: Boolean, default: false }
  },
  trenchAuto: {
    enabled: { type: Boolean, default: false },
    mode: { type: String, enum: ['paper', 'live'], default: 'paper' },
    minTrendingScore: { type: Number, default: 0, min: 0, max: 50 },
    maxOpenPositions: { type: Number, default: 6, min: 1, max: 15 },
    amountPerTradeUsd: { type: Number, default: 50, min: 5, max: 500 },
    amountPerTradeSol: { type: Number, default: 0.05, min: 0.01, max: 1 },
    checkIntervalMinutes: { type: Number, default: 15, min: 5, max: 60 },
    lastRunAt: { type: Date },
    // Profit locking
    tpPercent: { type: Number, default: 25, min: 5, max: 100 },
    slPercent: { type: Number, default: 8, min: 3, max: 50 },
    trailingStopPercent: { type: Number, default: 8, min: 3, max: 30 },
    useTrailingStop: { type: Boolean, default: true },
    partialTpPercent: { type: Number, default: 50, min: 0, max: 100 },
    partialTpAtPercent: { type: Number, default: 15, min: 5, max: 50 },
    breakevenAtPercent: { type: Number, default: 5, min: 2, max: 20 },
    useBreakevenStop: { type: Boolean, default: true },
    maxHoldMinutes: { type: Number, default: 30, min: 15, max: 480 },
    // Entry filters
    minLiquidityUsd: { type: Number, default: 10000, min: 0, max: 1000000 },
    maxTop10HoldersPercent: { type: Number, default: 80, min: 50, max: 100 },
    maxPriceChange24hPercent: { type: Number, default: 500, min: 100, max: 10000 },
    cooldownHours: { type: Number, default: 1, min: 0, max: 48 },
    useEntryFilters: { type: Boolean, default: true },
    // Risk controls
    maxDailyLossPercent: { type: Number, default: 15, min: 0, max: 50 },
    consecutiveLossesToPause: { type: Number, default: 3, min: 0, max: 10 },
    minSolBalance: { type: Number, default: 0.05, min: 0.01, max: 1 },
    lastPausedAt: { type: Date },
    pausedReason: { type: String, default: '' },
    // Notifications
    trenchNotifyTradeOpen: { type: Boolean, default: true },
    trenchNotifyTradeClose: { type: Boolean, default: true },
    // Profit payout (live mode only)
    profitPayoutAddress: { type: String, default: '' },
    profitPayoutPercent: { type: Number, default: 0, min: 0, max: 100 },
    profitPayoutMinSol: { type: Number, default: 0.1, min: 0.01, max: 10 }
  },
  trenchBlacklist: [{ type: String }],
  trenchStats: {
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    totalPnl: { type: Number, default: 0 },
    totalPnlPercent: { type: Number, default: 0 },
    bestTrade: { type: Number, default: 0 },
    worstTrade: { type: Number, default: 0 },
    consecutiveLosses: { type: Number, default: 0 },
    dailyPnlStart: { type: Number, default: 0 },
    dailyPnlStartAt: { type: Date }
  },
  tier: { type: String, enum: ['free', 'premium'], default: 'free' },
  settings: {
    defaultLeverage: { type: Number, default: 2, min: 1, max: 20 },
    useFixedLeverage: { type: Boolean, default: false },
    riskPerTrade: { type: Number, default: 2, min: 0.5, max: 10 },
    riskMode: { type: String, enum: ['percent', 'dollar'], default: 'percent' },
    riskDollarsPerTrade: { type: Number, default: 200, min: 10, max: 10000 },
    maxOpenTrades: { type: Number, default: 3, min: 1, max: 10 },
    maxBalancePercentPerTrade: { type: Number, default: 25, min: 5, max: 100 },
    cooldownHours: { type: Number, default: 4, min: 0, max: 168 },
    autoExecuteActions: { type: Boolean, default: false },
    autoTrade: { type: Boolean, default: false },
    autoTradeMinScore: { type: Number, default: 52, min: 30, max: 95 },
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
    featureConfidenceSizing: { type: Boolean, default: true },
    // Quality filters: require price-action confluence, skip extreme vol, require volume
    featurePriceActionConfluence: { type: Boolean, default: false },
    featureVolatilityFilter: { type: Boolean, default: false },
    featureVolumeConfirmation: { type: Boolean, default: false },
    featureFundingRateFilter: { type: Boolean, default: false },
    // Min R:R filter (default off) - hide/block signals below this R:R
    minRiskRewardEnabled: { type: Boolean, default: false },
    minRiskReward: { type: Number, default: 1.2, min: 1.0, max: 5.0 },
    // Take-Profit mode: 'fixed' = TP1/TP2/TP3, 'trailing' = trail from entry
    tpMode: { type: String, enum: ['fixed', 'trailing'], default: 'fixed' },
    trailingTpDistanceMode: { type: String, enum: ['atr', 'fixed'], default: 'atr' },
    trailingTpAtrMultiplier: { type: Number, default: 1.5, min: 0.5, max: 5.0 },
    trailingTpFixedPercent: { type: Number, default: 2, min: 0.5, max: 10 },
    // DCA: dollar-cost-average into losing positions when signal re-confirms
    dcaEnabled: { type: Boolean, default: false },
    dcaMaxAdds: { type: Number, default: 3, min: 1, max: 10 },
    dcaDipPercent: { type: Number, default: 2, min: 0.5, max: 20 },
    dcaAddSizePercent: { type: Number, default: 100, min: 25, max: 200 },
    dcaMinScore: { type: Number, default: 52, min: 30, max: 95 },
    // Risk controls
    maxDailyLossPercent: { type: Number, default: 0, min: 0, max: 20 },
    drawdownSizingEnabled: { type: Boolean, default: false },
    drawdownThresholdPercent: { type: Number, default: 10, min: 5, max: 50 },
    minVolume24hUsd: { type: Number, default: 0, min: 0, max: 500000000 },
    expectancyFilterEnabled: { type: Boolean, default: false },
    minExpectancy: { type: Number, default: 0.15, min: -1, max: 2 },
    correlationFilterEnabled: { type: Boolean, default: false }
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
    autoOpenMinScore: { type: Number, default: 52, min: 50, max: 95 }
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
