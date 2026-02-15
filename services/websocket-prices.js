// services/websocket-prices.js
// ====================================================
// REAL-TIME PRICES VIA WEBSOCKET (Bybit - FREE, no API key)
// Connects to Bybit public spot ticker stream, updates cache, broadcasts to browser clients.
// ====================================================

const WebSocket = require('ws');
const { TRACKED_COINS, COIN_META } = require('./crypto-api'); // No circular: crypto-api doesn't require us

const BYBIT_WS_URL = 'wss://stream.bybit.com/v5/public/spot';
const RECONNECT_DELAY_MS = 5000;
const PING_INTERVAL_MS = 20000;

// Latest prices from WebSocket (coinId -> { price, change24h, volume24h, timestamp })
const wsPriceCache = {};
// Browser clients connected to our WS server
let browserClients = [];

let bybitWs = null;
let reconnectTimer = null;
let isConnected = false;

// Map coinId -> Bybit symbol for subscription
function getBybitSymbols() {
  return TRACKED_COINS
    .map(id => COIN_META[id]?.bybit)
    .filter(Boolean);
}

// Map Bybit symbol -> coinId
const SYMBOL_TO_COIN = {};
TRACKED_COINS.forEach(id => {
  const sym = COIN_META[id]?.bybit;
  if (sym) SYMBOL_TO_COIN[sym] = id;
});

const MAX_WS_PRICE_AGE_MS = 30000; // 30 seconds — reject prices older than this

function connect() {
  // Clear any pending reconnect timer to prevent double-connections
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (bybitWs && (bybitWs.readyState === WebSocket.OPEN || bybitWs.readyState === WebSocket.CONNECTING)) return;

  try {
    bybitWs = new WebSocket(BYBIT_WS_URL);

    bybitWs.on('open', () => {
      isConnected = true;
      console.log('[WS] Bybit connected');
      const symbols = getBybitSymbols();
      const args = symbols.map(s => `ticker.${s}`);
      bybitWs.send(JSON.stringify({ op: 'subscribe', args }));
    });

    bybitWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.topic && msg.topic.startsWith('ticker.') && msg.data) {
          const symbol = msg.data.symbol || msg.topic.replace('ticker.', '');
          const coinId = SYMBOL_TO_COIN[symbol];
          if (!coinId) return;

          const price = parseFloat(msg.data.lastPrice);
          const change24h = parseFloat(msg.data.price24hPcnt) * 100;
          const volume24h = parseFloat(msg.data.turnover24h) || 0;

          if (Number.isFinite(price) && price > 0) {
            wsPriceCache[coinId] = {
              price,
              change24h: Number.isFinite(change24h) ? change24h : 0,
              volume24h,
              timestamp: Date.now()
            };
            broadcast({ type: 'price', coinId, ...wsPriceCache[coinId] });
          }
        }
        // Handle subscription response
        if (msg.op === 'subscribe' && !msg.success) {
          console.error('[WS] Subscription failed:', msg.ret_msg);
        }
        if (msg.pong) {
          // Heartbeat response
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    bybitWs.on('close', () => {
      isConnected = false;
      console.log('[WS] Bybit disconnected, reconnecting in 5s...');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });

    bybitWs.on('error', (err) => {
      console.error('[WS] Bybit error:', err.message);
    });
  } catch (err) {
    console.error('[WS] Connect error:', err.message);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  }
}

// Ping to keep connection alive
let pingInterval = null;
function startPing() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (bybitWs && bybitWs.readyState === WebSocket.OPEN) {
      bybitWs.send(JSON.stringify({ op: 'ping' }));
    }
  }, PING_INTERVAL_MS);
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  browserClients = browserClients.filter(client => {
    try {
      if (client.readyState === 1) {
        client.send(msg);
        return true;
      }
    } catch (e) {}
    return false;
  });
}

function getWebSocketPrice(coinId) {
  const cached = wsPriceCache[coinId];
  if (!cached) return null;
  // Reject stale prices — prevents using old data as "live" during WS disconnects
  if (Date.now() - cached.timestamp > MAX_WS_PRICE_AGE_MS) return null;
  return cached;
}

function getAllWebSocketPrices() {
  return { ...wsPriceCache };
}

function isWebSocketConnected() {
  return isConnected && bybitWs && bybitWs.readyState === WebSocket.OPEN;
}

function addBrowserClient(ws) {
  browserClients.push(ws);
  ws.on('close', () => {
    browserClients = browserClients.filter(c => c !== ws);
  });
}

// Start connection
connect();
startPing();

module.exports = {
  connect,
  getWebSocketPrice,
  getAllWebSocketPrices,
  isWebSocketConnected,
  addBrowserClient,
  wsPriceCache
};
