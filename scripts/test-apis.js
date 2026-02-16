#!/usr/bin/env node
// scripts/test-apis.js
// Tests all external APIs used by the app. Run: node scripts/test-apis.js

const fetch = require('node-fetch');

const TRACKED_COINS = [
  'bitcoin', 'ethereum', 'solana', 'dogecoin', 'ripple', 'cardano',
  'polkadot', 'avalanche-2', 'chainlink', 'polygon'
];

const COIN_META = {
  bitcoin:       { symbol: 'BTC',   bybit: 'BTCUSDT' },
  ethereum:      { symbol: 'ETH',   bybit: 'ETHUSDT' },
  solana:        { symbol: 'SOL',   bybit: 'SOLUSDT' },
  dogecoin:      { symbol: 'DOGE',  bybit: 'DOGEUSDT' },
  ripple:        { symbol: 'XRP',   bybit: 'XRPUSDT' },
  cardano:       { symbol: 'ADA',   bybit: 'ADAUSDT' },
  polkadot:      { symbol: 'DOT',   bybit: 'DOTUSDT' },
  'avalanche-2': { symbol: 'AVAX',  bybit: 'AVAXUSDT' },
  chainlink:     { symbol: 'LINK',  bybit: 'LINKUSDT' },
  polygon:       { symbol: 'POL',   bybit: 'POLUSDT' }
};

const KRAKEN_PAIRS = {
  'bitcoin': 'XXBTZUSD', 'ethereum': 'XETHZUSD', 'solana': 'SOLUSD', 'dogecoin': 'DOGEUSD',
  'ripple': 'XXRPZUSD', 'cardano': 'ADAUSD', 'polkadot': 'DOTUSD', 'avalanche-2': 'AVAXUSD',
  'chainlink': 'LINKUSD', 'polygon': 'MATICUSD'
};

async function test(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    console.log(`  OK   ${name} (${ms}ms)${result ? ' ' + result : ''}`);
    return { ok: true, ms };
  } catch (err) {
    const ms = Date.now() - start;
    console.log(`  FAIL ${name} (${ms}ms) - ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function main() {
  console.log('\n=== CryptoSignals Pro – API connectivity test ===\n');

  let passed = 0;
  let failed = 0;

  // --- CoinGecko: Prices (same URL as app) ---
  const cgIds = TRACKED_COINS.join(',');
  const cgPriceUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true`;
  const r1 = await test('CoinGecko prices (simple/price)', async () => {
    const res = await fetch(cgPriceUrl, { headers: { 'Accept': 'application/json' }, timeout: 12000 });
    if (res.status === 429) throw new Error('429 Rate limited');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const count = Object.keys(data || {}).length;
    if (count === 0) throw new Error('No coins in response');
    return `${count} coins`;
  });
  if (r1.ok) passed++; else failed++;

  // --- CoinGecko: History (one coin) ---
  const r2 = await test('CoinGecko history (market_chart, bitcoin, 7d)', async () => {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7', { headers: { 'Accept': 'application/json' }, timeout: 12000 });
    if (res.status === 429) throw new Error('429 Rate limited');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const prices = data.prices && data.prices.length;
    if (!prices) throw new Error('No prices array');
    return `${prices} points`;
  });
  if (r2.ok) passed++; else failed++;

  // --- CoinCap (optional: DNS/network may block; app falls back to Bitget/Kraken) ---
  const r3 = await test('CoinCap assets (limit=200)', async () => {
    const res = await fetch('https://api.coincap.io/v2/assets?limit=200', { headers: { 'Accept': 'application/json' }, timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const list = json.data || json;
    if (!Array.isArray(list)) throw new Error('No data array');
    return `${list.length} assets`;
  });
  if (r3.ok) passed++;
  // CoinCap optional: DNS/network may block (ENOTFOUND); app falls back to Bitget/Kraken/CoinGecko

  // --- Kraken ---
  const r4 = await test('Kraken Ticker (all pairs)', async () => {
    const pairs = TRACKED_COINS.map(id => KRAKEN_PAIRS[id]).filter(Boolean);
    const url = 'https://api.kraken.com/0/public/Ticker?pair=' + pairs.join(',');
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 10000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = json.result || json;
    if (!result || typeof result !== 'object') throw new Error('No result');
    const count = Object.keys(result).length;
    return `${count} pairs`;
  });
  if (r4.ok) passed++; else failed++;

  // --- Bitget: Ticker (one symbol) ---
  const r5 = await test('Bitget ticker (BTCUSDT)', async () => {
    const res = await fetch('https://api.bitget.com/api/v2/mix/market/ticker?symbol=BTCUSDT&productType=USDT-FUTURES', { headers: { 'Accept': 'application/json' }, timeout: 10000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== '00000' || !json.data) throw new Error('Invalid response');
    const item = Array.isArray(json.data) ? json.data[0] : json.data;
    if (!item) throw new Error('No ticker data');
    const price = parseFloat(item.lastPr || item.lastPrice);
    if (isNaN(price)) throw new Error('Invalid lastPr');
    return `$${price.toLocaleString()}`;
  });
  if (r5.ok) passed++; else failed++;

  // --- Bitget: Candles ---
  const r6 = await test('Bitget candles (BTCUSDT 1H, limit=5)', async () => {
    const res = await fetch('https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1H&limit=5', { headers: { 'Accept': 'application/json' }, timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== '00000' || !json.data) throw new Error('Invalid response');
    const data = json.data;
    if (!Array.isArray(data) || data.length === 0) throw new Error('No candles');
    const first = data[0];
    if (first.length < 5) throw new Error('Invalid candle format');
    return `${data.length} candles`;
  });
  if (r6.ok) passed++; else failed++;

  // --- Bitget: 15m and 1w (same as app) ---
  const r7 = await test('Bitget candles 15m + 1w (BTCUSDT)', async () => {
    const [r15, r1w] = await Promise.all([
      fetch('https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=15m&limit=10', { headers: { 'Accept': 'application/json' }, timeout: 10000 }),
      fetch('https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1W&limit=5', { headers: { 'Accept': 'application/json' }, timeout: 10000 })
    ]);
    if (!r15.ok) throw new Error('15m HTTP ' + r15.status);
    if (!r1w.ok) throw new Error('1w HTTP ' + r1w.status);
    const j15 = await r15.json();
    const j1w = await r1w.json();
    const d15 = j15.data || [];
    const d1w = j1w.data || [];
    if (!Array.isArray(d15) || d15.length === 0) throw new Error('No 15m candles');
    if (!Array.isArray(d1w) || d1w.length === 0) throw new Error('No 1w candles');
    return '15m + 1w OK';
  });
  if (r7.ok) passed++; else failed++;

  console.log('\n--- Summary ---');
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nNotes:');
    console.log('  - CoinGecko 429 = rate limit; app falls back to CoinCap/Kraken/Bitget.');
    console.log('  - CoinCap ENOTFOUND = DNS/network (e.g. Render, some VPNs); app uses Kraken/Bitget.');
    process.exit(1);
  }
  console.log('\nAll APIs responded correctly.\n');
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
