const mongoose = require('mongoose');

const journalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trade' },
  type: {
    type: String,
    enum: ['trade_note', 'daily_review', 'lesson', 'mistake', 'win_analysis'],
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
  createdAt: { type: Date, default: Date.now }
});

journalSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Journal', journalSchema);
