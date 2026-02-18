const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  coinId: { type: String, required: true },
  symbol: { type: String, required: true },
  condition: { type: String, enum: ['above', 'below'], required: true },
  price: { type: Number, required: true },
  active: { type: Boolean, default: true },
  triggeredAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Alert', alertSchema);
