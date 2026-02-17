// services/backtest/trade-state.js
// ====================================================
// TRADE STATE MACHINE - Per-trade state + invariants
// Stops only move toward safety. Actions idempotent.
// ====================================================

const VALID_STATUS = ['OPEN', 'CLOSED', 'ERROR'];

function r2(v) {
  return Math.round(v * 1000000) / 1000000;
}

/**
 * Create new trade state from orders
 */
function createTrade(orders, barIndex, id) {
  return {
    id: id || `bt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: orders.symbol,
    coinId: orders.coinId,
    direction: orders.direction,
    entry: orders.entry,
    entryPrice: orders.entry,
    entryBar: barIndex,
    stopLoss: orders.stopLoss,
    originalStopLoss: orders.originalStopLoss ?? orders.stopLoss,
    takeProfit1: orders.takeProfit1,
    takeProfit2: orders.takeProfit2,
    takeProfit3: orders.takeProfit3,
    size: orders.size,
    positionSize: orders.size,
    originalSize: orders.size,
    originalPositionSize: orders.size,
    leverage: orders.leverage ?? 1,
    strategy: orders.strategy,
    regime: orders.regime,
    score: orders.score,
    entryScore: orders.score,
    maxPrice: orders.entry,
    minPrice: orders.entry,
    partialPnl: 0,
    partialTakenAtTP1: false,
    partialTakenAtTP2: false,
    breakevenHit: false,
    trailingActivated: false,
    reducedByScore: false,
    takenPartialByScore: false,
    lastScoreCheckBar: null,
    tpMode: orders.tpMode || 'fixed',
    trailingTpDistance: orders.trailingTpDistance,
    actions: [],
    status: 'OPEN'
  };
}

/**
 * Invariant: stops only move toward safety (never widen risk)
 */
function isValidStopMove(trade, newStop) {
  if (newStop == null) return false;
  const isLong = trade.direction === 'LONG';
  const currentSl = trade.stopLoss;
  if (currentSl == null) return true;

  if (isLong) {
    return newStop > currentSl && newStop < (trade.maxPrice || Infinity);
  }
  return newStop < currentSl && newStop > (trade.minPrice || 0);
}

/**
 * Invariant: TP/SL correct for long/short
 */
function validateLevels(trade) {
  const isLong = trade.direction === 'LONG';
  if (isLong) {
    if (trade.stopLoss != null && trade.stopLoss >= trade.entry) return false;
    if (trade.takeProfit1 != null && trade.takeProfit1 <= trade.entry) return false;
    if (trade.takeProfit2 != null && trade.takeProfit2 <= trade.entry) return false;
    if (trade.takeProfit3 != null && trade.takeProfit3 <= trade.entry) return false;
  } else {
    if (trade.stopLoss != null && trade.stopLoss <= trade.entry) return false;
    if (trade.takeProfit1 != null && trade.takeProfit1 >= trade.entry) return false;
    if (trade.takeProfit2 != null && trade.takeProfit2 >= trade.entry) return false;
    if (trade.takeProfit3 != null && trade.takeProfit3 >= trade.entry) return false;
  }
  return true;
}

/**
 * Apply management action to trade; enforce invariants
 */
function applyAction(trade, action) {
  const next = { ...trade };
  const isLong = trade.direction === 'LONG';

  if (action.type === 'BE' || action.type === 'TS' || action.type === 'LOCK') {
    const newStop = action.newStop ?? action.newValue;
    if (newStop == null) return { trade: next, error: null };
    const isBE = action.type === 'BE';
    const towardSafety = isLong ? newStop > (next.stopLoss || 0) : newStop < (next.stopLoss || Infinity);
    if (!towardSafety) {
      next.status = 'ERROR';
      return { trade: next, error: 'Invalid stop move: would widen risk' };
    }
    if (!isBE && !isValidStopMove(next, newStop)) {
      next.status = 'ERROR';
      return { trade: next, error: 'Invalid stop move: would widen risk' };
    }
    next.stopLoss = r2(newStop);
    next.actions = [...(next.actions || []), { type: action.type, bar: action.bar, newValue: newStop, marketPrice: action.marketPrice }];
    if (action.type === 'BE') next.breakevenHit = true;
    if (action.type === 'TS') next.trailingActivated = true;
  }

  if (action.type === 'RP' || action.type === 'PP') {
    const portion = action.portion || 0;
    const posSize = next.positionSize ?? next.size;
    if (portion > posSize) {
      next.status = 'ERROR';
      return { trade: next, error: 'Partial exceeds position size' };
    }
    next.size -= portion;
    next.positionSize -= portion;
    if (action.type === 'RP') next.reducedByScore = true;
    if (action.type === 'PP') next.takenPartialByScore = true;
    next.actions = [...(next.actions || []), { type: action.type, portion, marketPrice: action.marketPrice }];
  }

  if (action.type === 'TP1' || action.type === 'TP2' || action.type === 'TP3') {
    const portion = action.portion || 0;
    const posSize = next.positionSize ?? next.size;
    if (action.fullClose) {
      next.size = 0;
      next.positionSize = 0;
      next.status = 'CLOSED';
    } else {
      if (portion > posSize) {
        next.status = 'ERROR';
        return { trade: next, error: 'TP portion exceeds position size' };
      }
      next.size -= portion;
      next.positionSize -= portion;
    }
    if (action.type === 'TP1') next.partialTakenAtTP1 = true;
    if (action.type === 'TP2') next.partialTakenAtTP2 = true;
    next.actions = [...(next.actions || []), { type: action.type, portion, marketPrice: action.marketPrice }];
  }

  if (action.type === 'SL' || action.type === 'EXIT') {
    next.size = 0;
    next.positionSize = 0;
    next.status = 'CLOSED';
    next.actions = [...(next.actions || []), { type: action.type, marketPrice: action.marketPrice }];
  }

  if (action.type !== 'BE' && !validateLevels(next) && next.status === 'OPEN') {
    next.status = 'ERROR';
    return { trade: next, error: 'TP/SL levels invalid for direction' };
  }

  return { trade: next, error: null };
}

/**
 * Update trade with max/min price from bar
 */
function updatePriceRange(trade, high, low) {
  const next = { ...trade };
  if (high != null && high > (next.maxPrice || 0)) next.maxPrice = high;
  if (low != null && low < (next.minPrice || Infinity)) next.minPrice = low;
  return next;
}

module.exports = {
  createTrade,
  isValidStopMove,
  validateLevels,
  applyAction,
  updatePriceRange,
  VALID_STATUS,
  r2
};
