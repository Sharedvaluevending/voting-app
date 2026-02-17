// services/engines/risk-engine.js
// ====================================================
// RISK ENGINE - Single source of truth for position sizing and order planning
// Extracted from paper-trading.openTrade. Pure function: no DB.
// Used by paper-trading, live, and backtest.
// ====================================================

const SLIPPAGE_BPS = 5;
const MAX_SL_DISTANCE_PCT = 0.15;
const BE_BUFFER_PCT = 0.003;
const TP1_PCT = 0.4;
const TP2_PCT = 0.3;
const TP3_PCT = 0.3;

const DEFAULT_MAKER_FEE = 0.001;
const DEFAULT_TAKER_FEE = 0.001;

function getMakerFee(userSettings) {
  const pct = userSettings?.makerFeePercent;
  return (Number.isFinite(pct) ? pct / 100 : DEFAULT_MAKER_FEE);
}

function getTakerFee(userSettings) {
  const pct = userSettings?.takerFeePercent;
  return (Number.isFinite(pct) ? pct / 100 : DEFAULT_TAKER_FEE);
}

function calculatePositionSize(balance, riskPercent, entryPrice, stopLoss, leverage, opts) {
  opts = opts || {};
  if (!entryPrice || entryPrice <= 0) return balance * 0.05 * leverage;
  const riskMode = opts.riskMode || 'percent';
  const riskAmount = riskMode === 'dollar' && Number.isFinite(opts.riskDollarsPerTrade) && opts.riskDollarsPerTrade > 0
    ? opts.riskDollarsPerTrade
    : balance * (riskPercent / 100);
  let stopDistance = typeof stopLoss === 'number' && stopLoss > 0
    ? Math.abs(entryPrice - stopLoss) / entryPrice
    : 0.02;
  if (stopDistance <= 0 || !Number.isFinite(stopDistance)) stopDistance = 0.02;
  const positionSize = (riskAmount / stopDistance) * leverage;
  const capped = Math.min(positionSize, balance * leverage * 0.95);
  return Number.isFinite(capped) ? capped : balance * 0.1 * leverage;
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

/**
 * Plan orders from a signal decision.
 * @param {Object} decision - From SignalEngine.evaluate
 * @param {Object} snapshot - { coinData, candles, ... }
 * @param {Object} context - { balance, openTrades, streak, strategyStats, featureFlags, userSettings }
 * @returns {Object|null} orders - { entry, stopLoss, takeProfit1/2/3, size, leverage, margin, fees, ... } or null if invalid
 */
function plan(decision, snapshot, context) {
  context = context || {};
  const { balance, openTrades = [], streak = 0, strategyStats = {}, featureFlags = {}, userSettings = {} } = context;

  if (!decision || !decision.side) return null;
  if (!decision.entry || !decision.stopLoss) return null;

  const direction = decision.side;
  const leverage = userSettings.disableLeverage ? 1 : (decision.suggestedLeverage || userSettings.defaultLeverage || 1);
  const riskPercent = userSettings.riskPerTrade || 2;
  const riskMode = userSettings.riskMode || 'percent';
  const riskDollarsPerTrade = userSettings.riskDollarsPerTrade ?? 200;
  const maxBalancePct = userSettings.maxBalancePercentPerTrade ?? 25;
  const ff = featureFlags;

  // Slippage: worse entry (LONG pay more, SHORT receive less)
  const slippage = 1 + (SLIPPAGE_BPS / 10000);
  const entryPrice = direction === 'LONG'
    ? decision.entry * slippage
    : decision.entry / slippage;
  let stopLoss = decision.stopLoss;

  // CAP STOP LOSS DISTANCE (max 15% from entry)
  if (ff.slCap !== false && stopLoss != null && entryPrice > 0) {
    const slDistance = Math.abs(entryPrice - stopLoss) / entryPrice;
    if (slDistance > MAX_SL_DISTANCE_PCT) {
      stopLoss = direction === 'LONG'
        ? entryPrice * (1 - MAX_SL_DISTANCE_PCT)
        : entryPrice * (1 + MAX_SL_DISTANCE_PCT);
    }
  }

  // Validate SL on correct side of entry
  if (stopLoss != null && entryPrice > 0) {
    const wrongSide = (direction === 'LONG' && stopLoss >= entryPrice)
      || (direction === 'SHORT' && stopLoss <= entryPrice);
    if (wrongSide) {
      stopLoss = direction === 'LONG'
        ? entryPrice * 0.98
        : entryPrice * 1.02;
    }
  }

  // MIN SL DISTANCE (1x ATR floor)
  const atr = decision.indicators?.atr;
  if (ff.minSlDistance !== false && atr > 0) {
    const minSlDist = atr * 1.0;
    const currentSlDist = Math.abs(entryPrice - stopLoss);
    if (currentSlDist < minSlDist) {
      stopLoss = direction === 'LONG'
        ? entryPrice - minSlDist
        : entryPrice + minSlDist;
    }
  }

  let positionSize = calculatePositionSize(
    balance, riskPercent, entryPrice, stopLoss, leverage,
    { riskMode, riskDollarsPerTrade }
  );

  // Confidence-weighted size
  if (ff.confidenceSizing !== false) {
    const score = Math.min(100, Math.max(0, decision.score || 50));
    const confidenceMult = Math.min(1.2, 0.5 + score / 100);
    positionSize *= confidenceMult;
  }

  // Win/loss streak adjustment
  if (streak <= -3) positionSize *= 0.6;
  else if (streak <= -2) positionSize *= 0.75;
  else if (streak >= 3) positionSize *= Math.min(1.15, 1 + streak * 0.03);

  // Kelly criterion sizing
  const strat = strategyStats[decision.strategy];
  if (strat && strat.totalTrades >= 15 && strat.winRate > 0 && strat.avgRR > 0) {
    const w = strat.winRate / 100;
    const r = strat.avgRR;
    const kellyFull = w - ((1 - w) / r);
    if (kellyFull > 0) {
      const kellyFraction = Math.min(0.25, kellyFull * 0.25);
      const kellySize = balance * kellyFraction * leverage;
      positionSize = Math.min(positionSize, kellySize);
    } else if (kellyFull < -0.1) {
      positionSize *= 0.5;
    }
  }

  // Cap margin to max % of balance
  const maxMarginByPct = balance * (Math.min(100, Math.max(5, maxBalancePct)) / 100);
  const maxPositionByMarginPct = maxMarginByPct * leverage;
  positionSize = Math.min(positionSize, Math.max(0, maxPositionByMarginPct));

  const makerFee = getMakerFee(userSettings);
  const maxSpend = Math.max(0, balance - 0.50);
  const maxPositionFromBalance = maxSpend / (1 / leverage + makerFee);
  positionSize = Math.min(positionSize, Math.max(0, maxPositionFromBalance));

  if (!Number.isFinite(positionSize) || positionSize <= 0) {
    positionSize = Math.min(balance * 0.02 * leverage, maxPositionFromBalance);
  }

  let margin = positionSize / leverage;
  let fees = positionSize * makerFee;
  let required = margin + fees;

  if (required > balance && balance > 0) {
    const maxPosByBalance = (balance - 0.01) / (1 / leverage + makerFee);
    positionSize = Math.min(positionSize, Math.max(0, maxPosByBalance));
    margin = positionSize / leverage;
    fees = positionSize * makerFee;
    required = margin + fees;
  }

  if (balance <= 0 || required > balance) return null;

  // TP mode and levels
  const tpMode = userSettings.tpMode || 'fixed';
  let takeProfit1 = decision.takeProfit1;
  let takeProfit2 = decision.takeProfit2;
  let takeProfit3 = decision.takeProfit3;
  let trailingTpDistance = null;

  if (tpMode === 'trailing') {
    takeProfit1 = null;
    takeProfit2 = null;
    takeProfit3 = null;
    const distMode = userSettings.trailingTpDistanceMode || 'atr';
    if (distMode === 'atr' && atr > 0) {
      const mult = userSettings.trailingTpAtrMultiplier ?? 1.5;
      trailingTpDistance = atr * mult;
    } else {
      const pct = userSettings.trailingTpFixedPercent ?? 2;
      trailingTpDistance = entryPrice * (pct / 100);
    }
  } else {
    // Sanity: TPs must be on correct side
    if (direction === 'LONG') {
      if (takeProfit1 && takeProfit1 < entryPrice) takeProfit1 = null;
      if (takeProfit2 && takeProfit2 < entryPrice) takeProfit2 = null;
      if (takeProfit3 && takeProfit3 < entryPrice) takeProfit3 = null;
    } else {
      if (takeProfit1 && takeProfit1 > entryPrice) takeProfit1 = null;
      if (takeProfit2 && takeProfit2 > entryPrice) takeProfit2 = null;
      if (takeProfit3 && takeProfit3 > entryPrice) takeProfit3 = null;
    }
  }

  return {
    direction,
    entry: entryPrice,
    stopLoss,
    originalStopLoss: stopLoss,
    takeProfit1,
    takeProfit2,
    takeProfit3,
    size: positionSize,
    originalSize: positionSize,
    leverage,
    margin,
    fees,
    tpMode,
    trailingTpDistance,
    coinId: decision.coinId,
    symbol: decision.symbol,
    strategy: decision.strategy,
    regime: decision.regime,
    score: decision.score,
    reasoning: decision.reasons,
    indicators: decision.indicators,
    scoreBreakdown: decision.scoreBreakdown,
    stopType: decision.stopType,
    stopLabel: decision.stopLabel,
    tpType: decision.tpType,
    tpLabel: decision.tpLabel
  };
}

module.exports = {
  plan,
  calculatePositionSize,
  suggestLeverage,
  SLIPPAGE_BPS,
  MAX_SL_DISTANCE_PCT,
  BE_BUFFER_PCT,
  TP1_PCT,
  TP2_PCT,
  TP3_PCT,
  getMakerFee,
  getTakerFee
};
