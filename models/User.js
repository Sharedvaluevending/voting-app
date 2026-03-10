const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 20 },
  password: { type: String, default: '' }, // empty for OAuth-only users
  googleId: { type: String, sparse: true, unique: true }, // for Google OAuth
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
    strategy: { type: String, enum: ['memecoin', 'scalping'], default: 'memecoin' },
    minTrendingScore: { type: Number, default: 1, min: 0, max: 50 },
    maxOpenPositions: { type: Number, default: 6, min: 1, max: 15 },
    amountPerTradeUsd: { type: Number, default: 50, min: 5, max: 500 },
    amountPerTradeSol: { type: Number, default: 0.05, min: 0.01, max: 1 },
    checkIntervalMinutes: { type: Number, default: 15 },
    lastRunAt: { type: Date },
    lastStartedAt: { type: Date },
    tpPercent: { type: Number, default: 3, min: 1, max: 50 },
    slPercent: { type: Number, default: 2, min: 1, max: 30 },
    trailingStopPercent: { type: Number, default: 1.5, min: 1, max: 20 },
    useTrailingStop: { type: Boolean, default: true },
    useTrailingTP: { type: Boolean, default: true },
    breakevenAtPercent: { type: Number, default: 1.5, min: 1, max: 15 },
    useBreakevenStop: { type: Boolean, default: true },
    maxHoldMinutes: { type: Number, default: 4, min: 2, max: 30 },
    minLiquidityUsd: { type: Number, default: 15000, min: 5000, max: 100000 },
    maxTop10HoldersPercent: { type: Number, default: 60, min: 50, max: 100 },
    maxPriceChange24hPercent: { type: Number, default: 400, min: 100, max: 1000 },
    cooldownHours: { type: Number, default: 1, min: 0.25, max: 4 },
    useEntryFilters: { type: Boolean, default: true },
    requireSocials: { type: Boolean, default: true },
    maxDailyLossPercent: { type: Number, default: 15, min: 5, max: 50 },
    consecutiveLossesToPause: { type: Number, default: 3, min: 2, max: 10 },
    minSolBalance: { type: Number, default: 0.05, min: 0.01, max: 1 },
    lastPausedAt: { type: Date },
    pausedReason: { type: String, default: '' },
    trenchNotifyTradeOpen: { type: Boolean, default: true },
    trenchNotifyTradeClose: { type: Boolean, default: true },
    profitPayoutAddress: { type: String, default: '' },
    profitPayoutPercent: { type: Number, default: 0, min: 0, max: 100 },
    profitPayoutMinSol: { type: Number, default: 0.1, min: 0.01, max: 10 },
    useKellySizing: { type: Boolean, default: true },
    themeFilterEnabled: { type: Boolean, default: false },
    marketSource: { type: String, enum: ['trendings', 'explorer', 'launches'], default: 'trendings' },
    explorerCategoryId: { type: String, default: 'auto' },
    useEngineConfirmation: { type: Boolean, default: true },
    engineMinScore: { type: Number, default: 55, min: 45, max: 95 },
    enginePatternStrictness: { type: String, enum: ['off', 'light', 'strict'], default: 'light' },
    engineTopCandidates: { type: Number, default: 40, min: 5, max: 60 },
    volumeFilterEnabled: { type: Boolean, default: true },
    volatilityFilterEnabled: { type: Boolean, default: true },
    minVolume24hUsd: { type: Number, default: 25000, min: 5000, max: 500000 },
    maxVolatility24hPercent: { type: Number, default: 400, min: 100, max: 1000 },
    minVolatility24hPercent: { type: Number, default: -30, min: -80, max: 50 },
    minOrganicScore: { type: Number, default: 0, min: 0, max: 100 },
    minPoolAgeMinutes: { type: Number, default: 0, min: 0, max: 60 },
    tradingHoursStartUTC: { type: Number, default: 0, min: 0, max: 23 },
    tradingHoursEndUTC: { type: Number, default: 24, min: 0, max: 24 },
    minProfitToActivateTrail: { type: Number, default: 1, min: 0, max: 10 },
    minBuyPressure: { type: Number, default: 0.5, min: 0.45, max: 0.65 },
    usePartialTP: { type: Boolean, default: true }
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
  stripeCustomerId: { type: String, default: '' },
  stripeSubscriptionId: { type: String, default: '' },
  subscriptionTier: {
    type: String,
    enum: ['free', 'trial', 'pro', 'elite', 'partner'],
    default: 'free'
  },
  trialGrantedAt: { type: Date, default: null },
  registrationIpHash: { type: String, default: '' },
  trialEndsAt: { type: Date, default: null },
  subscriptionEndsAt: { type: Date, default: null },
  copilotQuestionsUsed: { type: Number, default: 0 },
  copilotQuestionsLimit: { type: Number, default: 25 },
  copilotPackQuestions: { type: Number, default: 0 },
  llmMessagesUsed: { type: Number, default: 0 },
  llmMessagesLimit: { type: Number, default: 25 },
  llmPackMessages: { type: Number, default: 0 },
  voiceMinutesUsed: { type: Number, default: 0 },
  voiceMinutesLimit: { type: Number, default: 0 },
  voicePackMinutes: { type: Number, default: 0 },
  trenchWarfareEnabled: { type: Boolean, default: false },
  trenchWarfareSubscriptionId: { type: String, default: '' },
  referralCode: { type: String, default: '', sparse: true },
  referredBy: { type: String, default: '' },
  discordId: { type: String, default: '' },
  isPartner: { type: Boolean, default: false },
  partnerCommissionRate: { type: Number, default: 10 },
  settings: {
    defaultLeverage: { type: Number, default: 2, min: 1, max: 20 },
    useFixedLeverage: { type: Boolean, default: false },
    riskPerTrade: { type: Number, default: 2, min: 0.5, max: 10 },
    riskMode: { type: String, enum: ['percent', 'dollar'], default: 'percent' },
    riskDollarsPerTrade: { type: Number, default: 200, min: 10, max: 10000 },
    maxOpenTrades: { type: Number, default: 3, min: 1, max: 10 },
    maxBalancePercentPerTrade: { type: Number, default: 25, min: 5, max: 100 },
    cooldownHours: { type: Number, default: 6, min: 0, max: 168 },
    autoExecuteActions: { type: Boolean, default: false },
    autoTrade: { type: Boolean, default: false },
    autoTradeMinScore: { type: Number, default: 62, min: 30, max: 95 },
    llmEnabled: { type: Boolean, default: false },
    ollamaUrl: { type: String, default: 'http://localhost:11434' },
    ollamaApiKey: { type: String, default: '' },
    ollamaModel: { type: String, default: 'llama3.1:8b' },
    llmAgentEnabled: { type: Boolean, default: false },
    llmAgentIntervalMinutes: { type: Number, default: 15, min: 5, max: 1440 },
    // Which coins to auto-trade: 'tracked' (20 only), 'tracked+top1' (20 + top market pick), 'top1' (only top market pick)
    autoTradeCoinsMode: { type: String, enum: ['tracked', 'tracked+top1', 'top1'], default: 'tracked' },
    // Signal source: 'original' = scoring engine, 'indicators' = Strategy Builder rules, 'setups' = SMC setups, 'both' = either
    autoTradeSignalMode: { type: String, enum: ['original', 'indicators', 'setups', 'both'], default: 'original' },
    autoTradeBothLogic: { type: String, enum: ['or', 'and'], default: 'or' },
    autoTradeStrategyConfigId: { type: mongoose.Schema.Types.ObjectId, ref: 'StrategyConfig', default: null },
    autoTradeSetupIds: { type: [String], default: [] },
    autoTradeUseSetups: { type: Boolean, default: false },
    disableLeverage: { type: Boolean, default: false },
    autoMoveBreakeven: { type: Boolean, default: true },
    autoTrailingStop: { type: Boolean, default: true },
    paperLiveSync: { type: Boolean, default: true },
    scoreCheckGraceMinutes: { type: Number, default: 10, min: 0, max: 60 },
    stopCheckGraceMinutes: { type: Number, default: 2, min: 0, max: 30 },
    notifyTradeOpen: { type: Boolean, default: true },
    notifyTradeClose: { type: Boolean, default: true },
    notifyActionBadges: { type: Boolean, default: false },
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
    featureConfidenceFilterEnabled: { type: Boolean, default: false },
    minConfidence: { type: Number, default: 60, min: 0, max: 100 },
    featureKellySizing: { type: Boolean, default: true },
    featureThemeDetector: { type: Boolean, default: false },
    // Quality filters: require price-action confluence, skip extreme vol, require volume
    featurePriceActionConfluence: { type: Boolean, default: true },
    featureVolatilityFilter: { type: Boolean, default: false },
    featureVolumeConfirmation: { type: Boolean, default: true },
    featureFundingRateFilter: { type: Boolean, default: true },
    // Min R:R filter - hide/block signals below this R:R
    minRiskRewardEnabled: { type: Boolean, default: true },
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
    maxDailyLossPercent: { type: Number, default: 5, min: 0, max: 20 },
    drawdownSizingEnabled: { type: Boolean, default: true },
    drawdownThresholdPercent: { type: Number, default: 10, min: 5, max: 50 },
    minVolume24hUsd: { type: Number, default: 0, min: 0, max: 500000000 },
    expectancyFilterEnabled: { type: Boolean, default: true },
    minExpectancy: { type: Number, default: 0.15, min: -1, max: 2 },
    correlationFilterEnabled: { type: Boolean, default: true }
  },
  excludedCoins: [{ type: String }], // Coins excluded from auto-trade (e.g. ['dogecoin', 'cardano']),
  // Per-coin regime toggles: { bitcoin: ['ranging','volatile'], ethereum: ['compression'] }
  disabledRegimesByCoin: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Coin weights from backtest (1.0 = normal, 1.2 = 20% more allocation, 0.8 = 20% less)
  coinWeights: { type: mongoose.Schema.Types.Mixed, default: {} },
  coinWeightEnabled: { type: Boolean, default: false },
  coinWeightStrength: { type: String, enum: ['conservative', 'moderate', 'aggressive'], default: 'moderate' },
  resetToken: { type: String },
  resetTokenExpiry: { type: Date },
  // Push notifications (Web Push API)
  pushSubscriptions: [{
    endpoint: { type: String, required: true },
    keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
    userAgent: { type: String }
  }],
  // SMS via email-to-SMS: 5551234567@vtext.com (Verizon), @txt.att.net (AT&T), @tmomail.net (T-Mobile)
  phoneSmsEmail: { type: String, default: '' },
  bitget: {
    apiKey: { type: String, default: '' },
    secretKey: { type: String, default: '' },
    passphrase: { type: String, default: '' },
    connected: { type: Boolean, default: false },
    lastVerified: { type: Date }
  },
  isAdmin: { type: Boolean, default: false },
  liveTrading: {
    enabled: { type: Boolean, default: false },
    dryRun: { type: Boolean, default: false },
    mode: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    tradingType: { type: String, enum: ['spot', 'futures', 'both'], default: 'futures' },
    liveLeverage: { type: Number, default: 2, min: 1, max: 50 },
    maxLiveTradesOpen: { type: Number, default: 3, min: 1, max: 10 },
    riskPerLiveTrade: { type: Number, default: 1, min: 0.5, max: 5 },
    autoOpenMinScore: { type: Number, default: 52, min: 50, max: 95 }
  },
  llmAgentLastBacktest: { type: mongoose.Schema.Types.Mixed },
  llmAgentLastRun: { type: mongoose.Schema.Types.Mixed },
  legal: {
    version: { type: String, default: '2026-03' },
    riskAcceptedAt: { type: Date, default: null },
    termsAcceptedAt: { type: Date, default: null },
    privacyAcceptedAt: { type: Date, default: null },
    acceptedIp: { type: String, default: '' },
    acceptedUserAgent: { type: String, default: '' }
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
  if (this.password && this.password.length > 0) {
    this.password = await bcrypt.hash(this.password, 12);
  }
  next();
});

userSchema.methods.comparePassword = async function(candidate) {
  if (!this.password || this.password.length === 0) return false;
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

// Hot query indexes used by schedulers/auto-trade loops.
userSchema.index({ 'settings.autoTrade': 1 });
userSchema.index({ 'settings.llmAgentEnabled': 1 });
userSchema.index({ 'trenchAuto.enabled': 1 });

module.exports = mongoose.model('User', userSchema);
