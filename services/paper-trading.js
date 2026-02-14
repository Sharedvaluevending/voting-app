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
const bitget = require('./bitget');

const DEFAULT_MAKER_FEE = 0.001;
const DEFAULT_TAKER_FEE = 0.001;
function getMakerFee(user) {
  const pct = user?.settings?.makerFeePercent;
  return (Number.isFinite(pct) ? pct / 100 : DEFAULT_MAKER_FEE);
}
function getTakerFee(user) {
  const pct = user?.settings?.takerFeePercent;
  return (Number.isFinite(pct) ? pct / 100 : DEFAULT_TAKER_FEE);
}
const SLIPPAGE_BPS = 5;           // 0.05% slippage simulation
const DEFAULT_COOLDOWN_HOURS = 4;  // no same-direction re-entry on same coin within N hours

// Take-profit position split: balanced scale-out
const TP1_PCT = 0.4;   // 40% at TP1
const TP2_PCT = 0.3;   // 30% at TP2
const TP3_PCT = 0.3;   // 30% at TP3 (remaining)

// Stepped profit lock-in: progress toward TP -> lock-in level (R-multiple)
const LOCK_IN_LEVELS = [
  { progress: 0.5, lockR: 0.5 },
  { progress: 0.75, lockR: 0.75 },
  { progress: 0.9, lockR: 1 }
];

function getProgressTowardTP(trade, currentPrice) {
  const tp = trade.takeProfit2 || trade.takeProfit1 || trade.takeProfit3;
  if (!tp || !trade.entryPrice || tp === trade.entryPrice) return 0;
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

  if (regime === 'ranging' || regime === 'mixed') {
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

  // If user has disabled leverage, force 1x regardless of signal/default
  const leverage = user.settings?.disableLeverage ? 1 : (signalData.leverage || user.settings?.defaultLeverage || 1);
  const riskPercent = user.settings?.riskPerTrade || 2;
  const maxBalancePct = user.settings?.maxBalancePercentPerTrade ?? 25;
  // Slippage: worse entry (LONG pay more, SHORT receive less)
  const slippage = 1 + (SLIPPAGE_BPS / 10000);
  const entryPrice = signalData.direction === 'LONG'
    ? signalData.entry * slippage
    : signalData.entry / slippage;
  let stopLoss = signalData.stopLoss;

  // CAP STOP LOSS DISTANCE: prevent absurdly wide stops (max 15% from entry)
  // This protects against bad support/resistance calculations setting stops way too far
  const MAX_SL_DISTANCE_PCT = 0.15;
  if (stopLoss != null && entryPrice > 0) {
    const slDistance = Math.abs(entryPrice - stopLoss) / entryPrice;
    if (slDistance > MAX_SL_DISTANCE_PCT) {
      const cappedSL = signalData.direction === 'LONG'
        ? entryPrice * (1 - MAX_SL_DISTANCE_PCT)
        : entryPrice * (1 + MAX_SL_DISTANCE_PCT);
      console.warn(`[OpenTrade] ${signalData.symbol}: SL too far (${(slDistance * 100).toFixed(1)}% from entry). Capping: $${stopLoss} → $${cappedSL.toFixed(6)}`);
      stopLoss = parseFloat(cappedSL.toFixed(6));
    }
  }

  let positionSize = calculatePositionSize(
    user.paperBalance, riskPercent, entryPrice, stopLoss, leverage
  );
  // Confidence-weighted size: scale by score (0.5 + score/100), cap 1.2
  const score = Math.min(100, Math.max(0, signalData.score || 50));
  const confidenceMult = Math.min(1.2, 0.5 + score / 100);
  positionSize = positionSize * confidenceMult;

  // Win/loss streak adjustment: reduce size after consecutive losses, slight boost after wins
  const streak = user.stats?.currentStreak || 0;
  if (streak <= -3) {
    // 3+ consecutive losses: reduce position by 40%
    positionSize *= 0.6;
  } else if (streak <= -2) {
    // 2 consecutive losses: reduce by 25%
    positionSize *= 0.75;
  } else if (streak >= 3) {
    // 3+ wins: small boost (max 15%)
    positionSize *= Math.min(1.15, 1 + streak * 0.03);
  }

  // Kelly criterion sizing: uses strategy win rate & avg R:R from learning engine
  // Kelly% = W - (1-W)/R, where W=winRate, R=avgRR
  // We use fractional Kelly (25%) to be conservative
  if (signalData.strategyStats) {
    const strat = signalData.strategyStats[signalData.strategyType];
    if (strat && strat.totalTrades >= 15 && strat.winRate > 0 && strat.avgRR > 0) {
      const w = strat.winRate / 100;
      const r = strat.avgRR;
      const kellyFull = w - ((1 - w) / r);
      if (kellyFull > 0) {
        const kellyFraction = Math.min(0.25, kellyFull * 0.25);  // 25% of Kelly, cap at 25%
        const kellySize = user.paperBalance * kellyFraction * leverage;
        // Use the smaller of risk-based and Kelly-based sizing
        positionSize = Math.min(positionSize, kellySize);
      } else if (kellyFull < -0.1) {
        // Negative Kelly = strategy is losing money, reduce size by 50%
        positionSize *= 0.5;
      }
    }
  }

  // Cap margin to max % of balance so we don't use all balance on one trade
  const maxMarginByPct = user.paperBalance * (Math.min(100, Math.max(5, maxBalancePct)) / 100);
  const maxPositionByMarginPct = maxMarginByPct * leverage;
  positionSize = Math.min(positionSize, Math.max(0, maxPositionByMarginPct));

  const makerFee = getMakerFee(user);
  // Cap so margin + fees never exceed balance (leave $0.50 buffer for rounding)
  const maxSpend = Math.max(0, user.paperBalance - 0.50);
  const maxPositionFromBalance = maxSpend / (1 / leverage + makerFee);
  positionSize = Math.min(positionSize, Math.max(0, maxPositionFromBalance));

  // If still invalid or zero, use a small size that fits in balance
  if (!Number.isFinite(positionSize) || positionSize <= 0) {
    positionSize = Math.min(user.paperBalance * 0.02 * leverage, maxPositionFromBalance);
  }

  let margin = positionSize / leverage;
  let fees = positionSize * makerFee;
  let required = margin + fees;

  // Final safety: if required still exceeds balance (e.g. rounding), shrink position until it fits
  if (required > user.paperBalance && user.paperBalance > 0) {
    const maxPosByBalance = (user.paperBalance - 0.01) / (1 / leverage + makerFee);
    positionSize = Math.min(positionSize, Math.max(0, maxPosByBalance));
    margin = positionSize / leverage;
    fees = positionSize * makerFee;
    required = margin + fees;
  }

  if (user.paperBalance <= 0) {
    throw new Error('Insufficient balance. Your paper balance is zero. Reset your paper account from the Performance page.');
  }
  if (required > user.paperBalance) {
    throw new Error(`Insufficient balance. Need $${required.toFixed(2)}, have $${user.paperBalance.toFixed(2)}. Try resetting paper account.`);
  }

  // Sanity-check TPs: for LONG, TPs must be above entry; for SHORT, below.
  // If a TP is on the wrong side (direction mismatch from strategy fallback), null it out.
  let safeTP1 = signalData.takeProfit1 || null;
  let safeTP2 = signalData.takeProfit2 || null;
  let safeTP3 = signalData.takeProfit3 || null;
  if (signalData.direction === 'LONG') {
    if (safeTP1 && safeTP1 < entryPrice) { console.warn(`[OpenTrade] ${signalData.symbol}: TP1 $${safeTP1} < entry $${entryPrice} for LONG — removed`); safeTP1 = null; }
    if (safeTP2 && safeTP2 < entryPrice) { console.warn(`[OpenTrade] ${signalData.symbol}: TP2 $${safeTP2} < entry $${entryPrice} for LONG — removed`); safeTP2 = null; }
    if (safeTP3 && safeTP3 < entryPrice) { console.warn(`[OpenTrade] ${signalData.symbol}: TP3 $${safeTP3} < entry $${entryPrice} for LONG — removed`); safeTP3 = null; }
  } else {
    if (safeTP1 && safeTP1 > entryPrice) { console.warn(`[OpenTrade] ${signalData.symbol}: TP1 $${safeTP1} > entry $${entryPrice} for SHORT — removed`); safeTP1 = null; }
    if (safeTP2 && safeTP2 > entryPrice) { console.warn(`[OpenTrade] ${signalData.symbol}: TP2 $${safeTP2} > entry $${entryPrice} for SHORT — removed`); safeTP2 = null; }
    if (safeTP3 && safeTP3 > entryPrice) { console.warn(`[OpenTrade] ${signalData.symbol}: TP3 $${safeTP3} > entry $${entryPrice} for SHORT — removed`); safeTP3 = null; }
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
    takeProfit1: safeTP1,
    takeProfit2: safeTP2,
    takeProfit3: safeTP3,
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

  console.log(`[OpenTrade] ${signalData.symbol} ${signalData.direction} | entry=$${entryPrice} | SL=$${stopLoss} | TP1=$${safeTP1} | TP2=$${safeTP2} | TP3=$${safeTP3} | size=$${positionSize.toFixed(2)} | lev=${leverage}x | score=${signalData.score} | strategy=${signalData.strategyType || 'default'} | auto=${!!signalData.autoTriggered}`);

  user.paperBalance -= (margin + fees);
  await user.save();

  // === BITGET LIVE TRADING: execute on exchange if enabled and paper/live sync on ===
  try {
    const paperLiveSync = user.settings?.paperLiveSync !== false;
    if (paperLiveSync && bitget.isLiveTradingActive(user)) {
      const isManual = user.liveTrading?.mode !== 'auto';
      if (isManual || signalData.autoTriggered) {
        console.log(`[Bitget] Executing live open for ${trade.symbol} ${trade.direction}`);
        await bitget.executeLiveOpen(user, trade, signalData);
      }
    }
  } catch (bitgetErr) {
    console.error(`[Bitget] Live open error (paper trade still saved): ${bitgetErr.message}`);
  }

  // Push notification
  if (user.settings?.notifyTradeOpen !== false) {
    try {
      const { sendPushToUser } = require('./push-notifications');
      const u = await User.findById(user._id).lean();
      if (u) await sendPushToUser(u, `Trade opened: ${signalData.symbol} ${signalData.direction}`, `Entry $${entryPrice.toFixed(4)} | ${leverage}x`);
    } catch (e) { /* non-critical */ }
  }

  return trade;
}

// Partial close: take a portion at TP, reduce position, don't count as full trade close
async function closeTradePartial(trade, exitPrice, portionSize, reason) {
  const user = await User.findById(trade.userId);
  if (!user) throw new Error('User not found');

  const origSize = trade.originalPositionSize || trade.positionSize;
  const remainingAfter = trade.positionSize - portionSize;

  // If remaining position would be < 1% of original (dust), close the entire remaining instead.
  // This prevents trades lingering with $0.01 size showing huge partial PnL.
  if (remainingAfter < origSize * 0.01 || remainingAfter < 1) {
    console.log(`[Partial] ${trade.symbol}: remaining $${remainingAfter.toFixed(2)} < 1% of original $${origSize.toFixed(2)} — closing entire remaining position`);
    await closeTrade(trade.userId, trade._id, exitPrice, reason);
    return;
  }

  // Clamp portion to remaining size (avoid rounding issues)
  const portion = Math.min(portionSize, Math.max(0, trade.positionSize));
  if (portion <= 0) return;

  const sizeBefore = trade.positionSize;

  let pnl;
  if (trade.direction === 'LONG') {
    pnl = ((exitPrice - trade.entryPrice) / trade.entryPrice) * portion;
  } else {
    pnl = ((trade.entryPrice - exitPrice) / trade.entryPrice) * portion;
  }
  const takerFee = getTakerFee(user);
  const exitFees = portion * takerFee;
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

  // Log the partial close action so it shows in history
  const fp = (v) => typeof v === 'number' ? v.toFixed(v >= 1 ? 2 : 6) : String(v);
  const pnlSign = pnl >= 0 ? '+' : '';
  const isReduce = reason === 'SCORE_CHECK_REDUCE';
  const actionType = isReduce ? 'RP' : 'PP';
  const label = reason === 'TP1' ? 'TP1' : reason === 'TP2' ? 'TP2' : isReduce ? 'Reduce' : reason === 'SCORE_CHECK_PARTIAL' ? 'Score' : reason;
  const desc = `Partial ${label}: $${fp(sizeBefore)} → $${fp(trade.positionSize)} at $${fp(exitPrice)} (${pnlSign}$${fp(pnl)})`;
  logTradeAction(trade, actionType, desc, sizeBefore, trade.positionSize, exitPrice);

  trade.updatedAt = new Date();
  await trade.save();

  // === BITGET LIVE TRADING: partial close on exchange ===
  try {
    if (trade.isLive) {
      const user = await User.findById(trade.userId);
      if (user && bitget.isLiveTradingActive(user)) {
        console.log(`[Bitget] Executing live partial close for ${trade.symbol}, portion=$${portion.toFixed(2)}`);
        await bitget.executeLivePartialClose(user, trade, portion);
      }
    }
  } catch (bitgetErr) {
    console.error(`[Bitget] Live partial close error: ${bitgetErr.message}`);
  }
}

async function closeTrade(userId, tradeId, currentPrice, reason) {
  const trade = await Trade.findOne({ _id: tradeId, userId, status: 'OPEN' });
  if (!trade) throw new Error('Trade not found or already closed');

  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  // PRICE SANITY CHECK: don't close at a price that's impossibly far from entry
  // unless it's a manual close (user explicitly chose to close)
  if (reason !== 'MANUAL' && trade.entryPrice > 0 && currentPrice > 0) {
    const priceDrift = Math.abs(currentPrice - trade.entryPrice) / trade.entryPrice;
    if (priceDrift > 0.5) {
      // Try to get a fresh live price instead
      try {
        const { fetchLivePrice } = require('./crypto-api');
        const livePrice = await fetchLivePrice(trade.coinId);
        if (livePrice != null && Number.isFinite(livePrice) && livePrice > 0) {
          const liveDrift = Math.abs(livePrice - trade.entryPrice) / trade.entryPrice;
          if (liveDrift < priceDrift) {
            console.warn(`[CloseTrade] PRICE CORRECTED: ${trade.symbol} bad price $${currentPrice} → live $${livePrice} (drift ${(priceDrift * 100).toFixed(1)}% → ${(liveDrift * 100).toFixed(1)}%)`);
            currentPrice = livePrice;
          }
        }
      } catch (err) { /* keep original price */ }
      // If still >50% drift, block the close entirely
      const finalDrift = Math.abs(currentPrice - trade.entryPrice) / trade.entryPrice;
      if (finalDrift > 0.5) {
        throw new Error(`Price sanity check failed: ${trade.symbol} entry=$${trade.entryPrice} close=$${currentPrice} (${(finalDrift * 100).toFixed(1)}% drift). Blocking automated close.`);
      }
    }
  }

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

  const takerFee = getTakerFee(user);
  const exitFees = trade.positionSize * takerFee;
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
    : reason === 'SCORE_CHECK_EXIT' ? 'SCORE_EXIT'
    : 'CLOSED_MANUAL';
  trade.updatedAt = new Date();

  await trade.save();

  console.log(`[CloseTrade] ${trade.symbol} ${trade.direction} | entry=$${trade.entryPrice} exit=$${exitPrice} (fed price=$${currentPrice}) | reason=${reason} | PnL=$${totalPnl.toFixed(2)} (${pnlPercent.toFixed(1)}%) | duration=${Math.round((Date.now() - new Date(trade.createdAt).getTime()) / 60000)}min`);

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

  // === BITGET LIVE TRADING: close on exchange ===
  try {
    if (trade.isLive) {
      const liveUser = await User.findById(userId);
      if (liveUser && bitget.isLiveTradingActive(liveUser)) {
        console.log(`[Bitget] Executing live close for ${trade.symbol} ${trade.direction} reason=${reason}`);
        await bitget.executeLiveClose(liveUser, trade);
      }
    }
  } catch (bitgetErr) {
    console.error(`[Bitget] Live close error: ${bitgetErr.message}`);
  }

  // Push notification
  const notifyClose = user.settings?.notifyTradeClose !== false;
  if (notifyClose) {
    try {
      const { sendPushToUser } = require('./push-notifications');
      const u = await User.findById(userId).lean();
      if (u) await sendPushToUser(u, `Trade closed: ${trade.symbol} ${trade.direction}`, `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${reason})`);
    } catch (e) { /* non-critical */ }
  }

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
   try {
    const priceData = getCurrentPriceFunc(trade.coinId);
    if (!priceData) {
      console.warn(`[StopTP] No price for ${trade.symbol} (${trade.coinId}) – skipping`);
      continue;
    }
    const currentPrice = priceData.price;

    // DUST POSITION CLEANUP: if remaining position < 1% of original, close it out
    const origPosSize = trade.originalPositionSize || trade.positionSize;
    if (origPosSize > 0 && trade.positionSize < origPosSize * 0.01) {
      console.log(`[StopTP] ${trade.symbol}: Dust position $${trade.positionSize.toFixed(2)} < 1% of original $${origPosSize.toFixed(2)} — closing out`);
      try {
        await closeTrade(trade.userId, trade._id, currentPrice, 'DUST_CLEANUP');
        closedCount++;
      } catch (e) {
        console.error(`[StopTP] ${trade.symbol}: Failed to close dust position:`, e.message);
      }
      continue;
    }

    // PRICE SANITY CHECK: reject prices that are impossibly far from entry
    // Crypto can move, but >50% in one direction from entry is likely a bad price feed
    if (trade.entryPrice > 0 && currentPrice > 0) {
      const priceDrift = Math.abs(currentPrice - trade.entryPrice) / trade.entryPrice;
      if (priceDrift > 0.5) {
        console.error(`[StopTP] PRICE SANITY FAIL: ${trade.symbol} entry=$${trade.entryPrice} current=$${currentPrice} (${(priceDrift * 100).toFixed(1)}% drift) – skipping to avoid bad fill`);
        continue;
      }
    }

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

    // Fix stale trailingActivated from ping-pong bug:
    // If trailingActivated is true but stop hasn't actually moved past breakeven,
    // reset it so BE/lock-in can function again.
    if (trade.trailingActivated && trade.stopLoss != null) {
      const isLong = trade.direction === 'LONG';
      const stopAtOrWorseEntry = isLong
        ? trade.stopLoss <= trade.entryPrice
        : trade.stopLoss >= trade.entryPrice;
      if (stopAtOrWorseEntry) {
        trade.trailingActivated = false;
        await trade.save();
        console.log(`[StopTP] ${trade.symbol}: Reset stale trailingActivated (stop ${trade.stopLoss} still at/before entry ${trade.entryPrice})`);
      }
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

    // Diagnostic vars (used in action logging below, NOT logged every cycle)
    const isLongDiag = trade.direction === 'LONG';
    const profitRaw = isLongDiag ? currentPrice - trade.entryPrice : trade.entryPrice - currentPrice;
    const profitR = risk > 0 ? (profitRaw / risk).toFixed(2) : 'N/A';

    if (risk > 0 && trade.stopLoss != null) {
      const stopGrace = user?.settings?.stopCheckGraceMinutes ?? STOP_CHECK_GRACE_MINUTES;
      const openedAt = trade.createdAt || trade.entryTime || trade.updatedAt;
      const ageMs = Date.now() - new Date(openedAt).getTime();
      const pastStopGrace = ageMs >= stopGrace * 60 * 1000;

      // Breakeven at 1R (if autoMoveBreakeven) — only if trailing hasn't started yet
      if (pastStopGrace && autoBE && !trade.trailingActivated && trade.stopLoss !== trade.entryPrice) {
        const at1R = trade.direction === 'LONG' ? currentPrice >= trade.entryPrice + risk : currentPrice <= trade.entryPrice - risk;
        if (at1R) {
          const oldSl = trade.stopLoss;
          trade.stopLoss = trade.entryPrice;
          logTradeAction(trade, 'BE', `Stop moved to breakeven at $${trade.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} (was $${(oldSl || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })})`, oldSl, trade.entryPrice, currentPrice);
          await trade.save();
          // Bitget: update SL on exchange
          if (trade.isLive) {
            try {
              const liveUser = await User.findById(trade.userId);
              if (liveUser) await bitget.executeLiveStopUpdate(liveUser, trade, trade.entryPrice);
            } catch (e) { console.error(`[Bitget] BE SL update error: ${e.message}`); }
          }
        }
      }

      // Trailing stop at 1.5R+ (if autoTrailingStop) - trail at 1R behind max favorable price
      // Activates if: stop already at BE, trailing already running, OR stop has been locked past entry
      const stopPastEntry = trade.direction === 'LONG' ? trade.stopLoss >= trade.entryPrice : trade.stopLoss <= trade.entryPrice;
      if (pastStopGrace && autoTrail && (stopPastEntry || trade.trailingActivated)) {
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
            // Bitget: update trailing SL on exchange
            if (trade.isLive) {
              try {
                const liveUser = await User.findById(trade.userId);
                if (liveUser) await bitget.executeLiveStopUpdate(liveUser, trade, newStop);
              } catch (e) { console.error(`[Bitget] TS SL update error: ${e.message}`); }
            }
          }
        }
      }

      // Stepped profit lock-in (ALWAYS runs — works alongside trailing)
      if (pastStopGrace) {
        const progress = getProgressTowardTP(trade, currentPrice);
        let effectiveProgress = progress;
        if (progress <= 0 && trade.entryPrice > 0) {
          const lev = trade.leverage || 1;
          const pnlPct = (trade.direction === 'LONG'
            ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100
            : (trade.entryPrice - currentPrice) / trade.entryPrice * 100) * lev;
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
                logTradeAction(trade, 'LOCK', `Locked in ${level.lockR}R profit: $${newStop.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} (was $${(oldSl || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })})`, oldSl, newStop, currentPrice);
                await trade.save();
                console.log(`[StopTP] ${trade.symbol}: LOCK-IN ${level.lockR}R → SL $${newStop}`);
                // Bitget: update LOCK SL on exchange
                if (trade.isLive) {
                  try {
                    const liveUser = await User.findById(trade.userId);
                    if (liveUser) await bitget.executeLiveStopUpdate(liveUser, trade, newStop);
                  } catch (e) { console.error(`[Bitget] LOCK SL update error: ${e.message}`); }
                }
                break;
              }
            }
          }
        }
      }
    } // else: no stopLoss or risk<=0 — silently skip BE/TS
    await trade.save();

    // SANITY: Fix any TPs that are on the wrong side of entry (direction mismatch bug).
    // For LONG, TPs must be above entry. For SHORT, TPs must be below entry.
    // If a TP is on the wrong side, null it out to prevent instant bogus "TP HIT" closes.
    let tpFixed = false;
    if (trade.direction === 'LONG') {
      if (trade.takeProfit1 && trade.takeProfit1 < trade.entryPrice) { trade.takeProfit1 = null; tpFixed = true; }
      if (trade.takeProfit2 && trade.takeProfit2 < trade.entryPrice) { trade.takeProfit2 = null; tpFixed = true; }
      if (trade.takeProfit3 && trade.takeProfit3 < trade.entryPrice) { trade.takeProfit3 = null; tpFixed = true; }
    } else {
      if (trade.takeProfit1 && trade.takeProfit1 > trade.entryPrice) { trade.takeProfit1 = null; tpFixed = true; }
      if (trade.takeProfit2 && trade.takeProfit2 > trade.entryPrice) { trade.takeProfit2 = null; tpFixed = true; }
      if (trade.takeProfit3 && trade.takeProfit3 > trade.entryPrice) { trade.takeProfit3 = null; tpFixed = true; }
    }
    if (tpFixed) {
      console.warn(`[StopTP] ${trade.symbol}: Fixed wrong-side TPs (${trade.direction} entry=$${trade.entryPrice}, TP1=$${trade.takeProfit1}, TP2=$${trade.takeProfit2}, TP3=$${trade.takeProfit3})`);
      await trade.save();
    }

    const hitTP1Long = trade.direction === 'LONG' && trade.takeProfit1 && currentPrice >= trade.takeProfit1;
    const hitTP2Long = trade.direction === 'LONG' && trade.takeProfit2 && currentPrice >= trade.takeProfit2;
    const hitTP3Long = trade.direction === 'LONG' && trade.takeProfit3 && currentPrice >= trade.takeProfit3;
    const hitTP1Short = trade.direction === 'SHORT' && trade.takeProfit1 && currentPrice <= trade.takeProfit1;
    const hitTP2Short = trade.direction === 'SHORT' && trade.takeProfit2 && currentPrice <= trade.takeProfit2;
    const hitTP3Short = trade.direction === 'SHORT' && trade.takeProfit3 && currentPrice <= trade.takeProfit3;

    // TP CHECK: Process from LOWEST to HIGHEST so none are skipped if price gaps.
    // TP1 → 40% (or full if only TP)
    // TP2 → 30% (or full close if no TP3)
    // TP3 → 30% remaining (full close)
    const slippage = 1 + (SLIPPAGE_BPS / 10000);
    if (trade.direction === 'LONG') {
      if (trade.stopLoss != null && currentPrice <= trade.stopLoss) {
        console.log(`[StopTP] ${trade.symbol}: STOP LOSS HIT (LONG) price=$${currentPrice} <= SL=$${trade.stopLoss} → FULL CLOSE`);
        await closeTrade(trade.userId, trade._id, trade.stopLoss, 'STOPPED_OUT');
        closedCount++;
        continue;
      }
      const orig = trade.originalPositionSize || trade.positionSize;

      // TP1: take partial (or full if only TP)
      if (hitTP1Long && !trade.partialTakenAtTP1 && trade.takeProfit1) {
        const exit1 = trade.takeProfit1 / slippage;
        if (!trade.takeProfit2 && !trade.takeProfit3) {
          console.log(`[StopTP] ${trade.symbol}: TP1 HIT (LONG) price=$${currentPrice} >= TP1=$${trade.takeProfit1} → FULL CLOSE (only TP)`);
          await closeTrade(trade.userId, trade._id, exit1, 'TP1');
          closedCount++;
          continue; // trade closed, skip rest
        } else if (trade.takeProfit2 && !trade.takeProfit3) {
          const portion = Math.round((orig * TP1_PCT) * 100) / 100;
          console.log(`[StopTP] ${trade.symbol}: TP1 HIT (LONG) price=$${currentPrice} >= TP1=$${trade.takeProfit1} → PARTIAL $${portion} (40%)`);
          await closeTradePartial(trade, exit1, portion, 'TP1');
        } else {
          const portion = Math.round((orig * TP1_PCT) * 100) / 100;
          console.log(`[StopTP] ${trade.symbol}: TP1 HIT (LONG) price=$${currentPrice} >= TP1=$${trade.takeProfit1} → PARTIAL $${portion} (40%)`);
          await closeTradePartial(trade, exit1, portion, 'TP1');
        }
        closedCount++;
      }

      // TP2: take partial (or full if no TP3) — can fire same cycle as TP1 if price gapped
      if (hitTP2Long && !trade.partialTakenAtTP2 && trade.takeProfit2) {
        const exit2 = trade.takeProfit2 / slippage;
        if (!trade.takeProfit3) {
          console.log(`[StopTP] ${trade.symbol}: TP2 HIT (LONG) price=$${currentPrice} >= TP2=$${trade.takeProfit2} → FULL CLOSE (no TP3)`);
          await closeTrade(trade.userId, trade._id, exit2, 'TP2');
          closedCount++;
          continue; // trade closed
        } else {
          const portion = Math.round((orig * TP2_PCT) * 100) / 100;
          console.log(`[StopTP] ${trade.symbol}: TP2 HIT (LONG) price=$${currentPrice} >= TP2=$${trade.takeProfit2} → PARTIAL $${portion} (30%)`);
          await closeTradePartial(trade, exit2, portion, 'TP2');
          closedCount++;
        }
      }

      // TP3: full close on remaining position
      if (hitTP3Long && trade.takeProfit3) {
        const exit3 = trade.takeProfit3 / slippage;
        console.log(`[StopTP] ${trade.symbol}: TP3 HIT (LONG) price=$${currentPrice} >= TP3=$${trade.takeProfit3} → FULL CLOSE`);
        await closeTrade(trade.userId, trade._id, exit3, 'TP3');
        closedCount++;
        continue; // trade closed
      }
    } else {
      if (trade.stopLoss && currentPrice >= trade.stopLoss) {
        console.log(`[StopTP] ${trade.symbol}: STOP LOSS HIT (SHORT) price=$${currentPrice} >= SL=$${trade.stopLoss} → FULL CLOSE`);
        await closeTrade(trade.userId, trade._id, trade.stopLoss, 'STOPPED_OUT');
        closedCount++;
        continue;
      }
      const orig = trade.originalPositionSize || trade.positionSize;

      // TP1: take partial (or full if only TP)
      if (hitTP1Short && !trade.partialTakenAtTP1 && trade.takeProfit1) {
        const exit1 = trade.takeProfit1 * slippage;
        if (!trade.takeProfit2 && !trade.takeProfit3) {
          console.log(`[StopTP] ${trade.symbol}: TP1 HIT (SHORT) price=$${currentPrice} <= TP1=$${trade.takeProfit1} → FULL CLOSE (only TP)`);
          await closeTrade(trade.userId, trade._id, exit1, 'TP1');
          closedCount++;
          continue;
        } else if (trade.takeProfit2 && !trade.takeProfit3) {
          const portion = Math.round((orig * TP1_PCT) * 100) / 100;
          console.log(`[StopTP] ${trade.symbol}: TP1 HIT (SHORT) price=$${currentPrice} <= TP1=$${trade.takeProfit1} → PARTIAL $${portion} (40%)`);
          await closeTradePartial(trade, exit1, portion, 'TP1');
        } else {
          const portion = Math.round((orig * TP1_PCT) * 100) / 100;
          console.log(`[StopTP] ${trade.symbol}: TP1 HIT (SHORT) price=$${currentPrice} <= TP1=$${trade.takeProfit1} → PARTIAL $${portion} (40%)`);
          await closeTradePartial(trade, exit1, portion, 'TP1');
        }
        closedCount++;
      }

      // TP2: take partial (or full if no TP3)
      if (hitTP2Short && !trade.partialTakenAtTP2 && trade.takeProfit2) {
        const exit2 = trade.takeProfit2 * slippage;
        if (!trade.takeProfit3) {
          console.log(`[StopTP] ${trade.symbol}: TP2 HIT (SHORT) price=$${currentPrice} <= TP2=$${trade.takeProfit2} → FULL CLOSE (no TP3)`);
          await closeTrade(trade.userId, trade._id, exit2, 'TP2');
          closedCount++;
          continue;
        } else {
          const portion = Math.round((orig * TP2_PCT) * 100) / 100;
          console.log(`[StopTP] ${trade.symbol}: TP2 HIT (SHORT) price=$${currentPrice} <= TP2=$${trade.takeProfit2} → PARTIAL $${portion} (30%)`);
          await closeTradePartial(trade, exit2, portion, 'TP2');
          closedCount++;
        }
      }

      // TP3: full close on remaining position
      if (hitTP3Short && trade.takeProfit3) {
        const exit3 = trade.takeProfit3 * slippage;
        console.log(`[StopTP] ${trade.symbol}: TP3 HIT (SHORT) price=$${currentPrice} <= TP3=$${trade.takeProfit3} → FULL CLOSE`);
        await closeTrade(trade.userId, trade._id, exit3, 'TP3');
        closedCount++;
        continue;
      }
    }
   } catch (tradeErr) {
    console.error(`[StopTP] Error processing ${trade.symbol} (${trade._id}):`, tradeErr.message);
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
// Grace periods: exempt new trades from aggressive actions so price can settle
const SCORE_CHECK_GRACE_MINUTES = 5;   // No auto-execute BE/RP/EXIT on trades younger than this
const STOP_CHECK_GRACE_MINUTES = 2;    // No BE/TS/lock-in stop tightening on trades younger than this

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
// Score dimensions are direction-agnostic: they measure setup QUALITY, not direction.
// A dimension drop means that indicator's signal weakened (bad for both LONG and SHORT).
// A dimension rise means that indicator's signal strengthened (good for both).
// Direction-specific context comes from the signal direction check, not from dimension scores.
function determineChangeReasons(trade, signal) {
  const reasons = [];
  const eb = trade.scoreBreakdownAtEntry || {};
  const cb = signal.scoreBreakdown || {};
  if (typeof eb.trend !== 'number') return reasons;

  const dims = [
    { key: 'trend',      negText: 'Trend signal weakened',    posText: 'Trend signal strengthened' },
    { key: 'momentum',   negText: 'Momentum weakened',        posText: 'Momentum strengthened' },
    { key: 'volume',     negText: 'Volume signal fading',     posText: 'Volume confirming' },
    { key: 'structure',  negText: 'Structure degraded',       posText: 'Structure improved' },
    { key: 'volatility', negText: 'Volatility spike',         posText: 'Volatility normalized' },
    { key: 'riskQuality',negText: 'Risk/reward degraded',     posText: 'Risk/reward improved' }
  ];

  for (const d of dims) {
    const diff = (cb[d.key] || 0) - (eb[d.key] || 0);
    if (diff <= -3) {
      reasons.push({ type: 'negative', text: d.negText });
    } else if (diff >= 3) {
      reasons.push({ type: 'positive', text: d.posText });
    }
  }

  // Signal direction change: add explicit reason
  const isLong = trade.direction === 'LONG';
  const signalFlipped = isLong
    ? (signal.signal === 'SELL' || signal.signal === 'STRONG_SELL')
    : (signal.signal === 'BUY' || signal.signal === 'STRONG_BUY');
  if (signalFlipped) {
    const against = isLong ? 'bearish' : 'bullish';
    reasons.push({ type: 'danger', text: `Signal flipped ${against}` });
  } else if (signal.signal === 'HOLD') {
    reasons.push({ type: 'warning', text: 'Signal direction now neutral' });
  }

  if (reasons.length === 0) {
    reasons.push({ type: 'neutral', text: 'No significant changes detected' });
  }
  return reasons;
}

// ---- Heat Indicator ----
// Green = stable, Yellow = weakening, Red = danger
// Score diff is direction-agnostic: positive = setup quality improved, negative = degraded
// Also considers P&L and signal direction
function determineHeat(scoreDiff, messages, isLong, pnlPct, currentSignal) {
  // Effective diff: same for both LONG and SHORT (score measures setup quality)
  // Penalize when signal direction changed against us — but gently
  const signalFlipped = isLong
    ? (currentSignal === 'SELL' || currentSignal === 'STRONG_SELL')
    : (currentSignal === 'BUY' || currentSignal === 'STRONG_BUY');
  const isHold = currentSignal === 'HOLD';
  let effective = scoreDiff;
  if (signalFlipped) effective = Math.min(effective, -15);
  else if (isHold) effective -= 4;

  const hasDanger = messages.some(m => m.type === 'danger');
  const hasWarning = messages.some(m => m.type === 'warning');

  // P&L floors: price reality can only increase heat, never decrease it
  // Relaxed: only force red at -20%, yellow at -10%
  const pnl = typeof pnlPct === 'number' ? pnlPct : 0;
  const pnlFloor = pnl <= -20 ? 'red' : pnl <= -10 ? 'yellow' : null;

  let heat;
  // When score moved 15+ in our favor AND direction still aligned, downgrade danger
  if (effective >= 15 && !signalFlipped && hasDanger) heat = 'yellow';
  else if (effective >= 15 && !signalFlipped && hasWarning) heat = 'green';
  else if (hasDanger && effective <= -15) heat = 'red';   // Need BOTH danger + score drop
  else if (effective <= -25) heat = 'red';                 // OR massive score collapse alone
  else if (hasWarning || effective <= -8) heat = 'yellow'; // Relaxed from -5 to -8
  else heat = 'green';

  // Apply P&L floor: if deeply underwater, heat can only go up
  if (pnlFloor === 'red' && heat !== 'red') heat = 'red';
  if (pnlFloor === 'yellow' && heat === 'green') heat = 'yellow';

  return heat;
}

// ---- Suggested Action Ladder ----
// Score diff is direction-agnostic: positive = setup quality improved, negative = degraded.
// Signal direction changes penalize effective to detect when thesis breaks down.
// Each action has actionId for execution (when autoExecuteActions enabled).
// Confluence: P&L and price progress block aggressive actions on favorable trades.
function determineSuggestedAction(scoreDiff, heat, messages, isLong, trade, currentPrice, currentSignal) {
  // Effective diff: same for both directions. Penalize on signal direction change — gently.
  const signalFlipped = isLong
    ? (currentSignal === 'SELL' || currentSignal === 'STRONG_SELL')
    : (currentSignal === 'BUY' || currentSignal === 'STRONG_BUY');
  const isHold = currentSignal === 'HOLD';
  let effective = scoreDiff;
  if (signalFlipped) effective = Math.min(effective, -15);
  else if (isHold) effective -= 4;
  const structureBreaking = messages.some(m => m.text === 'Structure breaking');
  const considerPartial = messages.some(m => m.text === 'Consider partial');
  const considerBE = messages.some(m => m.text === 'Consider BE stop');
  const hasDanger = messages.some(m => m.type === 'danger');

  // P&L in percent (positive = profit) – include leverage
  const lev = trade.leverage || 1;
  const pnlPct = trade.entryPrice > 0
    ? ((isLong ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice)) / trade.entryPrice * 100) * lev
    : 0;
  const inProfit = pnlPct >= 0;             // At or above breakeven
  const inProfit2Pct = pnlPct >= 2;
  const inSignificantLoss = pnlPct < -8;   // Relaxed from -5 to -8
  const inDeepLoss = pnlPct < -15;          // Relaxed from -10 to -15
  const inSolidProfit = pnlPct >= 4;

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
  const nearTP2 = progressToTP2 >= 0.4;  // Relaxed from 0.5 to 0.4

  // Leverage-adjusted thresholds: higher leverage = tighter, but overall much wider
  const highLev = lev >= 5;  // Raised from 3 to 5
  const exitThreshold = highLev ? -30 : -35;       // Was -20/-25
  const hardExitThreshold = highLev ? -35 : -45;   // Was -25/-30
  const reduceThreshold = highLev ? -20 : -25;     // Was -10/-15

  // ---- P&L-first overrides: only for truly catastrophic losses ----
  // When P&L says you're down 25%+ AND score is against you = consider exit
  if (pnlPct <= -25 && effective < 10) {
    return { level: 'extreme', actionId: 'consider_exit', text: 'Consider exit — severe loss' };
  }
  // Down 20%+ with high leverage = reduce regardless of score
  if (pnlPct <= -20 && highLev) {
    return { level: 'high', actionId: 'reduce_position', text: 'Reduce position — deep loss + high leverage' };
  }
  // Down 15%+ and score isn't strongly in our favor = reduce
  if (inDeepLoss && effective < 10) {
    return { level: 'high', actionId: 'reduce_position', text: 'Reduce position — price against you' };
  }

  // When score moved 15+ in our favor (thesis strong), never suggest exit
  if (effective >= 15) {
    if (structureBreaking && inDeepLoss) return { level: 'medium', actionId: 'hold_monitor', text: 'Hold — monitor structure' };
    if (inDeepLoss) return { level: 'high', actionId: 'tighten_stop', text: 'Tighten stop — price against position' };
    if (inSignificantLoss) return { level: 'medium', actionId: 'hold_monitor', text: 'Hold — monitor (price disagrees)' };
    return { level: 'positive', actionId: 'hold', text: 'Hold — strengthening' };
  }

  // Consider exit: require STRONG confirmation — multiple signals agreeing
  // Need: red heat + danger message + score dropped past exit threshold
  // OR score absolutely collapsed past hard exit threshold
  // Block if: in ANY profit (even 0.1%) or making progress toward TP2
  // Never close a profitable trade just because score dropped — let stops handle it
  const wouldConsiderExit = (heat === 'red' && hasDanger && effective <= exitThreshold) || effective <= hardExitThreshold;
  const blockExit = inProfit || nearTP2;
  if (wouldConsiderExit && !blockExit) {
    return { level: 'extreme', actionId: 'consider_exit', text: 'Consider exit' };
  }
  // Downgrade to tighten stop if we would exit but trade is in profit
  if (wouldConsiderExit && blockExit) {
    return { level: 'high', actionId: 'tighten_stop', text: 'Tighten stop — score weak but in profit' };
  }

  // High leverage + red heat + score slipping = tighten stop (don't reduce when profitable)
  if (highLev && heat === 'red' && effective <= -10 && !inProfit) {
    return { level: 'high', actionId: 'reduce_position', text: 'Reduce position (high leverage)' };
  }

  if (effective <= reduceThreshold || (structureBreaking && effective <= -10)) {
    // Never reduce a profitable trade — only tighten stop
    if (inProfit) {
      return { level: 'medium', actionId: 'tighten_stop', text: 'Tighten stop — protecting profit' };
    }
    if (structureBreaking) return { level: 'high', actionId: 'reduce_position', text: 'Reduce position' };
    if (effective <= reduceThreshold) {
      return { level: 'high', actionId: 'reduce_position', text: 'Reduce position' };
    }
  }
  if (considerPartial && !inProfit) {
    return { level: 'medium', actionId: 'take_partial', text: 'Take partial' };
  }
  const lockInAvailable = messages.some(m => m.text === 'Lock in profit available');
  if (lockInAvailable) {
    return { level: 'medium', actionId: 'lock_in_profit', text: 'Lock in profit' };
  }
  // Down 8-15% with score in our favor but not strongly: cautious monitor
  if (inSignificantLoss && effective >= 5) {
    return { level: 'medium', actionId: 'tighten_stop', text: 'Tighten stop — price against position' };
  }
  if (considerBE) {
    return { level: 'medium', actionId: 'tighten_stop', text: 'Tighten stop' };
  }
  if (heat === 'red' && effective <= -10) {
    return { level: 'medium', actionId: 'tighten_stop', text: 'Tighten stop' };
  }
  if (effective >= 5) {
    return { level: 'positive', actionId: 'hold', text: 'Hold — strengthening' };
  }
  if (heat === 'yellow' && effective <= -8) {
    return { level: 'low', actionId: 'monitor', text: 'Monitor — score dipping' };
  }
  return { level: 'low', actionId: 'monitor', text: 'Monitor' };
}

// ---- Execute Suggested Action (when autoExecuteActions enabled) ----
// Only executes if actionId is actionable and different from last executed.
// Returns { executed, details } where details describes what changed.
async function executeScoreCheckAction(trade, suggestedAction, currentPrice, getCurrentPriceFunc) {
  const actionId = suggestedAction?.actionId;
  if (!actionId || ['hold', 'hold_monitor', 'monitor'].includes(actionId)) return { executed: false };
  // Block repeat for irreversible actions (partial/reduce/exit) but allow re-execution for
  // stop management (tighten_stop has internal guard, lock_in_profit has stepped levels)
  if (trade.lastExecutedActionId === actionId && ['reduce_position', 'take_partial', 'consider_exit'].includes(actionId)) {
    return { executed: false };
  }

  // Grace period: trades younger than X minutes are exempt (user setting or default)
  const scoreGrace = (await User.findById(trade.userId).lean())?.settings?.scoreCheckGraceMinutes ?? SCORE_CHECK_GRACE_MINUTES;
  const actionableIds = ['consider_exit', 'reduce_position', 'take_partial', 'tighten_stop', 'lock_in_profit'];
  if (actionableIds.includes(actionId)) {
    const openedAt = trade.createdAt || trade.entryTime || trade.updatedAt;
    const ageMs = Date.now() - new Date(openedAt).getTime();
    if (ageMs < scoreGrace * 60 * 1000) {
      console.log(`[ScoreCheck] GRACE: Skipping ${actionId} on ${trade.symbol} (trade age ${Math.round(ageMs / 60000)}min < ${scoreGrace}min)`);
      return { executed: false };
    }
  }

  // Fetch a LIVE price for exits – don't rely on stale cache which can be from a different source
  let price = currentPrice;
  try {
    const { fetchLivePrice } = require('./crypto-api');
    const livePrice = await fetchLivePrice(trade.coinId);
    if (livePrice != null && Number.isFinite(livePrice) && livePrice > 0) {
      price = livePrice;
    } else {
      const priceData = getCurrentPriceFunc(trade.coinId);
      if (priceData?.price) price = priceData.price;
    }
  } catch (err) {
    const priceData = getCurrentPriceFunc(trade.coinId);
    if (priceData?.price) price = priceData.price;
    console.warn(`[ScoreCheck] Live price fetch failed for ${trade.symbol}, using cached: ${price}`);
  }

  // PRICE SANITY CHECK: don't execute at a price that's wildly different from entry
  if (trade.entryPrice > 0 && price > 0) {
    const priceDrift = Math.abs(price - trade.entryPrice) / trade.entryPrice;
    if (priceDrift > 0.5) {
      console.error(`[ScoreCheck] PRICE SANITY FAIL: ${trade.symbol} entry=$${trade.entryPrice} exitPrice=$${price} (${(priceDrift * 100).toFixed(1)}% drift) – blocking action`);
      return { executed: false };
    }
  }

  const slippage = 1 + (SLIPPAGE_BPS / 10000);
  const exitPrice = trade.direction === 'LONG' ? price / slippage : price * slippage;
  const fp = (v) => typeof v === 'number' ? v.toFixed(v >= 1 ? 2 : 6) : String(v);

  // PROFIT PROTECTION: Never auto-close or auto-reduce a trade that is currently profitable.
  // If the trade is in profit, the stop loss / trailing stop should handle the exit — not score checks.
  // This prevents the system from locking in a loss via partial at a slightly lower price.
  if (['consider_exit', 'reduce_position', 'take_partial'].includes(actionId)) {
    const isLongExec = trade.direction === 'LONG';
    const execPnlPct = trade.entryPrice > 0
      ? ((isLongExec ? (price - trade.entryPrice) : (trade.entryPrice - price)) / trade.entryPrice * 100) * (trade.leverage || 1)
      : 0;
    if (execPnlPct >= 0) {
      console.log(`[ScoreCheck] BLOCKED ${actionId} on ${trade.symbol}: trade is in profit (${execPnlPct.toFixed(2)}%) — letting stop/TP handle exit`);
      return { executed: false };
    }
  }

  try {
    if (actionId === 'consider_exit') {
      const sizeBefore = trade.positionSize;
      // Close the trade FIRST — only log EXIT badge if close actually succeeds
      // (previously badge was saved before close, so if close failed the trade
      //  stayed open with a misleading EXIT badge)
      try {
        await closeTrade(trade.userId, trade._id, price, 'SCORE_CHECK_EXIT');
      } catch (closeErr) {
        console.error(`[ScoreCheck] EXIT failed for ${trade.symbol}: ${closeErr.message}`);
        return { executed: false };
      }
      // Trade is now closed in DB — add EXIT badge to the closed trade record
      try {
        const closedTrade = await Trade.findById(trade._id);
        if (closedTrade) {
          logTradeAction(closedTrade, 'EXIT', `Auto-closed position ($${fp(sizeBefore)}) at $${fp(price)}`, sizeBefore, price, price);
          await closedTrade.save();
        }
      } catch (logErr) { /* non-critical: trade is already closed */ }
      const details = `Closed entire position ($${fp(sizeBefore)}) at $${fp(price)}`;
      console.log(`[ScoreCheck] ${details}`);
      return { executed: true, details };
    }
    if (actionId === 'reduce_position') {
      const orig = trade.originalPositionSize || trade.positionSize;
      const portion = Math.round((orig * 0.5) * 100) / 100;
      if (portion <= 0 || portion >= trade.positionSize) return { executed: false };
      const sizeBefore = trade.positionSize;
      await closeTradePartial(trade, exitPrice, portion, 'SCORE_CHECK_REDUCE');
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
      if (portion <= 0 || portion >= trade.positionSize) return { executed: false };
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
      // Only move to breakeven if trade is actually in profit by at least 1R
      const inProfit1R = risk > 0 && (
        trade.direction === 'LONG' ? price >= trade.entryPrice + risk : price <= trade.entryPrice - risk
      );
      if (risk > 0 && trade.stopLoss !== trade.entryPrice && !inProfit1R) {
        console.log(`[ScoreCheck] BLOCKED tighten_stop→BE on ${trade.symbol}: not yet in profit by 1R (price $${fp(price)} vs entry $${fp(trade.entryPrice)} ± 1R)`);
      }
      if (risk > 0 && trade.stopLoss !== trade.entryPrice && inProfit1R) {
        const oldStop = trade.stopLoss;
        trade.stopLoss = trade.entryPrice;
        trade.lastExecutedActionId = actionId;
        const details = `Stop tightened: $${fp(oldStop)} → $${fp(trade.entryPrice)} (breakeven)`;
        logTradeAction(trade, 'BE', details, oldStop, trade.entryPrice, price);
        trade.scoreCheck = trade.scoreCheck || {};
        trade.scoreCheck.lastActionDetails = details;
        await trade.save();
        console.log(`[ScoreCheck] ${details}`);
        // Bitget: update SL on exchange
        if (trade.isLive) {
          try {
            const liveUser = await User.findById(trade.userId);
            if (liveUser) await bitget.executeLiveStopUpdate(liveUser, trade, trade.entryPrice);
          } catch (e) { console.error(`[Bitget] ScoreCheck BE SL error: ${e.message}`); }
        }
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
        const levExec = trade.leverage || 1;
        const pnlPct = (trade.direction === 'LONG' ? (price - trade.entryPrice) / trade.entryPrice * 100 : (trade.entryPrice - price) / trade.entryPrice * 100) * levExec;
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
              logTradeAction(trade, 'LOCK', details, oldStop, newStop, price);
              trade.scoreCheck = trade.scoreCheck || {};
              trade.scoreCheck.lastActionDetails = details;
              await trade.save();
              console.log(`[ScoreCheck] ${details}`);
              // Bitget: update LOCK SL on exchange
              if (trade.isLive) {
                try {
                  const liveUser = await User.findById(trade.userId);
                  if (liveUser) await bitget.executeLiveStopUpdate(liveUser, trade, newStop);
                } catch (e) { console.error(`[Bitget] ScoreCheck LOCK SL error: ${e.message}`); }
              }
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

  // P&L in percent (positive = profit) – used to gate messages when price disagrees with score
  const lev = trade.leverage || 1;
  const pnlPct = trade.entryPrice > 0
    ? ((isLong ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice)) / trade.entryPrice * 100) * lev
    : 0;
  const inSignificantLoss = pnlPct < -5;   // Short down 5%+ or long down 5%+
  const inSolidProfit = pnlPct >= 4;       // Up 4%+ – don't suggest partial/reduce from minor score dips

  // Signal direction flipped? (market now says opposite of our trade)
  const signalFlipped = isLong
    ? (signal.signal === 'SELL' || signal.signal === 'STRONG_SELL')
    : (signal.signal === 'BUY' || signal.signal === 'STRONG_BUY');
  const isNowHold = signal.signal === 'HOLD';

  // Effective score diff: positive = setup quality improved, negative = degraded.
  // SAME formula for LONG and SHORT — score measures setup quality for both directions.
  // When signal direction flips or goes neutral, we penalize — but not so harshly that
  // normal crypto volatility triggers exits. Signals flip often in ranging markets.
  let effectiveDiff = scoreDiff;
  if (signalFlipped) effectiveDiff = Math.min(effectiveDiff, -15);  // Direction reversed — moderate penalty
  else if (isNowHold) effectiveDiff -= 4;  // Direction went neutral — mild penalty

  // 1. Setup invalidated (most severe)
  // Only trigger when signal STRONGLY reversed AND score dropped significantly.
  // A brief flip to SELL during a LONG is normal noise — require score confirmation.
  const scoreAgainstUs = isLong
    ? currentScore < 25 && signalFlipped  // LONG needs both low score AND bearish signal
    : (signal.signal === 'STRONG_BUY' && currentScore >= 70);  // SHORT needs strong reversal
  if ((signalFlipped && effectiveDiff <= -20) || scoreAgainstUs) {
    messages.push({ type: 'danger', text: 'Setup invalidated' });
  }

  // 2. Structure breaking (bad for both directions) – relaxed 6→8 to reduce noise
  // Structure scores fluctuate a lot; only flag when a large shift occurs
  if (hasEntryBreakdown && (cb.structure || 0) <= (eb.structure || 0) - 8) {
    messages.push({ type: 'danger', text: 'Structure breaking' });
  }

  // 3. Momentum dropped: the momentum signal weakened (direction-agnostic).
  // Raised threshold from 3→5 — small momentum dips are normal in crypto
  if (hasEntryBreakdown && (cb.momentum || 0) <= (eb.momentum || 0) - 5) {
    messages.push({ type: 'warning', text: 'Momentum weakening' });
  }

  // 4. Confidence increasing - score moved in our favor (setup quality improved)
  // Don't show when P&L disagrees (e.g. down 5%+ with price moving against us)
  if (effectiveDiff >= 5 && !signalFlipped && !inSignificantLoss) {
    messages.push({ type: 'positive', text: 'Confidence increasing' });
  }
  // Signal went to HOLD = thesis weakening
  if (isNowHold && !signalFlipped) {
    messages.push({ type: 'warning', text: 'Signal direction now neutral — thesis weakening' });
  }
  if (inSignificantLoss && !messages.some(m => m.text === 'Price action against position — score may lag')) {
    messages.push({ type: 'warning', text: 'Price action against position — score may lag' });
  }

  // 5. TP probability rising (price progressing toward TP2 & score in our favor)
  // Don't show when P&L disagrees (e.g. short down 5%+ — price moving against us)
  const tp2 = trade.takeProfit2;
  if (tp2 && !inSignificantLoss) {
    let progress = 0;
    if (isLong && tp2 > trade.entryPrice) {
      progress = (currentPrice - trade.entryPrice) / (tp2 - trade.entryPrice);
    } else if (!isLong && tp2 < trade.entryPrice) {
      progress = (trade.entryPrice - currentPrice) / (trade.entryPrice - tp2);
    }
    // Signal still aligned with our trade direction = score in favor
    const scoreInFavor = isLong
      ? (signal.signal === 'BUY' || signal.signal === 'STRONG_BUY')
      : (signal.signal === 'SELL' || signal.signal === 'STRONG_SELL');
    if (progress >= 0.5 && scoreInFavor) {
      messages.push({ type: 'positive', text: 'TP probability rising' });
    }
  }

  // 6. Consider partial (near TP1 with signals weakening for our direction)
  // Don't suggest when LONG is in solid profit (5%+) — let winners run
  const tp1 = trade.takeProfit1;
  if (tp1 && !(isLong && inSolidProfit)) {
    const nearTP1 = isLong
      ? currentPrice >= tp1 * 0.98
      : currentPrice <= tp1 * 1.02;
    // Momentum weakening = momentum dimension score dropped (less setup quality regardless of direction)
    const momentumWeakening = hasEntryBreakdown && (cb.momentum || 0) < (eb.momentum || 0);
    const weakening = effectiveDiff < 0 || momentumWeakening;
    if (nearTP1 && weakening) {
      messages.push({ type: 'info', text: 'Consider partial' });
    }
  }

  // 7. Consider BE stop (1R+ in profit, stop not yet at breakeven)
  const sl = trade.stopLoss;
  const origSlForLock = trade.originalStopLoss || sl;
  let riskForLock = origSlForLock != null ? (isLong ? trade.entryPrice - origSlForLock : origSlForLock - trade.entryPrice) : 0;
  if (riskForLock <= 0) {
    const tp = trade.takeProfit2 || trade.takeProfit1 || trade.takeProfit3;
    if (tp && tp !== trade.entryPrice) riskForLock = Math.abs(trade.entryPrice - tp) / (tp === trade.takeProfit2 ? 2 : 1);
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
    const levMsg = trade.leverage || 1;
    const pnlPct = (isLong ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100 : (trade.entryPrice - currentPrice) / trade.entryPrice * 100) * levMsg;
    if (pnlPct >= 5) effectiveProgress = 0.9;
    else if (pnlPct >= 2) effectiveProgress = 0.5;
  }
  if (riskForLock > 0 && trade.stopLoss != null) {
    const currentLockR = getCurrentLockR(trade, riskForLock);
    if (currentLockR >= 0.5) {
      const label = currentLockR >= 1 ? '1R' : currentLockR >= 0.75 ? '0.75R' : '0.5R';
      messages.push({ type: 'positive', text: 'Profit locked: ' + label });
      // Check if a higher lock-in level is available
      if (currentLockR < 1) {
        for (const lvl of LOCK_IN_LEVELS) {
          if (lvl.lockR > currentLockR && effectiveProgress >= lvl.progress) {
            messages.push({ type: 'info', text: 'Lock in profit available' });
            break;
          }
        }
      }
    } else if (effectiveProgress >= 0.5) {
      messages.push({ type: 'info', text: 'Lock in profit available' });
    }
  }

  // 9. High leverage warning (don't scare when in solid profit — 4%+)
  const levForMsg = trade.leverage || 1;
  if (levForMsg >= 3 && effectiveDiff <= -5 && !inSolidProfit) {
    messages.push({ type: 'warning', text: 'High leverage \u2014 tighten risk' });
  }

  // 10. Funding rate warning: extreme funding = potential reversal
  if (signal.indicators && signal.indicators.fundingRate != null) {
    const fr = signal.indicators.fundingRate;
    if (isLong && fr > 0.001) {
      messages.push({ type: 'warning', text: 'Funding rate extreme positive — longs crowded' });
    } else if (!isLong && fr < -0.001) {
      messages.push({ type: 'warning', text: 'Funding rate extreme negative — shorts crowded' });
    } else if (isLong && fr < -0.0005 && !inSignificantLoss) {
      messages.push({ type: 'positive', text: 'Funding rate favors longs' });
    } else if (!isLong && fr > 0.0005 && !inSignificantLoss) {
      messages.push({ type: 'positive', text: 'Funding rate favors shorts' });
    }
  }

  // 11. BTC correlation warning
  if (signal.indicators && signal.indicators.btcCorrelation != null && signal.indicators.btcCorrelation > 0.7) {
    messages.push({ type: 'info', text: `High BTC correlation (${(signal.indicators.btcCorrelation * 100).toFixed(0)}%) \u2014 watch BTC` });
  }

  // 12. Stale trade: open > 48h with < 1% raw P&L
  if (trade.entryTime) {
    const hoursOpen = (Date.now() - new Date(trade.entryTime).getTime()) / (1000 * 60 * 60);
    if (hoursOpen >= 48) {
      const rawPnlPct = trade.entryPrice > 0
        ? Math.abs((isLong ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice)) / trade.entryPrice * 100)
        : 0;
      if (rawPnlPct < 1) {
        messages.push({ type: 'info', text: 'Trade stale \u2014 consider closing' });
      }
    }
  }

  // Default: neutral status when nothing noteworthy
  // When in significant loss, don't say "Score holding steady" — price disagrees
  if (messages.length === 0) {
    if (inSignificantLoss) {
      messages.push({ type: 'warning', text: 'Price action against position — score may lag' });
    } else if (effectiveDiff >= 0) {
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
      // Try live price first, fall back to cached
      let currentPrice;
      try {
        const { fetchLivePrice } = require('./crypto-api');
        const livePrice = await fetchLivePrice(trade.coinId);
        if (livePrice != null && Number.isFinite(livePrice) && livePrice > 0) {
          currentPrice = livePrice;
        }
      } catch (err) { /* fall through to cache */ }
      if (!currentPrice) {
        const priceData = getCurrentPriceFunc(trade.coinId);
        if (!priceData) {
          console.warn(`[ScoreCheck] No price data for ${trade.symbol} (${trade.coinId}) – skipping`);
          continue;
        }
        currentPrice = priceData.price;
      }

      // PRICE SANITY CHECK: don't evaluate score against a wildly wrong price
      if (trade.entryPrice > 0 && currentPrice > 0) {
        const priceDrift = Math.abs(currentPrice - trade.entryPrice) / trade.entryPrice;
        if (priceDrift > 0.5) {
          console.error(`[ScoreCheck] PRICE SANITY FAIL: ${trade.symbol} entry=$${trade.entryPrice} current=$${currentPrice} (${(priceDrift * 100).toFixed(1)}% drift) – skipping`);
          continue;
        }
      }

      const signal = await getSignalForCoin(trade.coinId);
      if (!signal) {
        console.warn(`[ScoreCheck] No signal for ${trade.symbol} (${trade.coinId}) – skipping`);
        continue;
      }

      const messages = generateScoreCheckMessages(trade, signal, currentPrice);
      const scoreDiff = (signal.score || 0) - (trade.score || 0);
      let changeReasons = determineChangeReasons(trade, signal);
      const isLong = trade.direction === 'LONG';
      const lev = trade.leverage || 1;
      const pnlPct = trade.entryPrice > 0
        ? ((isLong ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice)) / trade.entryPrice * 100) * lev
        : 0;
      const inSignificantLoss = pnlPct < -5;
      if (inSignificantLoss) {
        // Strip positive and neutral reasons when P&L strongly disagrees — they mislead the user
        changeReasons = changeReasons.filter(r => r.type !== 'positive' && !(r.type === 'neutral' && r.text === 'No significant changes detected'));
        const dirLabel = isLong ? 'long' : 'short';
        const hasPriceWarning = changeReasons.some(r => r.text && r.text.includes('Price moving'));
        if (!hasPriceWarning) {
          changeReasons = [{ type: 'warning', text: `Price moving against ${dirLabel} — score may lag` }, ...changeReasons];
        }
        // Ensure there's always at least one reason
        if (changeReasons.length === 0) {
          changeReasons = [{ type: 'warning', text: `Price moving against ${dirLabel} — score may lag` }];
        }
      }
      const heat = determineHeat(scoreDiff, messages, isLong, pnlPct, signal.signal);
      const suggestedAction = determineSuggestedAction(scoreDiff, heat, messages, isLong, trade, currentPrice, signal.signal);
      // Win prob: score measures setup QUALITY for both directions.
      // High score = strong setup = high probability regardless of LONG/SHORT.
      // Direction is handled by penalizing when signal disagrees with trade.
      const entryScore = trade.score || 0;
      const currentScore = signal.score || 0;
      const entryProbability = calculateWinProbability(entryScore);
      let currentProbability = calculateWinProbability(currentScore);

      // Signal direction penalty: if signal no longer supports our trade direction
      const currentSignalStr = signal.signal;
      const sigFlipped = isLong
        ? (currentSignalStr === 'SELL' || currentSignalStr === 'STRONG_SELL')
        : (currentSignalStr === 'BUY' || currentSignalStr === 'STRONG_BUY');
      if (sigFlipped) {
        currentProbability = Math.min(currentProbability, 20);  // Signal reversed = very low prob
      } else if (currentSignalStr === 'HOLD') {
        currentProbability = Math.max(currentProbability - 15, 10);  // Direction neutral = lower prob
      }

      // P&L-based probability adjustment
      let pnlProbAdj = 0;
      if (pnlPct <= -15) pnlProbAdj = -20;
      else if (pnlPct <= -10) pnlProbAdj = -15;
      else if (pnlPct <= -5) pnlProbAdj = -8;
      else if (pnlPct <= -2) pnlProbAdj = -3;
      else if (pnlPct >= 10) pnlProbAdj = 5;
      else if (pnlPct >= 5) pnlProbAdj = 3;
      currentProbability = Math.min(95, Math.max(5, currentProbability + pnlProbAdj));

      // Score diff display: same for both directions. Positive = setup quality improved.
      const scoreDiffFavorable = scoreDiff >= 0 && !sigFlipped && currentSignalStr !== 'HOLD';
      const scoreDiffDisplay = scoreDiff;  // Same for both: positive = setup quality improved

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
      const autoExec = user?.settings?.autoExecuteActions;
      if (autoExec && suggestedAction?.actionId) {
        const result = await executeScoreCheckAction(trade, suggestedAction, currentPrice, getCurrentPriceFunc);
        if (result.executed) {
          console.log(`[ScoreCheck] AUTO-EXECUTED ${suggestedAction.actionId} on ${trade.symbol}: ${result.details}`);
        }
      }

      // Log summary for debugging
      console.log(`[ScoreCheck] ${trade.symbol} ${trade.direction} | score: ${currentScore} (entry: ${entryScore}, diff: ${scoreDiff}) | heat: ${heat} | action: ${suggestedAction?.text || 'none'} | autoExec: ${autoExec ? 'ON' : 'OFF'}`);
    } catch (err) {
      console.error(`[ScoreCheck] Error rechecking ${trade.symbol}:`, err.message);
    }
  }

  if (checkedCount > 0) {
    console.log(`[ScoreCheck] Rechecked ${checkedCount} open trades at ${new Date().toLocaleTimeString()}`);
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
    // Summarize actions for chart markers
    const actionTypes = (t.actions || []).map(a => a.type).filter(Boolean);
    equityCurve.push({
      date: t.exitTime,
      equity: Math.round(equity * 100) / 100,
      drawdown: Math.round(dd * 100) / 100,
      drawdownPct: Math.round(ddPct * 100) / 100,
      pnl: t.pnl,
      regime: t.regime,
      symbol: t.symbol,
      status: t.status,
      closeReason: t.closeReason,
      direction: t.direction,
      actions: actionTypes
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
