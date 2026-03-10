const mongoose = require('mongoose');

const packSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  packType: { type: String, enum: ['copilot', 'llm', 'voice'], required: true, index: true },
  questionsAdded: { type: Number, default: 0 },
  minutesAdded: { type: Number, default: 0 },
  purchasedAt: { type: Date, default: Date.now },
  stripePaymentId: { type: String, default: '', index: true }
});

module.exports = mongoose.model('Pack', packSchema);
