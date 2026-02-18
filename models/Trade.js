const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  coinId: { type: String, required: true },
  symbol: { type: String, required: true },
  direction: { type: String, enum: ['LONG', 'SHORT'], required: true },
  status: {
    type: String,
    enum: ['OPEN', 'CLOSED_MANUAL', 'STOPPED_OUT', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'SCORE_EXIT', 'TRAILING_TP_EXIT', 'DUST_CLEANUP', 'CANCELLED'],
    default: 'OPEN'
  },
  entryPrice: { type: Number, required: true },
  entryTime: { type: Date, default: Date.now },
  positionSize: { type: Number, required: true },
  originalPositionSize: { type: Number },
  leverage: { type: Number, default: 1, min: 1, max: 50 },
  margin: { type: Number, required: true },
  stopLoss: { type: Number },
  originalStopLoss: { type: Number },
  trailingActivated: { type: Boolean, default: false },
  breakevenHit: { type: Boolean, default: false },
  reducedByScore: { type: Boolean, default: false },
  takenPartialByScore: { type: Boolean, default: false },
  actions: [{ type: mongoose.Schema.Types.Mixed }],
  takeProfit1: { type: Number },
  takeProfit2: { type: Number },
  takeProfit3: { type: Number },
  partialTakenAtTP1: { type: Boolean, default: false },
  partialTakenAtTP2: { type: Boolean, default: false },
  partialPnl: { type: Number, default: 0 },
  exitPrice: { type: Number },
  exitTime: { type: Date },
  closeReason: { type: String },
  pnl: { type: Number, default: 0 },
  pnlPercent: { type: Number, default: 0 },
  fees: { type: Number, default: 0 },
  score: { type: Number },
  strategyType: { type: String },
  regime: { type: String },
  stopType: { type: String },
  stopLabel: { type: String },
  tpType: { type: String },
  tpLabel: { type: String },
  reasoning: [String],
  indicatorsAtEntry: { type: mongoose.Schema.Types.Mixed },
  scoreBreakdownAtEntry: { type: mongoose.Schema.Types.Mixed },
  scoreCheck: { type: mongoose.Schema.Types.Mixed, default: null },
  scoreHistory: [{ type: mongoose.Schema.Types.Mixed }],
  lastExecutedActionId: { type: String },
  maxPrice: { type: Number },
  minPrice: { type: Number },
  tpMode: { type: String, enum: ['fixed', 'trailing'], default: 'fixed' },
  trailingTpDistance: { type: Number },
  dcaCount: { type: Number, default: 0 },
  dcaEntries: [{ type: mongoose.Schema.Types.Mixed }],
  avgEntryPrice: { type: Number },
  maxDrawdownPercent: { type: Number, default: 0 },
  maxProfitPercent: { type: Number, default: 0 },
  isLive: { type: Boolean, default: false },
  bitgetOrderId: { type: String },
  bitgetSymbol: { type: String },
  executionStatus: { type: String, enum: ['paper', 'pending', 'filled', 'partial', 'failed'], default: 'paper' },
  executionDetails: { type: mongoose.Schema.Types.Mixed },
  userNotes: { type: String },
  followedPlan: { type: Boolean },
  emotion: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

tradeSchema.index({ userId: 1, status: 1 });
tradeSchema.index({ userId: 1, coinId: 1, status: 1 });
tradeSchema.index({ userId: 1, createdAt: -1 });

tradeSchema.methods.getCurrentPnl = function(currentPrice) {
  if (!currentPrice || !this.entryPrice || this.entryPrice <= 0) return { pnl: 0, pnlPercent: 0 };
  let pnl;
  if (this.direction === 'LONG') {
    pnl = (currentPrice - this.entryPrice) / this.entryPrice * this.positionSize;
  } else {
    pnl = (this.entryPrice - currentPrice) / this.entryPrice * this.positionSize;
  }
  // Subtract fees for accurate unrealized PnL display
  const netPnl = pnl - (this.fees || 0);
  const pnlPercent = this.margin > 0 ? (netPnl / this.margin) * 100 : 0;
  return { pnl: Math.round(netPnl * 100) / 100, pnlPercent: Math.round(pnlPercent * 100) / 100 };
};

tradeSchema.methods.getTimeHeld = function() {
  const end = this.exitTime || new Date();
  const ms = end - this.entryTime;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${hours}h ${mins}m`;
};

module.exports = mongoose.model('Trade', tradeSchema);
