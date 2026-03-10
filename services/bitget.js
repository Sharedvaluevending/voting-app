// services/bitget.js
// ====================================================
// BITGET LIVE EXECUTION
// Wraps Bitget V2 REST API for live futures trading.
// Uses apiKey + secretKey + passphrase authentication.
// Supports native SL/TP orders on the exchange and
// dry-run mode for testing without real money.
// ====================================================

const { RestClientV2 } = require('bitget-api');
const { getCoinMeta } = require('./crypto-api');

const PRODUCT_TYPE = 'USDT-FUTURES';
const MARGIN_COIN = 'USDT';
const MARGIN_MODE = 'crossed';

function getBitgetSymbol(coinId) {
  const meta = getCoinMeta(coinId);
  if (!meta || !meta.bybit) throw new Error(`No Bitget symbol for ${coinId}`);
  return meta.bybit;
}

function getClient(user) {
  if (!user.bitget || !user.bitget.apiKey || !user.bitget.secretKey || !user.bitget.passphrase) {
    throw new Error('Bitget API keys not configured');
  }
  return new RestClientV2({
    apiKey: user.bitget.apiKey,
    apiSecret: user.bitget.secretKey,
    apiPass: user.bitget.passphrase
  });
}

function isDryRun(user) {
  return !!(user.liveTrading?.dryRun);
}

// ====================================================
// CONNECTION TEST
// ====================================================
async function testConnection(user) {
  try {
    const client = getClient(user);
    await client.getFuturesAccountAsset({ productType: PRODUCT_TYPE });
    return { success: true, message: 'Connected to Bitget successfully' };
  } catch (err) {
    console.error('[Bitget] Connection test failed:', err.message);
    return { success: false, message: `Connection failed: ${err.message}` };
  }
}

// ====================================================
// ACCOUNT BALANCE
// ====================================================
async function getAccountBalance(user) {
  try {
    const client = getClient(user);
    const res = await client.getFuturesAccountAsset({ productType: PRODUCT_TYPE });
    const data = res?.data;
    if (!data) return { success: false, error: 'No balance data' };

    const equity = parseFloat(data.accountEquity || data.equityOfBtc || data.usdtEquity || 0);
    const available = parseFloat(data.available || data.availableBalance || 0);
    const unrealizedPnl = parseFloat(data.crossedUnrealizedPL || data.isolatedUnrealizedPL || data.unrealizedPL || 0);

    return {
      success: true,
      balances: {
        spot: null,
        futures: {
          equity,
          available,
          unrealizedPnl
        }
      }
    };
  } catch (err) {
    console.error('[Bitget] Get balance error:', err.message);
    return { success: false, error: err.message };
  }
}

// ====================================================
// OPEN POSITIONS
// ====================================================
async function getOpenPositions(user) {
  try {
    const client = getClient(user);
    const res = await client.getFuturesPositions({ productType: PRODUCT_TYPE, marginCoin: MARGIN_COIN });
    const list = res?.data || [];
    const positions = list
      .filter(p => parseFloat(p.total || p.holdSide ? 1 : 0) > 0)
      .map(p => ({
        symbol: p.symbol,
        holdSide: (p.holdSide || p.side || '').toLowerCase().includes('long') ? 'long' : 'short',
        total: p.total || p.available,
        openPriceAvg: p.openPriceAvg || p.avgOpenPrice,
        markPrice: p.markPrice,
        unrealizedPL: p.unrealizedPL || p.unrealizedPnl,
        leverage: p.leverage
      }));
    return { success: true, positions };
  } catch (err) {
    console.error('[Bitget] Get positions error:', err.message);
    return { success: true, positions: [] };
  }
}

// ====================================================
// PLACE ORDER (Futures market)
// ====================================================
async function placeOrder(user, params) {
  const { coinId, direction, size, orderType = 'market', limitPrice } = params;
  const symbol = getBitgetSymbol(coinId);
  const side = direction === 'LONG' ? 'buy' : 'sell';
  const sizeStr = String(Math.max(0.001, parseFloat(size.toFixed(6))));

  const orderParams = {
    symbol,
    productType: PRODUCT_TYPE,
    marginMode: MARGIN_MODE,
    marginCoin: MARGIN_COIN,
    side,
    orderType: orderType === 'limit' && limitPrice ? 'limit' : 'market',
    size: sizeStr
  };
  if (orderParams.orderType === 'limit' && limitPrice) {
    orderParams.price = String(limitPrice);
  }

  if (isDryRun(user)) {
    console.log(`[Bitget][DRY-RUN] Would place order: ${symbol} ${side} size=${sizeStr} type=${orderParams.orderType}`);
    return { success: true, orderId: `dryrun_${Date.now()}`, symbol, dryRun: true, details: orderParams };
  }

  try {
    const client = getClient(user);
    const result = await client.futuresSubmitOrder(orderParams);
    const orderId = result?.data?.orderId || result?.orderId || '';
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Bitget] Order placed: ${symbol} ${side} orderId=${orderId}`);
    }
    return {
      success: true,
      orderId,
      symbol,
      details: result?.data || result
    };
  } catch (err) {
    console.error(`[Bitget] Order failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ====================================================
// CLOSE POSITION
// ====================================================
async function closePosition(user, coinId, direction, size) {
  const closeSide = direction === 'LONG' ? 'sell' : 'buy';
  return placeOrder(user, {
    coinId,
    direction: closeSide === 'buy' ? 'LONG' : 'SHORT',
    size,
    orderType: 'market'
  });
}

// ====================================================
// CLOSE ALL POSITIONS (Kill switch)
// ====================================================
async function closeAllPositions(user) {
  if (isDryRun(user)) {
    console.log('[Bitget][DRY-RUN] Would close all positions (kill switch)');
    return { success: true, results: [], dryRun: true, message: 'Dry-run kill switch — no positions closed' };
  }
  try {
    const client = getClient(user);
    const res = await client.getFuturesPositions({ productType: PRODUCT_TYPE, marginCoin: MARGIN_COIN });
    const list = res?.data || [];
    const openPositions = list.filter(p => parseFloat(p.total || 0) > 0);
    if (openPositions.length === 0) {
      return { success: true, results: [], message: 'No open positions' };
    }

    const results = [];
    for (const pos of openPositions) {
      try {
        await client.futuresFlashClosePositions({
          symbol: pos.symbol,
          productType: PRODUCT_TYPE,
          marginCoin: MARGIN_COIN,
          holdSide: pos.holdSide || (pos.side?.toLowerCase().includes('long') ? 'long' : 'short')
        });
        results.push({ symbol: pos.symbol, success: true });
      } catch (e) {
        results.push({ symbol: pos.symbol, success: false, error: e.message });
      }
    }
    const allOk = results.every(r => r.success);
    console.log(`[Bitget] Close all: ${results.length} positions, allOk=${allOk}`);
    return { success: allOk, results, error: allOk ? null : 'Some positions failed to close' };
  } catch (err) {
    console.error('[Bitget] Close all error:', err.message);
    return { success: false, error: err.message, results: [] };
  }
}

// ====================================================
// NATIVE TPSL ORDERS — Place SL/TP on Bitget exchange
// These protect positions even if the server goes down.
// ====================================================

async function placeTPSLOrders(user, trade) {
  const symbol = getBitgetSymbol(trade.coinId);
  const holdSide = trade.direction === 'LONG' ? 'long' : 'short';
  const sizeInCoins = trade.positionSize / trade.entryPrice;
  const size = String(Math.max(0.001, parseFloat(sizeInCoins.toFixed(6))));
  const results = { slOrderId: null, tpOrderId: null };

  if (isDryRun(user)) {
    console.log(`[Bitget][DRY-RUN] Would place TPSL: ${symbol} ${holdSide} SL=$${trade.stopLoss} TP=$${trade.takeProfit1 || 'none'}`);
    results.slOrderId = `dryrun_sl_${Date.now()}`;
    results.tpOrderId = trade.takeProfit1 ? `dryrun_tp_${Date.now()}` : null;
    return results;
  }

  const client = getClient(user);

  // Place stop-loss order (pos_loss — closes entire position at market)
  if (trade.stopLoss) {
    try {
      const slRes = await client.futuresSubmitTPSLOrder({
        marginCoin: MARGIN_COIN,
        productType: PRODUCT_TYPE,
        symbol,
        planType: 'pos_loss',
        triggerPrice: String(trade.stopLoss),
        triggerType: 'mark_price',
        holdSide,
        size
      });
      results.slOrderId = slRes?.data?.orderId || '';
      console.log(`[Bitget] SL order placed: ${symbol} ${holdSide} triggerPrice=$${trade.stopLoss} orderId=${results.slOrderId}`);
    } catch (err) {
      console.error(`[Bitget] SL order failed for ${symbol}: ${err.message}`);
    }
  }

  // Place take-profit order (pos_profit — uses TP1 as the exchange-level TP)
  const tpPrice = trade.takeProfit1 || trade.takeProfit2 || trade.takeProfit3;
  if (tpPrice) {
    try {
      const tpRes = await client.futuresSubmitTPSLOrder({
        marginCoin: MARGIN_COIN,
        productType: PRODUCT_TYPE,
        symbol,
        planType: 'pos_profit',
        triggerPrice: String(tpPrice),
        triggerType: 'mark_price',
        holdSide,
        size
      });
      results.tpOrderId = tpRes?.data?.orderId || '';
      console.log(`[Bitget] TP order placed: ${symbol} ${holdSide} triggerPrice=$${tpPrice} orderId=${results.tpOrderId}`);
    } catch (err) {
      console.error(`[Bitget] TP order failed for ${symbol}: ${err.message}`);
    }
  }

  return results;
}

async function cancelTPSLOrders(user, trade) {
  if (isDryRun(user)) {
    console.log(`[Bitget][DRY-RUN] Would cancel TPSL orders for ${trade.symbol}`);
    return { success: true, dryRun: true };
  }

  const client = getClient(user);
  const symbol = getBitgetSymbol(trade.coinId);
  const orderIds = [];
  if (trade.bitgetSlOrderId) orderIds.push({ orderId: trade.bitgetSlOrderId });
  if (trade.bitgetTpOrderId) orderIds.push({ orderId: trade.bitgetTpOrderId });

  if (orderIds.length === 0) return { success: true };

  try {
    await client.futuresCancelPlanOrder({
      orderIdList: orderIds,
      productType: PRODUCT_TYPE,
      symbol
    });
    console.log(`[Bitget] TPSL orders cancelled for ${symbol}: ${orderIds.map(o => o.orderId).join(', ')}`);
    return { success: true };
  } catch (err) {
    console.error(`[Bitget] Cancel TPSL error for ${symbol}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ====================================================
// UPDATE STOP LOSS — Modify or replace the SL order
// ====================================================
async function updateStopLoss(user, coinId, direction, newStopPrice, trade) {
  const symbol = getBitgetSymbol(coinId);
  const holdSide = direction === 'LONG' ? 'long' : 'short';

  if (isDryRun(user)) {
    console.log(`[Bitget][DRY-RUN] Would update SL: ${symbol} ${holdSide} newStop=$${newStopPrice}`);
    return { success: true, dryRun: true, orderId: `dryrun_sl_${Date.now()}` };
  }

  const client = getClient(user);

  // Cancel existing SL order first, then place a new one
  if (trade?.bitgetSlOrderId) {
    try {
      await client.futuresCancelPlanOrder({
        orderIdList: [{ orderId: trade.bitgetSlOrderId }],
        productType: PRODUCT_TYPE,
        symbol
      });
    } catch (err) {
      console.warn(`[Bitget] Could not cancel old SL order ${trade.bitgetSlOrderId}: ${err.message}`);
    }
  }

  const sizeInCoins = (trade?.positionSize || 0) / (trade?.entryPrice || 1);
  const size = String(Math.max(0.001, parseFloat(sizeInCoins.toFixed(6))));

  try {
    const res = await client.futuresSubmitTPSLOrder({
      marginCoin: MARGIN_COIN,
      productType: PRODUCT_TYPE,
      symbol,
      planType: 'pos_loss',
      triggerPrice: String(newStopPrice),
      triggerType: 'mark_price',
      holdSide,
      size
    });
    const orderId = res?.data?.orderId || '';
    console.log(`[Bitget] SL updated: ${symbol} ${holdSide} newStop=$${newStopPrice} orderId=${orderId}`);

    // Save new SL order ID on the trade
    if (trade) {
      trade.bitgetSlOrderId = orderId;
      await trade.save();
    }

    return { success: true, orderId };
  } catch (err) {
    console.error(`[Bitget] SL update failed for ${symbol}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ====================================================
// HIGH-LEVEL ACTION HANDLERS
// ====================================================
async function executeLiveOpen(user, trade, signalData) {
  try {
    const leverage = trade.leverage || 1;
    const sizeInContracts = trade.positionSize / trade.entryPrice;
    const size = Math.max(0.001, parseFloat(sizeInContracts.toFixed(6)));

    if (!isDryRun(user)) {
      const client = getClient(user);
      await client.setFuturesLeverage({
        symbol: getBitgetSymbol(trade.coinId),
        productType: PRODUCT_TYPE,
        marginCoin: MARGIN_COIN,
        leverage: String(Math.min(50, Math.max(1, Math.round(leverage))))
      }).catch(() => {});
    } else {
      console.log(`[Bitget][DRY-RUN] Would set leverage: ${getBitgetSymbol(trade.coinId)} ${leverage}x`);
    }

    const result = await placeOrder(user, {
      coinId: trade.coinId,
      direction: trade.direction,
      size,
      orderType: 'market'
    });

    if (result.success) {
      trade.isLive = true;
      trade.bitgetOrderId = result.orderId;
      trade.bitgetSymbol = result.symbol;
      trade.executionStatus = isDryRun(user) ? 'paper' : 'filled';
      trade.executionDetails = result.details;
      await trade.save();

      // Place native SL/TP orders on Bitget so position is protected
      try {
        const tpslResult = await placeTPSLOrders(user, trade);
        if (tpslResult.slOrderId) trade.bitgetSlOrderId = tpslResult.slOrderId;
        if (tpslResult.tpOrderId) trade.bitgetTpOrderId = tpslResult.tpOrderId;
        await trade.save();
      } catch (tpslErr) {
        console.error(`[Bitget] TPSL placement error (position still open): ${tpslErr.message}`);
      }

      if (process.env.NODE_ENV !== 'production') {
        const label = isDryRun(user) ? '[DRY-RUN] ' : '';
        console.log(`[Bitget] ${label}Live trade opened: ${trade.symbol} ${trade.direction} orderId=${result.orderId} slOrderId=${trade.bitgetSlOrderId || 'none'} tpOrderId=${trade.bitgetTpOrderId || 'none'}`);
      }
    } else {
      trade.isLive = false;
      trade.executionStatus = 'failed';
      trade.executionDetails = { error: result.error };
      await trade.save();
      console.error(`[Bitget] Live open FAILED: ${trade.symbol} - ${result.error}`);
    }
    return result;
  } catch (err) {
    console.error('[Bitget] executeLiveOpen error:', err.message);
    trade.executionStatus = 'failed';
    trade.executionDetails = { error: err.message };
    await trade.save();
    return { success: false, error: err.message };
  }
}

async function executeLiveClose(user, trade) {
  try {
    if (!trade.isLive) return { success: false, error: 'Trade is not live' };

    // Cancel any pending TPSL orders before closing (prevent double-close)
    try {
      await cancelTPSLOrders(user, trade);
    } catch (err) {
      console.warn(`[Bitget] Could not cancel TPSL before close: ${err.message}`);
    }

    const sizeInCoins = trade.positionSize / trade.entryPrice;
    const size = Math.max(0.001, parseFloat(sizeInCoins.toFixed(6)));
    const result = await closePosition(user, trade.coinId, trade.direction, size);
    if (result.success) {
      if (process.env.NODE_ENV !== 'production') {
        const label = isDryRun(user) ? '[DRY-RUN] ' : '';
        console.log(`[Bitget] ${label}Live trade closed: ${trade.symbol} ${trade.direction}`);
      }
    } else {
      console.error(`[Bitget] Live close FAILED: ${trade.symbol} - ${result.error}`);
    }
    return result;
  } catch (err) {
    console.error('[Bitget] executeLiveClose error:', err.message);
    return { success: false, error: err.message };
  }
}

async function executeLivePartialClose(user, trade, portionUSD) {
  try {
    if (!trade.isLive) return { success: false, error: 'Trade is not live' };
    const portionCoins = portionUSD / trade.entryPrice;
    const size = Math.max(0.001, parseFloat(portionCoins.toFixed(6)));
    const result = await closePosition(user, trade.coinId, trade.direction, size);
    if (result.success) {
      // After partial close, update the SL order size to match remaining position
      try {
        const remainingSize = trade.positionSize - portionUSD;
        if (remainingSize > 0 && trade.stopLoss) {
          await updateStopLoss(user, trade.coinId, trade.direction, trade.stopLoss, trade);
        }
      } catch (err) {
        console.warn(`[Bitget] Could not resize SL after partial close: ${err.message}`);
      }
      if (process.env.NODE_ENV !== 'production') {
        const label = isDryRun(user) ? '[DRY-RUN] ' : '';
        console.log(`[Bitget] ${label}Live partial close: ${trade.symbol} $${portionUSD.toFixed(2)}`);
      }
    } else {
      console.error(`[Bitget] Live partial close FAILED: ${trade.symbol} - ${result.error}`);
    }
    return result;
  } catch (err) {
    console.error('[Bitget] executeLivePartialClose error:', err.message);
    return { success: false, error: err.message };
  }
}

async function executeLiveStopUpdate(user, trade, newStopPrice) {
  return updateStopLoss(user, trade.coinId, trade.direction, newStopPrice, trade);
}

function isLiveTradingActive(user) {
  return !!(
    user.bitget?.connected &&
    user.bitget?.apiKey &&
    user.liveTrading?.enabled
  );
}

function shouldAutoOpenLive(user, score) {
  return (
    isLiveTradingActive(user) &&
    user.liveTrading?.mode === 'auto' &&
    score >= (user.liveTrading?.autoOpenMinScore || 52)
  );
}

module.exports = {
  testConnection,
  getAccountBalance,
  getOpenPositions,
  placeOrder,
  closePosition,
  closeAllPositions,
  placeTPSLOrders,
  cancelTPSLOrders,
  updateStopLoss,
  executeLiveOpen,
  executeLiveClose,
  executeLivePartialClose,
  executeLiveStopUpdate,
  isLiveTradingActive,
  shouldAutoOpenLive,
  getBitgetSymbol,
  isDryRun
};
