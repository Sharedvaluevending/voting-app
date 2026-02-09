const mongoose = require('mongoose');

const strategyWeightSchema = new mongoose.Schema({
  strategyId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: { type: String },
  weights: {
    trend: { type: Number, default: 20 },
    momentum: { type: Number, default: 20 },
    volume: { type: Number, default: 20 },
    structure: { type: Number, default: 20 },
    volatility: { type: Number, default: 10 },
    riskQuality: { type: Number, default: 10 }
  },
  performance: {
    totalTrades: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    avgRR: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    profitFactor: { type: Number, default: 0 },
    avgScore: { type: Number, default: 0 },
    byRegime: {
      trending: { wins: { type: Number, default: 0 }, losses: { type: Number, default: 0 } },
      ranging: { wins: { type: Number, default: 0 }, losses: { type: Number, default: 0 } },
      volatile: { wins: { type: Number, default: 0 }, losses: { type: Number, default: 0 } }
    }
  },
  active: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('StrategyWeight', strategyWeightSchema);
