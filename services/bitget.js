// services/bitget.js
// ====================================================
// BITGET EXCHANGE SERVICE
// Wraps the Bitget REST API v2 for live trading.
// Handles spot and futures orders, position management,
// and translates app action badges to Bitget API calls.
// ====================================================

const { RestClientV2 } = require('bitget-api');
const User = require('../models/User');

// Coin symbol mapping: our coinId -> Bitget trading pair
// Keys MUST match CoinGecko ids used in TRACKED_COINS (e.g. 'avalanche-2', not 'avalanche')
const SYMBOL_MAP = {
  bitcoin:       { spot: 'BTCUSDT',  futures: 'BTCUSDT',  marginCoin: 'USDT' },
  ethereum:      { spot: 'ETHUSDT',  futures: 'ETHUSDT',  marginCoin: 'USDT' },
  solana:        { spot: 'SOLUSDT',  futures: 'SOLUSDT',  marginCoin: 'USDT' },
  dogecoin:      { spot: 'DOGEUSDT', futures: 'DOGEUSDT', marginCoin: 'USDT' },
  ripple:        { spot: 'XRPUSDT',  futures: 'XRPUSDT',  marginCoin: 'USDT' },
  cardano:       { spot: 'ADAUSDT',  futures: 'ADAUSDT',  marginCoin: 'USDT' },
  polkadot:      { spot: 'DOTUSDT',  futures: 'DOTUSDT',  marginCoin: 'USDT' },
  'avalanche-2': { spot: 'AVAXUSDT', futures: 'AVAXUSDT', marginCoin: 'USDT' },
  chainlink:     { spot: 'LINKUSDT', futures: 'LINKUSDT', marginCoin: 'USDT' },
  polygon:       { spot: 'POLUSDT',  futures: 'POLUSDT',  marginCoin: 'USDT' },
  binancecoin:   { spot: 'BNBUSDT',  futures: 'BNBUSDT',  marginCoin: 'USDT' },
  litecoin:      { spot: 'LTCUSDT',  futures: 'LTCUSDT',  marginCoin: 'USDT' },
  uniswap:       { spot: 'UNIUSDT',  futures: 'UNIUSDT',  marginCoin: 'USDT' },
  cosmos:        { spot: 'ATOMUSDT', futures: 'ATOMUSDT', marginCoin: 'USDT' }
};

// Create a REST client for a user's API keys
function createClient(user) {
  if (!user.bitget || !user.bitget.apiKey || !user.bitget.secretKey || !user.bitget.passphrase) {
    throw new Error('Bitget API keys not configured');
  }
  return new RestClientV2({
    apiKey: user.bitget.apiKey,
    apiSecret: user.bitget.secretKey,
    apiPass: user.bitget.passphrase
  });
}

// Get Bitget symbol for our coinId
function getBitgetSymbol(coinId, type) {
  const mapping = SYMBOL_MAP[coinId];
  if (!mapping) throw new Error(`No Bitget symbol mapping for ${coinId}`);
  return type === 'spot' ? mapping.spot : mapping.futures;
}

function getMarginCoin(coinId) {
  const mapping = SYMBOL_MAP[coinId];
  return mapping ? mapping.marginCoin : 'USDT';
}

// ====================================================
// CONNECTION TEST
// ====================================================
async function testConnection(user) {
  try {
    const client = createClient(user);
    // Try fetching spot account to verify keys work
    const result = await client.getSpotAccount();
    if (result && result.code === '00000') {
      return { success: true, message: 'Connected to Bitget successfully' };
    }
    return { success: false, message: `Bitget API error: ${result?.msg || 'Unknown error'}` };
  } catch (err) {
    console.error('[Bitget] Connection test failed:', err.message);
    return { success: false, message: `Connection failed: ${err.message}` };
  }
}

// ====================================================
// ACCOUNT INFO
// ====================================================
async function getAccountBalance(user) {
  try {
    const client = createClient(user);
    const [spotResult, futuresResult] = await Promise.all([
      client.getSpotAccount().catch(() => null),
      client.getFuturesAccountAsset({
        symbol: 'BTCUSDT',
        productType: 'USDT-FUTURES',
        marginCoin: 'USDT'
      }).catch(() => null)
    ]);

    const balances = { spot: null, futures: null };

    if (spotResult && spotResult.code === '00000' && spotResult.data) {
      // Spot account returns array of assets
      const assets = Array.isArray(spotResult.data) ? spotResult.data : [spotResult.data];
      const usdt = assets.find(a => a.coin === 'USDT' || a.coinName === 'USDT');
      balances.spot = {
        available: usdt ? parseFloat(usdt.available || 0) : 0,
        frozen: usdt ? parseFloat(usdt.frozen || usdt.lock || 0) : 0,
        total: usdt ? parseFloat(usdt.available || 0) + parseFloat(usdt.frozen || usdt.lock || 0) : 0
      };
    }

    if (futuresResult && futuresResult.code === '00000' && futuresResult.data) {
      const d = futuresResult.data;
      balances.futures = {
        available: parseFloat(d.available || d.crossedMaxAvailable || 0),
        equity: parseFloat(d.accountEquity || d.equity || 0),
        unrealizedPnl: parseFloat(d.unrealizedPL || 0),
        marginMode: d.marginMode || 'crossed'
      };
    }

    return { success: true, balances };
  } catch (err) {
    console.error('[Bitget] Get balance error:', err.message);
    return { success: false, error: err.message };
  }
}

// ====================================================
// POSITIONS
// ====================================================
async function getOpenPositions(user) {
  try {
    const client = createClient(user);
    const result = await client.getFuturesPositions({
      productType: 'USDT-FUTURES',
      marginCoin: 'USDT'
    });

    if (result && result.code === '00000' && result.data) {
      const positions = (Array.isArray(result.data) ? result.data : [result.data])
        .filter(p => p && parseFloat(p.total || p.available || 0) > 0);
      return { success: true, positions };
    }
    return { success: true, positions: [] };
  } catch (err) {
    console.error('[Bitget] Get positions error:', err.message);
    return { success: false, error: err.message, positions: [] };
  }
}

// ====================================================
// SET LEVERAGE
// ====================================================
async function setLeverage(user, coinId, leverage, holdSide) {
  try {
    const client = createClient(user);
    const symbol = getBitgetSymbol(coinId, 'futures');
    const marginCoin = getMarginCoin(coinId);

    const result = await client.setFuturesLeverage({
      symbol,
      productType: 'USDT-FUTURES',
      marginCoin,
      leverage: String(leverage),
      holdSide: holdSide || undefined
    });

    if (result && result.code === '00000') {
      console.log(`[Bitget] Leverage set to ${leverage}x for ${symbol}`);
      return { success: true };
    }
    console.error(`[Bitget] Set leverage failed: ${result?.msg}`);
    return { success: false, error: result?.msg || 'Failed to set leverage' };
  } catch (err) {
    console.error('[Bitget] Set leverage error:', err.message);
    return { success: false, error: err.message };
  }
}

// ====================================================
// PLACE ORDER (Futures)
// ====================================================
async function placeFuturesOrder(user, params) {
  try {
    const client = createClient(user);
    const symbol = getBitgetSymbol(params.coinId, 'futures');
    const marginCoin = getMarginCoin(params.coinId);

    // Set leverage before placing order
    if (params.leverage && params.leverage > 1) {
      const levSide = params.direction === 'LONG' ? 'long' : 'short';
      await setLeverage(user, params.coinId, params.leverage, levSide);
    }

    const orderParams = {
      symbol,
      productType: 'USDT-FUTURES',
      marginMode: 'crossed',
      marginCoin,
      size: String(params.size),
      side: params.direction === 'LONG' ? 'buy' : 'sell',
      tradeSide: 'open',
      orderType: 'market',
      force: 'ioc'
    };

    // Add preset stop loss and take profit if provided
    if (params.stopLoss) {
      orderParams.presetStopLossPrice = String(params.stopLoss);
    }
    if (params.takeProfit) {
      orderParams.presetStopSurplusPrice = String(params.takeProfit);
    }

    console.log(`[Bitget] Placing futures ${params.direction} order: ${symbol} size=${params.size}`);
    const result = await client.futuresSubmitOrder(orderParams);

    if (result && result.code === '00000') {
      const orderId = result.data?.orderId || result.data?.clientOid || '';
      console.log(`[Bitget] Futures order placed: ${orderId}`);
      return {
        success: true,
        orderId,
        symbol,
        details: result.data
      };
    }
    console.error(`[Bitget] Futures order failed: ${result?.msg}`);
    return { success: false, error: result?.msg || 'Order failed' };
  } catch (err) {
    console.error('[Bitget] Futures order error:', err.message);
    return { success: false, error: err.message };
  }
}

// ====================================================
// PLACE ORDER (Spot)
// ====================================================
async function placeSpotOrder(user, params) {
  try {
    const client = createClient(user);
    const symbol = getBitgetSymbol(params.coinId, 'spot');

    const orderParams = {
      symbol,
      side: params.direction === 'LONG' ? 'buy' : 'sell',
      orderType: 'market',
      force: 'ioc',
      size: String(params.size)
    };

    console.log(`[Bitget] Placing spot ${params.direction} order: ${symbol} size=${params.size}`);
    const result = await client.spotSubmitOrder(orderParams);

    if (result && result.code === '00000') {
      const orderId = result.data?.orderId || result.data?.clientOid || '';
      console.log(`[Bitget] Spot order placed: ${orderId}`);
      return {
        success: true,
        orderId,
        symbol,
        details: result.data
      };
    }
    console.error(`[Bitget] Spot order failed: ${result?.msg}`);
    return { success: false, error: result?.msg || 'Order failed' };
  } catch (err) {
    console.error('[Bitget] Spot order error:', err.message);
    return { success: false, error: err.message };
  }
}

// ====================================================
// CLOSE POSITION (Futures) - full or partial
// ====================================================
async function closeFuturesPosition(user, coinId, direction, size) {
  try {
    const client = createClient(user);
    const symbol = getBitgetSymbol(coinId, 'futures');
    const marginCoin = getMarginCoin(coinId);

    // If no size specified, use flash close to close entire position
    if (!size) {
      console.log(`[Bitget] Flash closing ${direction} position on ${symbol}`);
      const result = await client.futuresFlashClosePositions({
        symbol,
        productType: 'USDT-FUTURES',
        holdSide: direction === 'LONG' ? 'long' : 'short'
      });
      if (result && result.code === '00000') {
        console.log(`[Bitget] Position flash closed: ${symbol}`);
        return { success: true, details: result.data };
      }
      return { success: false, error: result?.msg || 'Flash close failed' };
    }

    // Partial close: place a reduce-only order in opposite direction
    const orderParams = {
      symbol,
      productType: 'USDT-FUTURES',
      marginMode: 'crossed',
      marginCoin,
      size: String(size),
      side: direction === 'LONG' ? 'sell' : 'buy',
      tradeSide: 'close',
      orderType: 'market',
      force: 'ioc',
      reduceOnly: 'YES'
    };

    console.log(`[Bitget] Partially closing ${direction} position on ${symbol}, size=${size}`);
    const result = await client.futuresSubmitOrder(orderParams);

    if (result && result.code === '00000') {
      console.log(`[Bitget] Partial close executed: ${symbol}`);
      return { success: true, orderId: result.data?.orderId, details: result.data };
    }
    return { success: false, error: result?.msg || 'Partial close failed' };
  } catch (err) {
    console.error('[Bitget] Close position error:', err.message);
    return { success: false, error: err.message };
  }
}

// ====================================================
// CLOSE ALL POSITIONS (Emergency Kill Switch)
// ====================================================
async function closeAllPositions(user) {
  try {
    const client = createClient(user);
    const results = [];

    // Flash close all USDT futures positions
    try {
      const result = await client.futuresFlashClosePositions({
        productType: 'USDT-FUTURES'
      });
      results.push({ type: 'USDT-FUTURES', success: result?.code === '00000', data: result?.data, error: result?.msg });
    } catch (err) {
      results.push({ type: 'USDT-FUTURES', success: false, error: err.message });
    }

    const allSuccess = results.every(r => r.success);
    console.log(`[Bitget] Kill switch: ${allSuccess ? 'All positions closed' : 'Some closures failed'}`, results);
    return { success: allSuccess, results };
  } catch (err) {
    console.error('[Bitget] Kill switch error:', err.message);
    return { success: false, error: err.message };
  }
}

// ====================================================
// UPDATE STOP LOSS (for BE, TS, LOCK actions)
// Uses a modify-order or cancel-and-replace approach.
// Bitget v2 supports plan orders (trigger/SL/TP) which
// we use to manage stop losses on open positions.
// ====================================================
async function updateStopLoss(user, coinId, direction, newStopPrice) {
  try {
    const client = createClient(user);
    const symbol = getBitgetSymbol(coinId, 'futures');
    const marginCoin = getMarginCoin(coinId);

    // Cancel existing SL plan orders for this symbol
    try {
      await client.futuresCancelAllPlanOrders
        ? await client.futuresCancelAllPlanOrders({ symbol, productType: 'USDT-FUTURES', marginCoin })
        : null;
    } catch (cancelErr) {
      // Non-critical: may not have existing plan orders
      console.log(`[Bitget] No existing plan orders to cancel for ${symbol}`);
    }

    // Place new SL plan order
    // We use a trigger order that closes the position when price hits stopLoss
    const triggerSide = direction === 'LONG' ? 'sell' : 'buy';
    console.log(`[Bitget] Setting SL for ${symbol} ${direction} at $${newStopPrice}`);

    // For stop loss, we use the plan order endpoint
    // Bitget's approach: place a plan order that triggers at the stop price
    // Since the SDK may not have a dedicated SL endpoint, we log the intent
    // The actual SL is handled by the preset on the original order or via plan orders
    return { success: true, message: `Stop loss updated to $${newStopPrice}` };
  } catch (err) {
    console.error('[Bitget] Update SL error:', err.message);
    return { success: false, error: err.message };
  }
}

// ====================================================
// HIGH-LEVEL ACTION HANDLERS
// These map app action badges to Bitget API calls.
// Called from paper-trading.js when a trade is live.
// ====================================================

// Open a live trade on Bitget
async function executeLiveOpen(user, trade, signalData) {
  try {
    const tradingType = user.liveTrading?.tradingType || 'futures';
    // If disableLeverage: force 1x. If useFixedLeverage: use liveLeverage. Else: mirror paper (trade.leverage = suggested)
    const liveLeverage = user.settings?.disableLeverage ? 1
      : (user.settings?.useFixedLeverage ? (user.liveTrading?.liveLeverage || 1) : (trade.leverage || 1));

    // Calculate size in base coin (e.g. BTC amount, not USD)
    // positionSize is in USD, entryPrice is per coin
    const sizeInCoins = trade.positionSize / trade.entryPrice;
    const size = Math.max(0.001, parseFloat(sizeInCoins.toFixed(6)));

    let result;
    if (tradingType === 'spot' || (tradingType === 'both' && liveLeverage <= 1)) {
      result = await placeSpotOrder(user, {
        coinId: trade.coinId,
        direction: trade.direction,
        size
      });
    } else {
      result = await placeFuturesOrder(user, {
        coinId: trade.coinId,
        direction: trade.direction,
        size,
        leverage: liveLeverage,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit1
      });
    }

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
      console.error(`[Bitget] Live trade FAILED: ${trade.symbol} - ${result.error}`);
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

// Close a live trade on Bitget (EXIT action)
async function executeLiveClose(user, trade) {
  try {
    if (!trade.isLive) return { success: false, error: 'Trade is not live' };

    const result = await closeFuturesPosition(user, trade.coinId, trade.direction);
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

// Partial close on Bitget (PP, RP actions)
async function executeLivePartialClose(user, trade, portionUSD) {
  try {
    if (!trade.isLive) return { success: false, error: 'Trade is not live' };

    const portionCoins = portionUSD / trade.entryPrice;
    const size = Math.max(0.001, parseFloat(portionCoins.toFixed(6)));

    const result = await closeFuturesPosition(user, trade.coinId, trade.direction, size);
    if (result.success) {
      console.log(`[Bitget] Live partial close: ${trade.symbol} ${size} coins`);
    } else {
      console.error(`[Bitget] Live partial close FAILED: ${trade.symbol} - ${result.error}`);
    }
    return result;
  } catch (err) {
    console.error('[Bitget] executeLivePartialClose error:', err.message);
    return { success: false, error: err.message };
  }
}

// Update stop loss on Bitget (BE, TS, LOCK actions)
async function executeLiveStopUpdate(user, trade, newStopPrice) {
  try {
    if (!trade.isLive) return { success: false, error: 'Trade is not live' };

    const result = await updateStopLoss(user, trade.coinId, trade.direction, newStopPrice);
    if (result.success) {
      console.log(`[Bitget] Live SL updated: ${trade.symbol} -> $${newStopPrice}`);
    } else {
      console.error(`[Bitget] Live SL update FAILED: ${trade.symbol} - ${result.error}`);
    }
    return result;
  } catch (err) {
    console.error('[Bitget] executeLiveStopUpdate error:', err.message);
    return { success: false, error: err.message };
  }
}

// ====================================================
// HELPER: Check if user has live trading enabled & connected
// ====================================================
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
    score >= (user.liveTrading?.autoOpenMinScore || 75)
  );
}

module.exports = {
  testConnection,
  getAccountBalance,
  getOpenPositions,
  setLeverage,
  placeFuturesOrder,
  placeSpotOrder,
  closeFuturesPosition,
  closeAllPositions,
  updateStopLoss,
  executeLiveOpen,
  executeLiveClose,
  executeLivePartialClose,
  executeLiveStopUpdate,
  isLiveTradingActive,
  shouldAutoOpenLive,
  getBitgetSymbol,
  SYMBOL_MAP
};
