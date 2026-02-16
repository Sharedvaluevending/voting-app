// services/websocket-prices.js
// ====================================================
// REAL-TIME PRICES VIA WEBSOCKET (Bitget - FREE, no API key)
// Connects to Bitget public ticker stream, updates cache, broadcasts to browser clients.
// ====================================================

const WebSocket = require('ws');
const { TRACKED_COINS, COIN_META } = require('./crypto-api');

const BITGET_WS_URL = 'wss://ws.bitget.com/v2/ws/public';
const RECONNECT_DELAY_MS = 5000;
const PING_INTERVAL_MS = 20000;

const wsPriceCache = {};
let browserClients = [];

let bitgetWs = null;
let reconnectTimer = null;
let isConnected = false;

function getBitgetSymbols() {
  return TRACKED_COINS
    .map(id => COIN_META[id]?.bybit)
    .filter(Boolean);
}

const SYMBOL_TO_COIN = {};
TRACKED_COINS.forEach(id => {
  const sym = COIN_META[id]?.bybit;
  if (sym) SYMBOL_TO_COIN[sym] = id;
});

const MAX_WS_PRICE_AGE_MS = 30000;

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (bitgetWs && (bitgetWs.readyState === WebSocket.OPEN || bitgetWs.readyState === WebSocket.CONNECTING)) return;

  try {
    bitgetWs = new WebSocket(BITGET_WS_URL);

    bitgetWs.on('open', () => {
      isConnected = true;
      console.log('[WS] Bitget connected');
      const symbols = getBitgetSymbols();
      const args = symbols.map(s => ({
        instType: 'USDT-FUTURES',
        channel: 'ticker',
        instId: s
      }));
      bitgetWs.send(JSON.stringify({ op: 'subscribe', args }));
    });

    bitgetWs.on('message', (data) => {
      const raw = data.toString();
      if (raw === 'pong') return; // Bitget keepalive response
      try {
        const msg = JSON.parse(raw);
        if (msg.data && Array.isArray(msg.data)) {
          msg.data.forEach(d => {
            const symbol = d.instId || d.symbol;
            const coinId = SYMBOL_TO_COIN[symbol];
            if (!coinId) return;

            const price = parseFloat(d.lastPr || d.lastPrice);
            const change24h = parseFloat(d.change24h) ? parseFloat(d.change24h) * 100 : 0;
            const volume24h = parseFloat(d.usdtVolume || d.quoteVolume) || 0;

            if (Number.isFinite(price) && price > 0) {
              wsPriceCache[coinId] = {
                price,
                change24h: Number.isFinite(change24h) ? change24h : 0,
                volume24h,
                timestamp: Date.now()
              };
              broadcast({ type: 'price', coinId, ...wsPriceCache[coinId] });
            }
          });
        }
        if (msg.event === 'subscribe' && msg.code && msg.code !== '0') {
          console.error('[WS] Subscription failed:', msg.msg);
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    bitgetWs.on('close', () => {
      isConnected = false;
      console.log('[WS] Bitget disconnected, reconnecting in 5s...');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });

    bitgetWs.on('error', (err) => {
      console.error('[WS] Bitget error:', err.message);
    });
  } catch (err) {
    console.error('[WS] Connect error:', err.message);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  }
}

let pingInterval = null;
function startPing() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (bitgetWs && bitgetWs.readyState === WebSocket.OPEN) {
      bitgetWs.send('ping');
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
  if (Date.now() - cached.timestamp > MAX_WS_PRICE_AGE_MS) return null;
  return cached;
}

function getAllWebSocketPrices() {
  return { ...wsPriceCache };
}

function isWebSocketConnected() {
  return isConnected && bitgetWs && bitgetWs.readyState === WebSocket.OPEN;
}

function addBrowserClient(ws) {
  browserClients.push(ws);
  ws.on('close', () => {
    browserClients = browserClients.filter(c => c !== ws);
  });
}

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
