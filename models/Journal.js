const mongoose = require('mongoose');

const journalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trade' },
  type: {
    type: String,
    enum: ['trade_note', 'post_trade_review', 'daily_review', 'lesson', 'mistake', 'win_analysis'],
    default: 'trade_note'
  },
  content: { type: String, required: true },
  emotion: {
    type: String,
    enum: ['confident', 'fearful', 'greedy', 'neutral', 'frustrated', 'excited', 'disciplined', 'impulsive']
  },
  followedRules: { type: Boolean },
  lessonsLearned: { type: String },
  rating: { type: Number, min: 1, max: 10 },
  tags: [String],
  // Post-trade review fields (million-dollar journal)
  setupQuality: { type: Number, min: 1, max: 10 },
  executionQuality: { type: Number, min: 1, max: 10 },
  whatWentRight: { type: String },
  whatWentWrong: { type: String },
  keyLesson: { type: String },
  nextAction: { type: String },
  revengeTrade: { type: Boolean, default: false },
  fomoEntry: { type: Boolean, default: false },
  overtrading: { type: Boolean, default: false },
  positionSizeCorrect: { type: Boolean },
  tradeContext: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});

journalSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Journal', journalSchema);
