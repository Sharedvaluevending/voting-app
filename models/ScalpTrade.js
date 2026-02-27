const mongoose = require('mongoose');

const scalpTradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  walletAddress: { type: String, default: '', index: true },
  isPaper: { type: Boolean, default: false },
  tokenAddress: { type: String, required: true, index: true },
  tokenSymbol: { type: String, default: '' },
  tokenName: { type: String, default: '' },
  side: { type: String, enum: ['BUY', 'SELL'], required: true },
  amountIn: { type: Number, required: true },
  amountOut: { type: Number, default: 0 },
  tokenAmount: { type: Number, default: 0 },
  entryPrice: { type: Number, default: 0 },
  exitPrice: { type: Number, default: 0 },
  pnl: { type: Number, default: 0 },
  pnlPercent: { type: Number, default: 0 },
  txHash: { type: String, default: '' },
  status: { type: String, enum: ['PENDING', 'CONFIRMED', 'FAILED', 'OPEN', 'CLOSED'], default: 'PENDING' },
  exitTime: { type: Date },
  peakPrice: { type: Number, default: 0 },
  breakevenTriggered: { type: Boolean, default: false },
  partialSoldAmount: { type: Number, default: 0 },
  exitReason: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ScalpTrade', scalpTradeSchema);
