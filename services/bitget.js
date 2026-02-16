// services/bitget.js
// ====================================================
// BITGET LIVE EXECUTION
// Wraps Bitget V2 REST API for live futures trading.
// Uses apiKey + secretKey + passphrase authentication.
// ====================================================

const { RestClientV2 } = require('bitget-api');
const { COIN_META } = require('./crypto-api');

const PRODUCT_TYPE = 'USDT-FUTURES';
const MARGIN_COIN = 'USDT';
const MARGIN_MODE = 'crossed';

function getBitgetSymbol(coinId) {
  const meta = COIN_META[coinId];
  if (!meta || !meta.bybit) throw new Error(`No Bitget symbol for ${coinId}`);
  return meta.bybit; // BTCUSDT, ETHUSDT, etc. - same format as Bybit
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

  try {
    const client = getClient(user);
    const result = await client.futuresSubmitOrder(orderParams);
    const orderId = result?.data?.orderId || result?.orderId || '';
    console.log(`[Bitget] Order placed: ${symbol} ${side} orderId=${orderId}`);
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
  const symbol = getBitgetSymbol(coinId);
  const reduceOnly = true;
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
// UPDATE STOP LOSS (modify position SL)
// ====================================================
async function updateStopLoss(user, coinId, direction, newStopPrice) {
  console.log(`[Bitget] updateStopLoss: ${coinId} newStop=${newStopPrice} - use placeTpslOrder or modify position`);
  return { success: true, message: 'SL update logged (Bitget TPSL requires separate order)' };
}

// ====================================================
// HIGH-LEVEL ACTION HANDLERS
// ====================================================
async function executeLiveOpen(user, trade, signalData) {
  try {
    const leverage = trade.leverage || 1;
    const margin = trade.margin || (trade.positionSize / leverage);
    const sizeInContracts = trade.positionSize / trade.entryPrice;
    const size = Math.max(0.001, parseFloat(sizeInContracts.toFixed(6)));

    const client = getClient(user);
    await client.setFuturesLeverage({
      symbol: getBitgetSymbol(trade.coinId),
      productType: PRODUCT_TYPE,
      marginCoin: MARGIN_COIN,
      leverage: String(Math.min(50, Math.max(1, Math.round(leverage))))
    }).catch(() => {});

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
      trade.executionStatus = 'filled';
      trade.executionDetails = result.details;
      await trade.save();
      console.log(`[Bitget] Live trade opened: ${trade.symbol} ${trade.direction} orderId=${result.orderId}`);
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
    const sizeInCoins = trade.positionSize / trade.entryPrice;
    const size = Math.max(0.001, parseFloat(sizeInCoins.toFixed(6)));
    const result = await closePosition(user, trade.coinId, trade.direction, size);
    if (result.success) {
      console.log(`[Bitget] Live trade closed: ${trade.symbol} ${trade.direction}`);
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
      console.log(`[Bitget] Live partial close: ${trade.symbol} $${portionUSD.toFixed(2)}`);
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
  return updateStopLoss(user, trade.coinId, trade.direction, newStopPrice);
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
  updateStopLoss,
  executeLiveOpen,
  executeLiveClose,
  executeLivePartialClose,
  executeLiveStopUpdate,
  isLiveTradingActive,
  shouldAutoOpenLive,
  getBitgetSymbol
};
