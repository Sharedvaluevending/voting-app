// services/backtest/execution-simulator.js
// ====================================================
// EXECUTION SIMULATOR - Realistic fill simulation
// Order types: market, limit, stop, stop-limit
// Spread, slippage, latency, fees, funding
// ====================================================

const DEFAULT_MAKER_FEE = 0.001;
const DEFAULT_TAKER_FEE = 0.001;

/**
 * Compute market order slippage: max(min_slip_bps, k * ATR% * size_factor)
 */
function computeMarketSlippageBps(order, snapshot, config) {
  config = config || {};
  const minBps = config.minSlipBps ?? 5;
  const k = config.slippageK ?? 1;
  const sizeFactor = config.sizeFactor ?? 1;
  const atr = snapshot?.indicators?.atr || snapshot?.coinData?.atr;
  const price = snapshot?.currentPrice || snapshot?.coinData?.price || order.entry;
  const atrPct = atr && price > 0 ? (atr / price) * 100 : 0;
  const sizeMult = Math.min(2, 1 + (order.size || 0) / 100000); // Larger size = more slippage
  const slipBps = Math.max(minBps, k * atrPct * 100 * sizeFactor * sizeMult);
  return slipBps;
}

/**
 * Apply slippage to fill price (market order)
 */
function applySlippage(price, direction, slipBps, isEntry) {
  const mult = 1 + (slipBps / 10000);
  // LONG entry: pay more (worse). LONG exit: receive less
  if (direction === 'LONG') {
    return isEntry ? price * mult : price / mult;
  }
  return isEntry ? price / mult : price * mult;
}

/**
 * Simulate market order fill
 */
function fillMarketOrder(order, snapshot, config) {
  const price = snapshot.currentPrice ?? snapshot.coinData?.price ?? order.entry;
  const slipBps = computeMarketSlippageBps(order, snapshot, config);
  const fillPrice = applySlippage(price, order.direction, slipBps, true);
  const takerFee = config.takerFee ?? DEFAULT_TAKER_FEE;
  const fees = order.size * takerFee;
  return {
    filled: true,
    fillPrice,
    fillQty: order.size,
    fees,
    slippageBps: slipBps,
    orderType: 'market'
  };
}

/**
 * Check if limit order would fill (price traded through limit considering spread)
 */
function wouldLimitFill(limitPrice, direction, bar, spreadBps) {
  const { open, high, low, close } = bar;
  const spread = (spreadBps / 10000) * (open || close);
  if (direction === 'LONG') {
    // Buy limit: fill when low <= limitPrice + spread
    return low <= limitPrice + spread;
  }
  // Sell limit: fill when high >= limitPrice - spread
  return high >= limitPrice - spread;
}

/**
 * Simulate limit order fill (full or partial)
 */
function fillLimitOrder(order, snapshot, config) {
  const bar = snapshot.nextBar || snapshot.bar || { open: snapshot.currentPrice, high: snapshot.currentPrice, low: snapshot.currentPrice, close: snapshot.currentPrice };
  const spreadBps = config.spreadBps ?? 5;
  if (!wouldLimitFill(order.limitPrice, order.direction, bar, spreadBps)) {
    return { filled: false, fillPrice: null, fillQty: 0, fees: 0 };
  }
  const makerFee = config.makerFee ?? DEFAULT_MAKER_FEE;
  const fillPrice = order.limitPrice;
  const fees = order.size * makerFee;
  return {
    filled: true,
    fillPrice,
    fillQty: order.size,
    fees,
    orderType: 'limit'
  };
}

/**
 * Simulate stop order fill (triggers when price hits stop)
 */
function fillStopOrder(order, snapshot, config) {
  const bar = snapshot.nextBar || snapshot.bar;
  if (!bar) return { filled: false };
  const { high, low } = bar;
  const isLong = order.direction === 'LONG';
  const hit = isLong ? low <= order.stopPrice : high >= order.stopPrice;
  if (!hit) return { filled: false };
  const slipBps = config.minSlipBps ?? 5;
  const fillPrice = applySlippage(order.stopPrice, order.direction, slipBps, false);
  const takerFee = config.takerFee ?? DEFAULT_TAKER_FEE;
  const fees = order.size * takerFee;
  return {
    filled: true,
    fillPrice,
    fillQty: order.size,
    fees,
    orderType: 'stop'
  };
}

/**
 * Simulate stop-limit order (stop triggers, then limit fill)
 */
function fillStopLimitOrder(order, snapshot, config) {
  const bar = snapshot.nextBar || snapshot.bar;
  if (!bar) return { filled: false };
  const { high, low } = bar;
  const isLong = order.direction === 'LONG';
  const stopHit = isLong ? low <= order.stopPrice : high >= order.stopPrice;
  if (!stopHit) return { filled: false };
  const limitOrder = { ...order, limitPrice: order.limitPrice, direction: order.direction, size: order.size };
  return fillLimitOrder(limitOrder, snapshot, config);
}

/**
 * Execute order based on type
 */
function execute(order, snapshot, config) {
  config = config || {};
  const type = order.orderType || 'market';
  switch (type) {
    case 'market':
      return fillMarketOrder(order, snapshot, config);
    case 'limit':
      return fillLimitOrder(order, snapshot, config);
    case 'stop':
      return fillStopOrder(order, snapshot, config);
    case 'stop-limit':
      return fillStopLimitOrder(order, snapshot, config);
    default:
      return fillMarketOrder(order, snapshot, config);
  }
}

/**
 * Apply funding payment (futures)
 */
function applyFunding(trade, fundingRate, timestamp) {
  if (!trade || !fundingRate || fundingRate === 0) return 0;
  const notional = trade.size || trade.positionSize;
  const payment = notional * fundingRate;
  return payment; // Positive = long pays short
}

module.exports = {
  execute,
  fillMarketOrder,
  fillLimitOrder,
  fillStopOrder,
  fillStopLimitOrder,
  computeMarketSlippageBps,
  applySlippage,
  wouldLimitFill,
  applyFunding,
  DEFAULT_MAKER_FEE,
  DEFAULT_TAKER_FEE
};
