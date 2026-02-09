// services/paper-trading.js
// ====================================================
// PAPER TRADING SERVICE
// Manages virtual trades, balances, P&L tracking.
// Enforces 1 active trade per pair.
// Suggests leverage based on signal score + regime.
// ====================================================

const Trade = require('../models/Trade');
const User = require('../models/User');
const { recordTradeOutcome, adjustWeights } = require('./learning-engine');

const MAKER_FEE = 0.001;
const TAKER_FEE = 0.001;
const SLIPPAGE_BPS = 5;           // 0.05% slippage simulation
const COOLDOWN_HOURS = 4;         // no same-direction re-entry on same coin within 4h

function suggestLeverage(score, regime, volatilityState) {
  let maxLev = 1;

  if (score >= 85) maxLev = 10;
  else if (score >= 75) maxLev = 7;
  else if (score >= 65) maxLev = 5;
  else if (score >= 55) maxLev = 3;
  else if (score >= 45) maxLev = 2;
  else maxLev = 1;

  if (regime === 'ranging' || regime === 'choppy') {
    maxLev = Math.max(1, Math.floor(maxLev * 0.6));
  }
  if (volatilityState === 'high' || volatilityState === 'extreme') {
    maxLev = Math.max(1, Math.floor(maxLev * 0.5));
  }

  return maxLev;
}

function calculatePositionSize(balance, riskPercent, entryPrice, stopLoss, leverage) {
  if (!entryPrice || entryPrice <= 0) return balance * 0.05 * leverage;
  const riskAmount = balance * (riskPercent / 100);
  let stopDistance = typeof stopLoss === 'number' && stopLoss > 0
    ? Math.abs(entryPrice - stopLoss) / entryPrice
    : 0.02;
  if (stopDistance <= 0 || !Number.isFinite(stopDistance)) stopDistance = 0.02;
  const positionSize = (riskAmount / stopDistance) * leverage;
  const capped = Math.min(positionSize, balance * leverage * 0.95);
  return Number.isFinite(capped) ? capped : balance * 0.1 * leverage;
}

async function openTrade(userId, signalData) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  const existing = await Trade.findOne({
    userId,
    coinId: signalData.coinId,
    status: 'OPEN'
  });
  if (existing) throw new Error(`Already have an open ${existing.direction} on ${existing.symbol}`);

  // Cooldown: no same-direction re-entry on this coin within COOLDOWN_HOURS
  const cooldownSince = new Date(Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000);
  const lastClosed = await Trade.findOne({
    userId,
    coinId: signalData.coinId,
    status: { $ne: 'OPEN' },
    direction: signalData.direction,
    exitTime: { $gte: cooldownSince }
  }).sort({ exitTime: -1 }).lean();
  if (lastClosed) {
    throw new Error(`${signalData.direction} on ${signalData.symbol} in cooldown. Wait ${COOLDOWN_HOURS}h after last close.`);
  }

  const openCount = await Trade.countDocuments({ userId, status: 'OPEN' });
  if (openCount >= (user.settings?.maxOpenTrades || 3)) {
    throw new Error(`Max open trades reached (${user.settings?.maxOpenTrades || 3}). Close a trade first.`);
  }

  const leverage = signalData.leverage || user.settings?.defaultLeverage || 1;
  const riskPercent = user.settings?.riskPerTrade || 2;
  // Slippage: worse entry (LONG pay more, SHORT receive less)
  const slippage = 1 + (SLIPPAGE_BPS / 10000);
  const entryPrice = signalData.direction === 'LONG'
    ? signalData.entry * slippage
    : signalData.entry / slippage;
  const stopLoss = signalData.stopLoss;

  let positionSize = calculatePositionSize(
    user.paperBalance, riskPercent, entryPrice, stopLoss, leverage
  );
  // Confidence-weighted size: scale by score (0.5 + score/100), cap 1.2
  const score = Math.min(100, Math.max(0, signalData.score || 50));
  const confidenceMult = Math.min(1.2, 0.5 + score / 100);
  positionSize = positionSize * confidenceMult;

  // Cap position so margin + fees never exceed balance (risk management = size from balance)
  const maxPositionFromBalance = user.paperBalance / (1 / leverage + MAKER_FEE);
  positionSize = Math.min(positionSize, Math.max(0, maxPositionFromBalance));

  // If still invalid or zero (e.g. bad data), use a small % of balance so we can always open when balance > 0
  if (!Number.isFinite(positionSize) || positionSize <= 0) {
    positionSize = Math.min(user.paperBalance * 0.02 * leverage, maxPositionFromBalance);
  }

  const margin = positionSize / leverage;
  const fees = positionSize * MAKER_FEE;
  const required = margin + fees;
  const epsilon = 0.01;

  if (user.paperBalance <= 0) {
    throw new Error('Insufficient balance. Your paper balance is zero.');
  }
  if (required > user.paperBalance + epsilon) {
    throw new Error(`Insufficient balance. Need $${required.toFixed(2)}, have $${user.paperBalance.toFixed(2)}`);
  }

  const trade = new Trade({
    userId,
    coinId: signalData.coinId,
    symbol: signalData.symbol,
    direction: signalData.direction,
    entryPrice,
    positionSize,
    leverage,
    margin,
    stopLoss,
    takeProfit1: signalData.takeProfit1,
    takeProfit2: signalData.takeProfit2,
    takeProfit3: signalData.takeProfit3,
    fees,
    score: signalData.score,
    strategyType: signalData.strategyType,
    regime: signalData.regime,
    reasoning: signalData.reasoning || [],
    indicatorsAtEntry: signalData.indicators || {},
    maxPrice: entryPrice,
    minPrice: entryPrice
  });

  await trade.save();

  user.paperBalance -= (margin + fees);
  await user.save();

  return trade;
}

async function closeTrade(userId, tradeId, currentPrice, reason) {
  const trade = await Trade.findOne({ _id: tradeId, userId, status: 'OPEN' });
  if (!trade) throw new Error('Trade not found or already closed');

  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  // Slippage on exit: LONG sell lower, SHORT buy back higher
  const slippage = 1 + (SLIPPAGE_BPS / 10000);
  const exitPrice = trade.direction === 'LONG'
    ? currentPrice / slippage
    : currentPrice * slippage;

  let pnl;
  if (trade.direction === 'LONG') {
    pnl = ((exitPrice - trade.entryPrice) / trade.entryPrice) * trade.positionSize;
  } else {
    pnl = ((trade.entryPrice - exitPrice) / trade.entryPrice) * trade.positionSize;
  }

  const exitFees = trade.positionSize * TAKER_FEE;
  pnl -= exitFees;

  const pnlPercent = (pnl / trade.margin) * 100;

  trade.exitPrice = exitPrice;
  trade.exitTime = new Date();
  trade.closeReason = reason;
  trade.pnl = Math.round(pnl * 100) / 100;
  trade.pnlPercent = Math.round(pnlPercent * 100) / 100;
  trade.fees += exitFees;
  trade.status = reason === 'STOPPED_OUT' ? 'STOPPED_OUT'
    : reason === 'TP1' ? 'TP1_HIT'
    : reason === 'TP2' ? 'TP2_HIT'
    : reason === 'TP3' ? 'TP3_HIT'
    : 'CLOSED_MANUAL';
  trade.updatedAt = new Date();

  await trade.save();

  user.paperBalance += trade.margin + pnl;
  user.stats.totalTrades += 1;
  if (pnl > 0) {
    user.stats.wins += 1;
    user.stats.currentStreak = Math.max(0, user.stats.currentStreak) + 1;
    user.stats.bestStreak = Math.max(user.stats.bestStreak, user.stats.currentStreak);
    user.stats.bestTrade = Math.max(user.stats.bestTrade, pnl);
  } else {
    user.stats.losses += 1;
    user.stats.currentStreak = Math.min(0, user.stats.currentStreak) - 1;
    user.stats.worstTrade = Math.min(user.stats.worstTrade, pnl);
  }
  user.stats.totalPnl += pnl;
  await user.save();

  recordTradeOutcome(trade)
    .then(() => adjustWeights().catch(err => console.error('[PaperTrading] AdjustWeights error:', err.message)))
    .catch(err => console.error('[PaperTrading] Learn error:', err.message));

  return trade;
}

async function checkStopsAndTPs(getCurrentPriceFunc) {
  const openTrades = await Trade.find({ status: 'OPEN' });
  let closedCount = 0;

  for (const trade of openTrades) {
    const priceData = getCurrentPriceFunc(trade.coinId);
    if (!priceData) continue;

    const currentPrice = priceData.price;

    if (currentPrice > trade.maxPrice) trade.maxPrice = currentPrice;
    if (currentPrice < trade.minPrice) trade.minPrice = currentPrice;

    let drawdown, profit;
    if (trade.direction === 'LONG') {
      drawdown = ((trade.entryPrice - trade.minPrice) / trade.entryPrice) * 100 * trade.leverage;
      profit = ((trade.maxPrice - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage;
    } else {
      drawdown = ((trade.maxPrice - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage;
      profit = ((trade.entryPrice - trade.minPrice) / trade.entryPrice) * 100 * trade.leverage;
    }
    trade.maxDrawdownPercent = Math.max(trade.maxDrawdownPercent, drawdown);
    trade.maxProfitPercent = Math.max(trade.maxProfitPercent, profit);

    // Trailing stop: move stop to breakeven when price is 1R in favor
    const risk = trade.direction === 'LONG'
      ? trade.entryPrice - (trade.stopLoss || 0)
      : (trade.stopLoss || 0) - trade.entryPrice;
    if (risk > 0 && trade.stopLoss != null && trade.stopLoss !== trade.entryPrice) {
      if (trade.direction === 'LONG' && currentPrice >= trade.entryPrice + risk) {
        trade.stopLoss = trade.entryPrice;
        await trade.save();
      } else if (trade.direction === 'SHORT' && currentPrice <= trade.entryPrice - risk) {
        trade.stopLoss = trade.entryPrice;
        await trade.save();
      }
    }
    await trade.save();

    if (trade.direction === 'LONG') {
      if (trade.stopLoss != null && currentPrice <= trade.stopLoss) {
        await closeTrade(trade.userId, trade._id, trade.stopLoss, 'STOPPED_OUT');
        closedCount++;
        continue;
      }
      if (trade.takeProfit3 && currentPrice >= trade.takeProfit3) {
        await closeTrade(trade.userId, trade._id, trade.takeProfit3, 'TP3');
        closedCount++;
      } else if (trade.takeProfit2 && currentPrice >= trade.takeProfit2) {
        await closeTrade(trade.userId, trade._id, trade.takeProfit2, 'TP2');
        closedCount++;
      } else if (trade.takeProfit1 && currentPrice >= trade.takeProfit1) {
        await closeTrade(trade.userId, trade._id, trade.takeProfit1, 'TP1');
        closedCount++;
      }
    } else {
      if (trade.stopLoss && currentPrice >= trade.stopLoss) {
        await closeTrade(trade.userId, trade._id, trade.stopLoss, 'STOPPED_OUT');
        closedCount++;
        continue;
      }
      if (trade.takeProfit3 && currentPrice <= trade.takeProfit3) {
        await closeTrade(trade.userId, trade._id, trade.takeProfit3, 'TP3');
        closedCount++;
      } else if (trade.takeProfit2 && currentPrice <= trade.takeProfit2) {
        await closeTrade(trade.userId, trade._id, trade.takeProfit2, 'TP2');
        closedCount++;
      } else if (trade.takeProfit1 && currentPrice <= trade.takeProfit1) {
        await closeTrade(trade.userId, trade._id, trade.takeProfit1, 'TP1');
        closedCount++;
      }
    }
  }

  if (closedCount > 0) {
    console.log(`[PaperTrading] Auto-closed ${closedCount} trades`);
  }
}

async function getOpenTrades(userId) {
  return Trade.find({ userId, status: 'OPEN' }).sort({ createdAt: -1 }).lean();
}

async function getTradeHistory(userId, limit = 50) {
  return Trade.find({ userId, status: { $ne: 'OPEN' } })
    .sort({ exitTime: -1 })
    .limit(limit)
    .lean();
}

async function getPerformanceStats(userId) {
  const user = await User.findById(userId).lean();
  if (!user) return null;

  const closedTrades = await Trade.find({ userId, status: { $ne: 'OPEN' } }).lean();
  const openTrades = await Trade.find({ userId, status: 'OPEN' }).lean();

  const wins = closedTrades.filter(t => t.pnl > 0);
  const losses = closedTrades.filter(t => t.pnl <= 0);

  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.pnl), 0) / losses.length : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 0;

  const byStrategy = {};
  closedTrades.forEach(t => {
    const s = t.strategyType || 'unknown';
    if (!byStrategy[s]) byStrategy[s] = { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl > 0) byStrategy[s].wins++;
    else byStrategy[s].losses++;
    byStrategy[s].pnl += t.pnl || 0;
  });

  const byCoin = {};
  closedTrades.forEach(t => {
    if (!byCoin[t.symbol]) byCoin[t.symbol] = { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl > 0) byCoin[t.symbol].wins++;
    else byCoin[t.symbol].losses++;
    byCoin[t.symbol].pnl += t.pnl || 0;
  });

  const last7Days = closedTrades.filter(t =>
    t.exitTime && (Date.now() - new Date(t.exitTime).getTime()) < 7 * 24 * 60 * 60 * 1000
  );
  const pnl7d = last7Days.reduce((s, t) => s + (t.pnl || 0), 0);

  return {
    balance: user.paperBalance,
    initialBalance: user.initialBalance,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalPnlPercent: user.initialBalance > 0 ? ((totalPnl / user.initialBalance) * 100).toFixed(2) : '0',
    totalTrades: closedTrades.length,
    openTrades: openTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closedTrades.length > 0 ? ((wins.length / closedTrades.length) * 100).toFixed(1) : '0',
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: profitFactor.toFixed(2),
    bestTrade: user.stats.bestTrade,
    worstTrade: user.stats.worstTrade,
    currentStreak: user.stats.currentStreak,
    bestStreak: user.stats.bestStreak,
    pnl7d: Math.round(pnl7d * 100) / 100,
    byStrategy,
    byCoin
  };
}

async function resetAccount(userId) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  await Trade.deleteMany({ userId });
  user.paperBalance = 10000;
  user.initialBalance = 10000;
  user.stats = {
    totalTrades: 0, wins: 0, losses: 0, totalPnl: 0,
    bestTrade: 0, worstTrade: 0, currentStreak: 0, bestStreak: 0
  };
  await user.save();
  return user;
}

module.exports = {
  suggestLeverage,
  calculatePositionSize,
  openTrade,
  closeTrade,
  checkStopsAndTPs,
  getOpenTrades,
  getTradeHistory,
  getPerformanceStats,
  resetAccount
};
