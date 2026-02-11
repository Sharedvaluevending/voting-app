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
const DEFAULT_COOLDOWN_HOURS = 4;  // no same-direction re-entry on same coin within N hours

// Stepped profit lock-in: progress toward TP -> lock-in level (R-multiple)
const LOCK_IN_LEVELS = [
  { progress: 0.5, lockR: 0.5 },
  { progress: 0.75, lockR: 0.75 },
  { progress: 0.9, lockR: 1 }
];

function getProgressTowardTP(trade, currentPrice) {
  const tp = trade.takeProfit2 || trade.takeProfit1 || trade.takeProfit3;
  if (!tp || !trade.entryPrice) return 0;
  const isLong = trade.direction === 'LONG';
  if (isLong && tp > trade.entryPrice) {
    return Math.min(1, (currentPrice - trade.entryPrice) / (tp - trade.entryPrice));
  }
  if (!isLong && tp < trade.entryPrice) {
    return Math.min(1, (trade.entryPrice - currentPrice) / (trade.entryPrice - tp));
  }
  return 0;
}

function getLockInStopPrice(trade, lockR, risk) {
  if (!risk || risk <= 0) return null;
  const r2 = (v) => Math.round(v * 1000000) / 1000000;
  const isLong = trade.direction === 'LONG';
  return isLong
    ? r2(trade.entryPrice + risk * lockR)
    : r2(trade.entryPrice - risk * lockR);
}

function getCurrentLockR(trade, risk) {
  if (!trade.stopLoss || !risk || risk <= 0) return 0;
  const isLong = trade.direction === 'LONG';
  const dist = isLong
    ? (trade.stopLoss || 0) - trade.entryPrice
    : trade.entryPrice - (trade.stopLoss || 0);
  if (dist <= 0) return 0;
  return dist / risk;
}

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

  // Cooldown: no same-direction re-entry on this coin within N hours (user setting)
  const cooldownHours = user.settings?.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
  const cooldownSince = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
  const lastClosed = await Trade.findOne({
    userId,
    coinId: signalData.coinId,
    status: { $ne: 'OPEN' },
    direction: signalData.direction,
    exitTime: { $gte: cooldownSince }
  }).sort({ exitTime: -1 }).lean();
  if (lastClosed) {
    throw new Error(`${signalData.direction} on ${signalData.symbol} in cooldown. Wait ${cooldownHours}h after last close.`);
  }

  const openCount = await Trade.countDocuments({ userId, status: 'OPEN' });
  if (openCount >= (user.settings?.maxOpenTrades || 3)) {
    throw new Error(`Max open trades reached (${user.settings?.maxOpenTrades || 3}). Close a trade first.`);
  }

  const leverage = signalData.leverage || user.settings?.defaultLeverage || 1;
  const riskPercent = user.settings?.riskPerTrade || 2;
  const maxBalancePct = user.settings?.maxBalancePercentPerTrade ?? 25;
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

  // Cap margin to max % of balance so we don't use all balance on one trade
  const maxMarginByPct = user.paperBalance * (Math.min(100, Math.max(5, maxBalancePct)) / 100);
  const maxPositionByMarginPct = maxMarginByPct * leverage;
  positionSize = Math.min(positionSize, Math.max(0, maxPositionByMarginPct));

  // Cap so margin + fees never exceed balance (leave $0.50 buffer for rounding)
  const maxSpend = Math.max(0, user.paperBalance - 0.50);
  const maxPositionFromBalance = maxSpend / (1 / leverage + MAKER_FEE);
  positionSize = Math.min(positionSize, Math.max(0, maxPositionFromBalance));

  // If still invalid or zero, use a small size that fits in balance
  if (!Number.isFinite(positionSize) || positionSize <= 0) {
    positionSize = Math.min(user.paperBalance * 0.02 * leverage, maxPositionFromBalance);
  }

  let margin = positionSize / leverage;
  let fees = positionSize * MAKER_FEE;
  let required = margin + fees;

  // Final safety: if required still exceeds balance (e.g. rounding), shrink position until it fits
  if (required > user.paperBalance && user.paperBalance > 0) {
    const maxPosByBalance = (user.paperBalance - 0.01) / (1 / leverage + MAKER_FEE);
    positionSize = Math.min(positionSize, Math.max(0, maxPosByBalance));
    margin = positionSize / leverage;
    fees = positionSize * MAKER_FEE;
    required = margin + fees;
  }

  if (user.paperBalance <= 0) {
    throw new Error('Insufficient balance. Your paper balance is zero. Reset your paper account from the Performance page.');
  }
  if (required > user.paperBalance) {
    throw new Error(`Insufficient balance. Need $${required.toFixed(2)}, have $${user.paperBalance.toFixed(2)}. Try resetting paper account.`);
  }

  const trade = new Trade({
    userId,
    coinId: signalData.coinId,
    symbol: signalData.symbol,
    direction: signalData.direction,
    entryPrice,
    positionSize,
    originalPositionSize: positionSize,
    leverage,
    margin,
    stopLoss,
    originalStopLoss: stopLoss,
    takeProfit1: signalData.takeProfit1,
    takeProfit2: signalData.takeProfit2,
    takeProfit3: signalData.takeProfit3,
    fees,
    score: signalData.score,
    strategyType: signalData.strategyType,
    regime: signalData.regime,
    stopType: signalData.stopType,
    stopLabel: signalData.stopLabel,
    tpType: signalData.tpType,
    tpLabel: signalData.tpLabel,
    reasoning: signalData.reasoning || [],
    indicatorsAtEntry: signalData.indicators || {},
    scoreBreakdownAtEntry: signalData.scoreBreakdown || {},
    maxPrice: entryPrice,
    minPrice: entryPrice
  });

  await trade.save();

  user.paperBalance -= (margin + fees);
  await user.save();

  return trade;
}

// Partial close: take a portion at TP, reduce position, don't count as full trade close
async function closeTradePartial(trade, exitPrice, portionSize, reason) {
  const user = await User.findById(trade.userId);
  if (!user) throw new Error('User not found');

  // Clamp portion to remaining size (avoid rounding issues)
  const portion = Math.min(portionSize, Math.max(0, trade.positionSize - 0.01));
  if (portion <= 0) return;

  let pnl;
  if (trade.direction === 'LONG') {
    pnl = ((exitPrice - trade.entryPrice) / trade.entryPrice) * portion;
  } else {
    pnl = ((trade.entryPrice - exitPrice) / trade.entryPrice) * portion;
  }
  const exitFees = portion * TAKER_FEE;
  pnl -= exitFees;

  const marginPortion = portion / trade.leverage;
  user.paperBalance += marginPortion + pnl;
  await user.save();

  trade.positionSize -= portion;
  trade.margin -= marginPortion;
  trade.fees += exitFees;
  trade.partialPnl = (trade.partialPnl || 0) + pnl;
  if (reason === 'TP1') trade.partialTakenAtTP1 = true;
  if (reason === 'TP2') trade.partialTakenAtTP2 = true;
  trade.updatedAt = new Date();
  await trade.save();
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
  const totalPnl = (trade.partialPnl || 0) + pnl;
  const originalMargin = (trade.originalPositionSize || trade.positionSize) / trade.leverage;
  const pnlPercent = originalMargin > 0 ? (totalPnl / originalMargin) * 100 : 0;

  trade.exitPrice = exitPrice;
  trade.exitTime = new Date();
  trade.closeReason = reason;
  trade.pnl = Math.round(totalPnl * 100) / 100;
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
  if (totalPnl > 0) {
    user.stats.wins += 1;
    user.stats.currentStreak = Math.max(0, user.stats.currentStreak) + 1;
    user.stats.bestStreak = Math.max(user.stats.bestStreak, user.stats.currentStreak);
    user.stats.bestTrade = Math.max(user.stats.bestTrade, totalPnl);
  } else {
    user.stats.losses += 1;
    user.stats.currentStreak = Math.min(0, user.stats.currentStreak) - 1;
    user.stats.worstTrade = Math.min(user.stats.worstTrade, totalPnl);
  }
  user.stats.totalPnl += totalPnl;
  await user.save();

  recordTradeOutcome(trade)
    .then(() => adjustWeights().catch(err => console.error('[PaperTrading] AdjustWeights error:', err.message)))
    .catch(err => console.error('[PaperTrading] Learn error:', err.message));

  return trade;
}

function logTradeAction(trade, type, description, oldValue, newValue, marketPrice) {
  if (!Array.isArray(trade.actions)) trade.actions = [];
  trade.actions.push({
    type,
    description,
    oldValue: oldValue != null ? oldValue : undefined,
    newValue: newValue != null ? newValue : undefined,
    marketPrice: marketPrice != null ? marketPrice : undefined,
    timestamp: new Date()
  });
}

async function checkStopsAndTPs(getCurrentPriceFunc) {
  const openTrades = await Trade.find({ status: 'OPEN' });
  let closedCount = 0;

  for (const trade of openTrades) {
    const priceData = getCurrentPriceFunc(trade.coinId);
    if (!priceData) {
      console.warn(`[StopTP] No price for ${trade.symbol} (${trade.coinId}) – skipping`);
      continue;
    }
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

    // Backfill originalStopLoss for existing trades
    if (trade.originalStopLoss == null && trade.stopLoss != null) {
      trade.originalStopLoss = trade.stopLoss;
    }

    const user = await User.findById(trade.userId);
    const autoBE = user?.settings?.autoMoveBreakeven !== false;
    const autoTrail = user?.settings?.autoTrailingStop !== false;

    // Risk (1R) = distance from entry to original stop
    const origSl = trade.originalStopLoss || trade.stopLoss;
    let risk = trade.direction === 'LONG'
      ? trade.entryPrice - (origSl || 0)
      : (origSl || 0) - trade.entryPrice;
    if (risk <= 0) {
      const tp = trade.takeProfit2 || trade.takeProfit1 || trade.takeProfit3;
      if (tp) risk = Math.abs(trade.entryPrice - tp) / (tp === trade.takeProfit2 ? 2 : 1);
    }

    if (risk > 0 && trade.stopLoss != null) {
      // Breakeven at 1R (if autoMoveBreakeven)
      if (autoBE && trade.stopLoss !== trade.entryPrice) {
        const at1R = trade.direction === 'LONG' ? currentPrice >= trade.entryPrice + risk : currentPrice <= trade.entryPrice - risk;
        if (at1R) {
          const oldSl = trade.stopLoss;
          trade.stopLoss = trade.entryPrice;
          logTradeAction(trade, 'BE', `Stop moved to breakeven at $${trade.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} (was $${(oldSl || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })})`, oldSl, trade.entryPrice, currentPrice);
          await trade.save();
        }
      }

      // Trailing stop at 1.5R+ (if autoTrailingStop) - trail at 1R behind max favorable price
      if (autoTrail && trade.stopLoss === trade.entryPrice) {
        const at1_5R = trade.direction === 'LONG' ? currentPrice >= trade.entryPrice + risk * 1.5 : currentPrice <= trade.entryPrice - risk * 1.5;
        if (at1_5R) {
          trade.trailingActivated = true;
          const trailSL = trade.direction === 'LONG'
            ? trade.maxPrice - risk
            : trade.minPrice + risk;
          const r2 = (v) => Math.round(v * 1000000) / 1000000;
          const newStop = r2(trailSL);
          const isLong = trade.direction === 'LONG';
          const validMove = isLong ? newStop > trade.stopLoss && newStop < currentPrice : newStop < trade.stopLoss && newStop > currentPrice;
          if (validMove) {
            const oldSl = trade.stopLoss;
            trade.stopLoss = newStop;
            logTradeAction(trade, 'TS', `Stop trailed to $${newStop.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} (was $${(oldSl || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })})`, oldSl, newStop, currentPrice);
            await trade.save();
          }
        }
      }

      // Stepped profit lock-in when trailing is OFF
      if (!autoTrail || !trade.trailingActivated) {
        const progress = getProgressTowardTP(trade, currentPrice);
        let effectiveProgress = progress;
        if (progress <= 0 && trade.entryPrice > 0) {
          const pnlPct = trade.direction === 'LONG'
            ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100
            : (trade.entryPrice - currentPrice) / trade.entryPrice * 100;
          if (pnlPct >= 5) effectiveProgress = 0.9;
          else if (pnlPct >= 2) effectiveProgress = 0.5;
        }
        const currentLockR = getCurrentLockR(trade, risk);
        for (const level of LOCK_IN_LEVELS) {
          if (effectiveProgress >= level.progress && currentLockR < level.lockR) {
            const newStop = getLockInStopPrice(trade, level.lockR, risk);
            if (newStop) {
              const isLong = trade.direction === 'LONG';
              const validMove = isLong ? newStop > trade.stopLoss && newStop < currentPrice : newStop < trade.stopLoss && newStop > currentPrice;
              if (validMove) {
                const oldSl = trade.stopLoss;
                trade.stopLoss = newStop;
                logTradeAction(trade, 'TS', `Stop locked in ${level.lockR}R: $${newStop.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} (was $${(oldSl || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })})`, oldSl, newStop, currentPrice);
                await trade.save();
                break;
              }
            }
          }
        }
      }
    }
    await trade.save();

    const hitTP1Long = trade.direction === 'LONG' && trade.takeProfit1 && currentPrice >= trade.takeProfit1;
    const hitTP2Long = trade.direction === 'LONG' && trade.takeProfit2 && currentPrice >= trade.takeProfit2;
    const hitTP3Long = trade.direction === 'LONG' && trade.takeProfit3 && currentPrice >= trade.takeProfit3;
    const hitTP1Short = trade.direction === 'SHORT' && trade.takeProfit1 && currentPrice <= trade.takeProfit1;
    const hitTP2Short = trade.direction === 'SHORT' && trade.takeProfit2 && currentPrice <= trade.takeProfit2;
    const hitTP3Short = trade.direction === 'SHORT' && trade.takeProfit3 && currentPrice <= trade.takeProfit3;

    const slippage = 1 + (SLIPPAGE_BPS / 10000);
    if (trade.direction === 'LONG') {
      if (trade.stopLoss != null && currentPrice <= trade.stopLoss) {
        await closeTrade(trade.userId, trade._id, trade.stopLoss, 'STOPPED_OUT');
        closedCount++;
        continue;
      }
      let handled = false;
      const orig = trade.originalPositionSize || trade.positionSize;
      const exit3 = trade.takeProfit3 ? trade.takeProfit3 / slippage : 0;
      const exit2 = trade.takeProfit2 ? trade.takeProfit2 / slippage : 0;
      const exit1 = trade.takeProfit1 ? trade.takeProfit1 / slippage : 0;
      if (trade.takeProfit3 && hitTP3Long) {
        const exitPx = trade.takeProfit3 / slippage;
        await closeTrade(trade.userId, trade._id, exitPx, 'TP3');
        closedCount++;
        handled = true;
      } else if (trade.takeProfit2 && hitTP2Long && !trade.partialTakenAtTP2) {
        if (!trade.takeProfit3) {
          await closeTrade(trade.userId, trade._id, trade.takeProfit2 / slippage, 'TP2');
        } else {
          const portion = Math.round((orig / 3) * 100) / 100;
          await closeTradePartial(trade, exit2, portion, 'TP2');
        }
        closedCount++;
        handled = true;
      } else if (trade.takeProfit1 && hitTP1Long && !trade.partialTakenAtTP1) {
        if (!trade.takeProfit2 && !trade.takeProfit3) {
          await closeTrade(trade.userId, trade._id, trade.takeProfit1 / slippage, 'TP1');
        } else if (trade.takeProfit2 && !trade.takeProfit3) {
          const portion = Math.round((orig / 2) * 100) / 100;
          await closeTradePartial(trade, exit1, portion, 'TP1');
        } else {
          const portion = Math.round((orig / 3) * 100) / 100;
          await closeTradePartial(trade, exit1, portion, 'TP1');
        }
        closedCount++;
        handled = true;
      }
      if (handled) continue;
    } else {
      if (trade.stopLoss && currentPrice >= trade.stopLoss) {
        await closeTrade(trade.userId, trade._id, trade.stopLoss, 'STOPPED_OUT');
        closedCount++;
        continue;
      }
      let handled = false;
      const orig = trade.originalPositionSize || trade.positionSize;
      const exit3 = trade.takeProfit3 ? trade.takeProfit3 * slippage : 0;
      const exit2 = trade.takeProfit2 ? trade.takeProfit2 * slippage : 0;
      const exit1 = trade.takeProfit1 ? trade.takeProfit1 * slippage : 0;
      if (trade.takeProfit3 && hitTP3Short) {
        await closeTrade(trade.userId, trade._id, trade.takeProfit3 * slippage, 'TP3');
        closedCount++;
        handled = true;
      } else if (trade.takeProfit2 && hitTP2Short && !trade.partialTakenAtTP2) {
        if (!trade.takeProfit3) {
          await closeTrade(trade.userId, trade._id, trade.takeProfit2 * slippage, 'TP2');
        } else {
          const portion = Math.round((orig / 3) * 100) / 100;
          await closeTradePartial(trade, exit2, portion, 'TP2');
        }
        closedCount++;
        handled = true;
      } else if (trade.takeProfit1 && hitTP1Short && !trade.partialTakenAtTP1) {
        if (!trade.takeProfit2 && !trade.takeProfit3) {
          await closeTrade(trade.userId, trade._id, trade.takeProfit1 * slippage, 'TP1');
        } else if (trade.takeProfit2 && !trade.takeProfit3) {
          const portion = Math.round((orig / 2) * 100) / 100;
          await closeTradePartial(trade, exit1, portion, 'TP1');
        } else {
          const portion = Math.round((orig / 3) * 100) / 100;
          await closeTradePartial(trade, exit1, portion, 'TP1');
        }
        closedCount++;
        handled = true;
      }
      if (handled) continue;
    }
  }

  if (closedCount > 0) {
    console.log(`[PaperTrading] Auto-closed ${closedCount} trades`);
  }
}

// ====================================================
// TRADE SCORE RE-CHECK (runs every 5 min while trades open)
// Compares current signal with entry state and generates
// actionable status messages for each open trade.
// ====================================================
const SCORE_RECHECK_MINUTES = 5;

// ---- Win Probability ----
// Maps score (0-100) to an estimated win probability percentage.
// Non-linear: higher scores yield disproportionately higher probability.
function calculateWinProbability(score) {
  if (score >= 85) return 88;
  if (score >= 75) return 75;
  if (score >= 65) return 62;
  if (score >= 55) return 52;
  if (score >= 45) return 40;
  if (score >= 35) return 28;
  if (score >= 25) return 18;
  return 12;
}

// ---- What Changed? ----
// Compares each breakdown dimension (entry vs current) and explains WHY.
// For SHORT: dimension drop = more bearish = favorable. Use SHORT-specific text so green makes sense.
function determineChangeReasons(trade, signal) {
  const reasons = [];
  const eb = trade.scoreBreakdownAtEntry || {};
  const cb = signal.scoreBreakdown || {};
  if (typeof eb.trend !== 'number') return reasons;
  const isLong = trade.direction === 'LONG';

  const dims = [
    { key: 'trend',      negText: 'HTF lost alignment',   posText: 'HTF trend strengthened', shortFavText: 'HTF bullish bias fading', shortUnfavText: 'HTF bullish bias strengthening' },
    { key: 'momentum',   negText: 'Momentum divergence',  posText: 'Momentum increasing', shortFavText: 'Bullish momentum fading', shortUnfavText: 'Bullish momentum building' },
    { key: 'volume',     negText: 'Volume fading',        posText: 'Volume confirming', shortFavText: 'Buying volume fading', shortUnfavText: 'Buying volume confirming' },
    { key: 'structure',  negText: 'Structure break',      posText: 'Structure improved', invertForShort: false },
    { key: 'volatility', negText: 'Volatility spike',     posText: 'Volatility normalized', shortFavText: 'Volatility spike' },
    { key: 'riskQuality',negText: 'Risk/reward degraded', posText: 'Risk/reward improved', shortFavText: 'Risk/reward shifted', shortUnfavText: 'Risk/reward shifting against short' }
  ];

  for (const d of dims) {
    const diff = (cb[d.key] || 0) - (eb[d.key] || 0);
    if (diff <= -3) {
      if (d.invertForShort === false) {
        reasons.push({ type: 'negative', text: d.negText });
      } else {
        reasons.push({ type: isLong ? 'negative' : 'positive', text: isLong ? d.negText : (d.shortFavText || d.negText) });
      }
    } else if (diff >= 3) {
      if (d.invertForShort === false) {
        reasons.push({ type: 'positive', text: d.posText });
      } else {
        reasons.push({ type: isLong ? 'positive' : 'negative', text: isLong ? d.posText : (d.shortUnfavText || d.posText) });
      }
    }
  }

  if (reasons.length === 0) {
    reasons.push({ type: 'neutral', text: 'No significant changes detected' });
  }
  return reasons;
}

// ---- Heat Indicator ----
// Green = stable, Yellow = weakening, Red = danger
// For SHORT: negative scoreDiff = more bearish = favorable, so we invert
// Relaxed: -15→-20 for red (need bigger score drop before danger)
function determineHeat(scoreDiff, messages, isLong) {
  const effective = isLong ? scoreDiff : -scoreDiff;  // For short, neg diff = good
  const hasDanger = messages.some(m => m.type === 'danger');
  const hasWarning = messages.some(m => m.type === 'warning');
  // When score moved 20+ in our favor, downgrade danger – thesis still strong
  if (effective >= 20 && hasDanger) return 'yellow';
  if (effective >= 20 && hasWarning) return 'green';
  if (hasDanger || effective <= -20) return 'red';
  if (hasWarning || effective <= -5) return 'yellow';
  return 'green';
}

// ---- Suggested Action Ladder ----
// For SHORT: negative scoreDiff = more bearish = favorable. When score strongly in favor, don't suggest exit.
// Each action has actionId for execution (when autoExecuteActions enabled).
// Confluence: P&L and price progress block aggressive actions on favorable trades.
function determineSuggestedAction(scoreDiff, heat, messages, isLong, trade, currentPrice) {
  const effective = isLong ? scoreDiff : -scoreDiff;
  const structureBreaking = messages.some(m => m.text === 'Structure breaking');
  const considerPartial = messages.some(m => m.text === 'Consider partial');
  const considerBE = messages.some(m => m.text === 'Consider BE stop');
  const hasDanger = messages.some(m => m.type === 'danger');

  // P&L in percent (positive = profit)
  const pnlPct = trade.entryPrice > 0
    ? (isLong ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice)) / trade.entryPrice * 100
    : 0;
  const inProfit2Pct = pnlPct >= 2;

  // Progress toward TP2 (0–1)
  const tp2 = trade.takeProfit2;
  let progressToTP2 = 0;
  if (tp2) {
    if (isLong && tp2 > trade.entryPrice) {
      progressToTP2 = (currentPrice - trade.entryPrice) / (tp2 - trade.entryPrice);
    } else if (!isLong && tp2 < trade.entryPrice) {
      progressToTP2 = (trade.entryPrice - currentPrice) / (trade.entryPrice - tp2);
    }
  }
  const nearTP2 = progressToTP2 >= 0.5;

  // When score moved 20+ in our favor (thesis strong), never suggest exit
  if (effective >= 20) {
    if (structureBreaking) return { level: 'medium', actionId: 'hold_monitor', text: 'Hold — monitor structure' };
    return { level: 'positive', actionId: 'hold', text: 'Hold — strengthening' };
  }

  // Consider exit: require multiple confirmations AND block when trade is favorable
  // Block if: in profit 2%+ OR 50%+ toward TP2 (don't kick out winning trades)
  const wouldConsiderExit = (heat === 'red' && hasDanger && effective <= -25) || effective <= -30;
  const blockExit = inProfit2Pct || nearTP2;
  if (wouldConsiderExit && !blockExit) {
    return { level: 'extreme', actionId: 'consider_exit', text: 'Consider exit' };
  }
  // Downgrade to reduce if we would exit but trade is favorable
  if (wouldConsiderExit && blockExit && (effective <= -15 || structureBreaking)) {
    return { level: 'high', actionId: 'reduce_position', text: 'Reduce position' };
  }

  if (effective <= -15 || structureBreaking) {
    return { level: 'high', actionId: 'reduce_position', text: 'Reduce position' };
  }
  if (considerPartial) {
    return { level: 'medium', actionId: 'take_partial', text: 'Take partial' };
  }
  const lockInAvailable = messages.some(m => m.text === 'Lock in profit available');
  if (lockInAvailable) {
    return { level: 'medium', actionId: 'lock_in_profit', text: 'Lock in profit (0.5R)' };
  }
  if (heat === 'yellow' || effective <= -5 || considerBE) {
    return { level: 'medium', actionId: 'tighten_stop', text: 'Tighten stop' };
  }
  if (effective >= 5) {
    return { level: 'positive', actionId: 'hold', text: 'Hold — strengthening' };
  }
  return { level: 'low', actionId: 'monitor', text: 'Monitor' };
}

// ---- Execute Suggested Action (when autoExecuteActions enabled) ----
// Only executes if actionId is actionable and different from last executed.
// Returns { executed, details } where details describes what changed.
async function executeScoreCheckAction(trade, suggestedAction, currentPrice, getCurrentPriceFunc) {
  const actionId = suggestedAction?.actionId;
  if (!actionId || ['hold', 'hold_monitor', 'monitor'].includes(actionId)) return { executed: false };
  if (trade.lastExecutedActionId === actionId) return { executed: false };

  const priceData = getCurrentPriceFunc(trade.coinId);
  const price = priceData?.price ?? currentPrice;
  const slippage = 1 + (SLIPPAGE_BPS / 10000);
  const exitPrice = trade.direction === 'LONG' ? price / slippage : price * slippage;
  const fp = (v) => typeof v === 'number' ? v.toFixed(v >= 1 ? 2 : 6) : String(v);

  try {
    if (actionId === 'consider_exit') {
      const sizeBefore = trade.positionSize;
      await closeTrade(trade.userId, trade._id, price, 'SCORE_CHECK_EXIT');
      const details = `Closed entire position ($${fp(sizeBefore)}) at $${fp(price)}`;
      console.log(`[ScoreCheck] ${details}`);
      return { executed: true, details };
    }
    if (actionId === 'reduce_position') {
      const orig = trade.originalPositionSize || trade.positionSize;
      const portion = Math.round((orig * 0.5) * 100) / 100;
      const sizeBefore = trade.positionSize;
      await closeTradePartial(trade, exitPrice, portion, 'SCORE_CHECK_PARTIAL');
      trade.lastExecutedActionId = actionId;
      const details = `Reduced 50%: $${fp(sizeBefore)} → $${fp(trade.positionSize)} at $${fp(exitPrice)}`;
      trade.scoreCheck = trade.scoreCheck || {};
      trade.scoreCheck.lastActionDetails = details;
      await trade.save();
      console.log(`[ScoreCheck] ${details}`);
      return { executed: true, details };
    }
    if (actionId === 'take_partial') {
      const orig = trade.originalPositionSize || trade.positionSize;
      const portion = Math.round((orig / 3) * 100) / 100;
      const sizeBefore = trade.positionSize;
      await closeTradePartial(trade, exitPrice, portion, 'SCORE_CHECK_PARTIAL');
      trade.lastExecutedActionId = actionId;
      const details = `Partial 1/3: $${fp(sizeBefore)} → $${fp(trade.positionSize)} at $${fp(exitPrice)}`;
      trade.scoreCheck = trade.scoreCheck || {};
      trade.scoreCheck.lastActionDetails = details;
      await trade.save();
      console.log(`[ScoreCheck] ${details}`);
      return { executed: true, details };
    }
    if (actionId === 'tighten_stop') {
      if (!trade.stopLoss) return { executed: false };
      const origSl = trade.originalStopLoss || trade.stopLoss;
      let risk = trade.direction === 'LONG'
        ? trade.entryPrice - (origSl || 0)
        : (origSl || 0) - trade.entryPrice;
      if (risk <= 0) {
        const tp = trade.takeProfit2 || trade.takeProfit1 || trade.takeProfit3;
        if (tp) risk = Math.abs(trade.entryPrice - tp) / (tp === trade.takeProfit2 ? 2 : 1);
      }
      if (risk > 0 && trade.stopLoss !== trade.entryPrice) {
        const oldStop = trade.stopLoss;
        trade.stopLoss = trade.entryPrice;
        trade.lastExecutedActionId = actionId;
        const details = `Stop tightened: $${fp(oldStop)} → $${fp(trade.entryPrice)} (breakeven)`;
        logTradeAction(trade, 'BE', details, oldStop, trade.entryPrice, price);
        trade.scoreCheck = trade.scoreCheck || {};
        trade.scoreCheck.lastActionDetails = details;
        await trade.save();
        console.log(`[ScoreCheck] ${details}`);
        return { executed: true, details };
      }
      return { executed: false };
    }
    if (actionId === 'lock_in_profit') {
      if (!trade.stopLoss) return { executed: false };
      const origSl = trade.originalStopLoss || trade.stopLoss;
      let risk = trade.direction === 'LONG'
        ? trade.entryPrice - (origSl || 0)
        : (origSl || 0) - trade.entryPrice;
      if (risk <= 0) {
        const tp = trade.takeProfit2 || trade.takeProfit1 || trade.takeProfit3;
        if (tp) risk = Math.abs(trade.entryPrice - tp) / (tp === trade.takeProfit2 ? 2 : 1);
      }
      if (risk <= 0) return { executed: false };
      const currentLockR = getCurrentLockR(trade, risk);
      const progress = getProgressTowardTP(trade, price);
      let effectiveProgress = progress;
      if (progress <= 0 && trade.entryPrice > 0) {
        const pnlPct = trade.direction === 'LONG' ? (price - trade.entryPrice) / trade.entryPrice * 100 : (trade.entryPrice - price) / trade.entryPrice * 100;
        if (pnlPct >= 5) effectiveProgress = 0.9;
        else if (pnlPct >= 2) effectiveProgress = 0.5;
      }
      for (const level of LOCK_IN_LEVELS) {
        if (effectiveProgress >= level.progress && currentLockR < level.lockR) {
          const newStop = getLockInStopPrice(trade, level.lockR, risk);
          if (newStop) {
            const isLong = trade.direction === 'LONG';
            const validMove = isLong ? newStop > trade.stopLoss && newStop < price : newStop < trade.stopLoss && newStop > price;
            if (validMove) {
              const oldStop = trade.stopLoss;
              trade.stopLoss = newStop;
              trade.lastExecutedActionId = actionId;
              const details = `Locked in ${level.lockR}R: $${fp(oldStop)} → $${fp(newStop)}`;
              logTradeAction(trade, 'TS', details, oldStop, newStop, price);
              trade.scoreCheck = trade.scoreCheck || {};
              trade.scoreCheck.lastActionDetails = details;
              await trade.save();
              console.log(`[ScoreCheck] ${details}`);
              return { executed: true, details };
            }
          }
          break;
        }
      }
      return { executed: false };
    }
  } catch (err) {
    console.error(`[ScoreCheck] Execute action ${actionId} failed:`, err.message);
    return { executed: false };
  }
  return { executed: false };
}

function generateScoreCheckMessages(trade, signal, currentPrice) {
  const messages = [];
  const entryScore = trade.score || 0;
  const currentScore = signal.score || 0;
  const scoreDiff = currentScore - entryScore;

  const eb = trade.scoreBreakdownAtEntry || {};
  const cb = signal.scoreBreakdown || {};
  const hasEntryBreakdown = typeof eb.momentum === 'number';

  const isLong = trade.direction === 'LONG';

  // Signal direction flipped? (market now says opposite of our trade)
  const signalFlipped = isLong
    ? (signal.signal === 'SELL' || signal.signal === 'STRONG_SELL')
    : (signal.signal === 'BUY' || signal.signal === 'STRONG_BUY');

  // For SHORT: negative scoreDiff = more bearish = favorable. Only "setup invalidated" when score moves AGAINST us.
  const scoreDiffAgainstUs = isLong ? scoreDiff : -scoreDiff;  // Negative = bad for our trade

  // 1. Setup invalidated (most severe) - score moved heavily against our direction
  // For LONG: low score = bearish = bad. For SHORT: high score = bullish = bad.
  // Relaxed: 35→30 / 65→70; scoreDiff -20→-25 to reduce false positives
  const scoreAgainstUs = isLong ? currentScore < 30 : currentScore > 70;
  if (signalFlipped || scoreAgainstUs || scoreDiffAgainstUs <= -25) {
    messages.push({ type: 'danger', text: 'Setup invalidated' });
  }

  // 2. Structure breaking (bad for both directions) – relaxed 4→6 to reduce noise
  if (hasEntryBreakdown && (cb.structure || 0) <= (eb.structure || 0) - 6) {
    messages.push({ type: 'danger', text: 'Structure breaking' });
  }

  // 3. Momentum: for LONG, drop = warning. For SHORT, drop = favorable (bullish momentum fading)
  if (hasEntryBreakdown && (cb.momentum || 0) <= (eb.momentum || 0) - 3) {
    if (isLong) {
      messages.push({ type: 'warning', text: 'Momentum weakening' });
    } else {
      messages.push({ type: 'positive', text: 'Bullish momentum fading' });
    }
  }

  // 4. Confidence increasing - score moved in our favor
  const scoreDiffInFavor = isLong ? scoreDiff : -scoreDiff;
  if (scoreDiffInFavor >= 5 && !signalFlipped) {
    messages.push({ type: 'positive', text: 'Confidence increasing' });
  }

  // 5. TP probability rising (price progressing toward TP2 & score in our favor)
  const tp2 = trade.takeProfit2;
  if (tp2) {
    let progress = 0;
    if (isLong && tp2 > trade.entryPrice) {
      progress = (currentPrice - trade.entryPrice) / (tp2 - trade.entryPrice);
    } else if (!isLong && tp2 < trade.entryPrice) {
      progress = (trade.entryPrice - currentPrice) / (trade.entryPrice - tp2);
    }
    const scoreInFavor = isLong ? currentScore >= 50 : currentScore < 50;  // Long: bullish; Short: bearish
    if (progress >= 0.5 && scoreInFavor) {
      messages.push({ type: 'positive', text: 'TP probability rising' });
    }
  }

  // 6. Consider partial (near TP1 with signals weakening for our direction)
  const tp1 = trade.takeProfit1;
  if (tp1) {
    const nearTP1 = isLong
      ? currentPrice >= tp1 * 0.98
      : currentPrice <= tp1 * 1.02;
    const weakening = scoreDiffAgainstUs < 0 ||  // score moved against us
      (hasEntryBreakdown && (cb.momentum || 0) < (eb.momentum || 0));
    if (nearTP1 && weakening) {
      messages.push({ type: 'info', text: 'Consider partial' });
    }
  }

  // 7. Consider BE stop (1R+ in profit, stop not yet at breakeven)
  const sl = trade.stopLoss;
  let riskForLock = sl != null ? (isLong ? trade.entryPrice - sl : sl - trade.entryPrice) : 0;
  if (riskForLock <= 0) {
    const tp = trade.takeProfit2 || trade.takeProfit1 || trade.takeProfit3;
    if (tp) riskForLock = Math.abs(trade.entryPrice - tp) / (tp === trade.takeProfit2 ? 2 : 1);
  }
  if (sl != null && riskForLock > 0) {
    const inProfit1R = isLong
      ? currentPrice >= trade.entryPrice + riskForLock
      : currentPrice <= trade.entryPrice - riskForLock;
    const stopNotBE = isLong ? sl < trade.entryPrice : sl > trade.entryPrice;
    if (inProfit1R && stopNotBE) {
      messages.push({ type: 'info', text: 'Consider BE stop' });
    }
  }

  // 8. Lock in profit: progress toward TP2 allows stepping stop to lock gains
  const progressTowardTP = getProgressTowardTP(trade, currentPrice);
  let effectiveProgress = progressTowardTP;
  if (progressTowardTP <= 0 && trade.entryPrice > 0) {
    const pnlPct = isLong ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100 : (trade.entryPrice - currentPrice) / trade.entryPrice * 100;
    if (pnlPct >= 5) effectiveProgress = 0.9;
    else if (pnlPct >= 2) effectiveProgress = 0.5;
  }
  if (riskForLock > 0 && trade.stopLoss != null) {
    const currentLockR = getCurrentLockR(trade, riskForLock);
    if (currentLockR >= 0.5) {
      const label = currentLockR >= 1 ? '1R' : currentLockR >= 0.75 ? '0.75R' : '0.5R';
      messages.push({ type: 'positive', text: 'Profit locked: ' + label });
    } else if (effectiveProgress >= 0.5) {
      messages.push({ type: 'info', text: 'Lock in profit available' });
    }
  }

  // Default: neutral status when nothing noteworthy
  if (messages.length === 0) {
    if (scoreDiffInFavor >= 0) {
      messages.push({ type: 'positive', text: 'Score holding steady' });
    } else {
      messages.push({ type: 'warning', text: 'Score slightly lower' });
    }
  }

  return messages;
}

async function recheckTradeScores(getSignalForCoin, getCurrentPriceFunc) {
  const openTrades = await Trade.find({ status: 'OPEN' });
  if (openTrades.length === 0) return;

  let checkedCount = 0;
  for (const trade of openTrades) {
    try {
      const priceData = getCurrentPriceFunc(trade.coinId);
      if (!priceData) {
        console.warn(`[ScoreCheck] No price data for ${trade.symbol} (${trade.coinId}) – skipping`);
        continue;
      }
      const currentPrice = priceData.price;

      const signal = await getSignalForCoin(trade.coinId);
      if (!signal) {
        console.warn(`[ScoreCheck] No signal for ${trade.symbol} (${trade.coinId}) – skipping`);
        continue;
      }

      const messages = generateScoreCheckMessages(trade, signal, currentPrice);
      const scoreDiff = (signal.score || 0) - (trade.score || 0);
      const changeReasons = determineChangeReasons(trade, signal);
      const isLong = trade.direction === 'LONG';
      const heat = determineHeat(scoreDiff, messages, isLong);
      const suggestedAction = determineSuggestedAction(scoreDiff, heat, messages, isLong, trade, currentPrice);
      // Win prob: for LONG, high score = high prob. For SHORT, low score (bearish) = high prob.
      const entryScore = trade.score || 0;
      const currentScore = signal.score || 0;
      const entryProbRaw = calculateWinProbability(entryScore);
      const currentProbRaw = calculateWinProbability(currentScore);
      const entryProbability = Math.min(100, Math.max(0, isLong ? entryProbRaw : 100 - entryProbRaw));
      const currentProbability = Math.min(100, Math.max(0, isLong ? currentProbRaw : 100 - currentProbRaw));

      const scoreDiffFavorable = isLong ? scoreDiff >= 0 : scoreDiff <= 0;
      const scoreDiffDisplay = isLong ? scoreDiff : -scoreDiff;  // For short, show as positive when favorable

      trade.scoreCheck = {
        currentScore: signal.score,
        entryScore: trade.score || 0,
        scoreDiff,
        scoreDiffFavorable,
        scoreDiffDisplay,
        currentBreakdown: signal.scoreBreakdown || {},
        regime: signal.regime,
        signal: signal.signal,
        confidence: signal.confidence,
        messages,
        entryProbability,
        currentProbability,
        changeReasons,
        suggestedAction,
        heat,
        checkedAt: new Date()
      };

      // Append to score history for timeline (cap at 100 entries)
      if (!Array.isArray(trade.scoreHistory)) trade.scoreHistory = [];
      trade.scoreHistory.push({
        score: signal.score || 0,
        probability: currentProbability,
        heat,
        checkedAt: new Date()
      });
      if (trade.scoreHistory.length > 100) {
        trade.scoreHistory = trade.scoreHistory.slice(-100);
      }

      trade.updatedAt = new Date();
      await trade.save();
      checkedCount++;

      // Auto-execute suggested action if user has enabled it
      const user = await User.findById(trade.userId);
      if (user?.settings?.autoExecuteActions && suggestedAction?.actionId) {
        await executeScoreCheckAction(trade, suggestedAction, currentPrice, getCurrentPriceFunc);
      }
    } catch (err) {
      console.error(`[ScoreCheck] Error rechecking ${trade.symbol}:`, err.message);
    }
  }

  if (checkedCount > 0) {
    console.log(`[ScoreCheck] Rechecked ${checkedCount} open trades`);
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
  const pfNum = avgLoss > 0 && losses.length > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 0;
  const profitFactor = Number.isFinite(pfNum) ? pfNum : 0;

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

  // Sharpe, Sortino, max drawdown, equity curve
  const initialBalance = user.initialBalance || 10000;
  const sortedByExit = [...closedTrades].filter(t => t.exitTime).sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
  let equity = initialBalance;
  let peak = initialBalance;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  const equityCurve = [{ date: new Date(0).toISOString(), equity: initialBalance, drawdown: 0, drawdownPct: 0 }];

  for (const t of sortedByExit) {
    equity += t.pnl || 0;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    equityCurve.push({
      date: t.exitTime,
      equity: Math.round(equity * 100) / 100,
      drawdown: Math.round(dd * 100) / 100,
      drawdownPct: Math.round(ddPct * 100) / 100,
      pnl: t.pnl,
      regime: t.regime,
      symbol: t.symbol
    });
  }

  // Sharpe & Sortino from trade returns (pnl/margin = % return per trade)
  const returns = sortedByExit.filter(t => t.margin > 0).map(t => (t.pnl || 0) / t.margin);
  const meanRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (returns.length - 1) : 0;
  const stdRet = Math.sqrt(variance);
  const downsideReturns = returns.filter(r => r < 0);
  const downsideVar = downsideReturns.length > 0
    ? downsideReturns.reduce((s, r) => s + r * r, 0) / downsideReturns.length
    : 0;
  const downsideStd = Math.sqrt(downsideVar);

  const sharpe = stdRet > 0 ? meanRet / stdRet : 0;
  const sortino = downsideStd > 0 ? meanRet / downsideStd : (meanRet >= 0 ? (returns.length > 0 ? 99 : 0) : -99);

  return {
    balance: user.paperBalance,
    initialBalance,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalPnlPercent: initialBalance > 0 ? ((totalPnl / initialBalance) * 100).toFixed(2) : '0',
    totalTrades: closedTrades.length,
    openTrades: openTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closedTrades.length > 0 ? ((wins.length / closedTrades.length) * 100).toFixed(1) : '0',
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: (typeof profitFactor === 'number' ? profitFactor : 0).toFixed(2),
    bestTrade: (user.stats && user.stats.bestTrade) ?? 0,
    worstTrade: (user.stats && user.stats.worstTrade) ?? 0,
    currentStreak: (user.stats && user.stats.currentStreak) ?? 0,
    bestStreak: (user.stats && user.stats.bestStreak) ?? 0,
    pnl7d: Math.round(pnl7d * 100) / 100,
    byStrategy,
    byCoin,
    sharpe: returns.length >= 2 ? Math.round(sharpe * 100) / 100 : null,
    sortino: returns.length >= 2 ? Math.round(sortino * 100) / 100 : null,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    equityCurve
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
  recheckTradeScores,
  SCORE_RECHECK_MINUTES,
  getOpenTrades,
  getTradeHistory,
  getPerformanceStats,
  resetAccount
};
