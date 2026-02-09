#!/usr/bin/env node
// scripts/test-apis.js
// Tests all external APIs used by the app. Run: node scripts/test-apis.js

const fetch = require('node-fetch');

const TRACKED_COINS = [
  'bitcoin', 'ethereum', 'solana', 'dogecoin', 'ripple', 'cardano',
  'polkadot', 'avalanche-2', 'chainlink', 'polygon'
];

const COIN_META = {
  bitcoin:       { symbol: 'BTC',   binance: 'BTCUSDT' },
  ethereum:      { symbol: 'ETH',   binance: 'ETHUSDT' },
  solana:        { symbol: 'SOL',   binance: 'SOLUSDT' },
  dogecoin:      { symbol: 'DOGE',  binance: 'DOGEUSDT' },
  ripple:        { symbol: 'XRP',   binance: 'XRPUSDT' },
  cardano:       { symbol: 'ADA',   binance: 'ADAUSDT' },
  polkadot:      { symbol: 'DOT',   binance: 'DOTUSDT' },
  'avalanche-2': { symbol: 'AVAX',  binance: 'AVAXUSDT' },
  chainlink:     { symbol: 'LINK',  binance: 'LINKUSDT' },
  polygon:       { symbol: 'MATIC', binance: 'MATICUSDT' }
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

  // --- CoinCap ---
  const r3 = await test('CoinCap assets (limit=200)', async () => {
    const res = await fetch('https://api.coincap.io/v2/assets?limit=200', { headers: { 'Accept': 'application/json' }, timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const list = json.data || json;
    if (!Array.isArray(list)) throw new Error('No data array');
    return `${list.length} assets`;
  });
  if (r3.ok) passed++; else failed++;

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

  // --- Binance: 24hr ticker (one symbol) ---
  const r5 = await test('Binance 24hr ticker (BTCUSDT)', async () => {
    const res = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', { headers: { 'Accept': 'application/json' }, timeout: 10000 });
    if (res.status === 451) throw new Error('451 Unavailable in region');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const price = parseFloat(data.lastPrice);
    if (isNaN(price)) throw new Error('Invalid lastPrice');
    return `$${price.toLocaleString()}`;
  });
  if (r5.ok) passed++; else failed++;

  // --- Binance: Klines (candles) ---
  const r6 = await test('Binance klines (BTCUSDT 1h, limit=5)', async () => {
    const res = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=5', { headers: { 'Accept': 'application/json' }, timeout: 15000 });
    if (res.status === 451) throw new Error('451 Unavailable in region');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error('No candles');
    const first = data[0];
    if (first.length < 5) throw new Error('Invalid candle format');
    return `${data.length} candles`;
  });
  if (r6.ok) passed++; else failed++;

  // --- Binance: 15m and 1w (same as app) ---
  const r7 = await test('Binance klines 15m + 1w (BTCUSDT)', async () => {
    const [r15, r1w] = await Promise.all([
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=10', { headers: { 'Accept': 'application/json' }, timeout: 10000 }),
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=5', { headers: { 'Accept': 'application/json' }, timeout: 10000 })
    ]);
    if (r15.status === 451 || r1w.status === 451) throw new Error('451 Unavailable in region');
    if (!r15.ok) throw new Error('15m HTTP ' + r15.status);
    if (!r1w.ok) throw new Error('1w HTTP ' + r1w.status);
    const d15 = await r15.json();
    const d1w = await r1w.json();
    if (!Array.isArray(d15) || d15.length === 0) throw new Error('No 15m candles');
    if (!Array.isArray(d1w) || d1w.length === 0) throw new Error('No 1w candles');
    return '15m + 1w OK';
  });
  if (r7.ok) passed++; else failed++;

  console.log('\n--- Summary ---');
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nNotes:');
    console.log('  - CoinGecko 429 = rate limit; app falls back to CoinCap/Kraken/Binance.');
    console.log('  - CoinCap ENOTFOUND = DNS/network (e.g. Render, some VPNs); app uses Kraken/Binance.');
    console.log('  - Binance 451 = region restricted; app uses CoinGecko history + other price APIs.');
    process.exit(1);
  }
  console.log('\nAll APIs responded correctly.\n');
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
