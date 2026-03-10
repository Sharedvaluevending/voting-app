const mongoose = require('mongoose');

const commissionTransactionSchema = new mongoose.Schema({
  referralCode: { type: String, required: true, uppercase: true, trim: true },
  partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  stripeInvoiceId: { type: String, default: '', trim: true },
  stripeSubscriptionId: { type: String, default: '', trim: true },
  amountPaidCents: { type: Number, required: true, min: 0 },
  commissionRate: { type: Number, required: true, min: 0, max: 100 },
  commissionAmountCents: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'usd', lowercase: true },
  status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
  paidAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

commissionTransactionSchema.index({ partnerId: 1, createdAt: -1 });
commissionTransactionSchema.index({ userId: 1, createdAt: -1 });
commissionTransactionSchema.index({ stripeInvoiceId: 1 });

module.exports = mongoose.model('CommissionTransaction', commissionTransactionSchema);
