const mongoose = require('mongoose');

const llmAgentLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  success: { type: Boolean, required: true },
  source: { type: String, enum: ['manual', 'scheduled', 'chat'], default: 'manual' },
  reasoning: { type: String, default: '' },
  actionsExecuted: [{ type: mongoose.Schema.Types.Mixed }],
  actionsFailed: [{ type: mongoose.Schema.Types.Mixed }],
  error: { type: String },
  userRequest: { type: String },
  at: { type: Date, default: Date.now, index: true }
});

llmAgentLogSchema.index({ userId: 1, at: -1 });

module.exports = mongoose.model('LlmAgentLog', llmAgentLogSchema);
