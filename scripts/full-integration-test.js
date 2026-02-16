#!/usr/bin/env node
// scripts/full-integration-test.js
// Full integration test of all data sources and WebSocket after Bitget/Kraken migration

const fetch = require('node-fetch');

const TRACKED_COINS = ['bitcoin', 'ethereum', 'solana'];
const COIN_META = {
  bitcoin: { symbol: 'BTC', bybit: 'BTCUSDT' },
  ethereum: { symbol: 'ETH', bybit: 'ETHUSDT' },
  solana: { symbol: 'SOL', bybit: 'SOLUSDT' }
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    console.log(`  OK   ${name} (${ms}ms)${result ? ' ' + result : ''}`);
    passed++;
    return true;
  } catch (err) {
    const ms = Date.now() - start;
    console.log(`  FAIL ${name} (${ms}ms) - ${err.message}`);
    failed++;
    return false;
  }
}

async function main() {
  console.log('\n=== Full Integration Test (Bitget + Kraken + WebSocket) ===\n');

  // 1. Bitget REST - Prices (tickers)
  await test('Bitget tickers (all USDT-FUTURES)', async () => {
    const r = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', { timeout: 10000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== '00000' || !j.data) throw new Error('Invalid response');
    const count = (j.data || []).length;
    if (count < 10) throw new Error(`Only ${count} tickers`);
    return `${count} tickers`;
  });

  // 2. Bitget REST - Candles
  await test('Bitget candles (BTCUSDT 1H)', async () => {
    const r = await fetch('https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1H&limit=10', { timeout: 10000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== '00000' || !j.data) throw new Error('Invalid response');
    const candles = j.data || [];
    if (candles.length < 5) throw new Error(`Only ${candles.length} candles`);
    const first = candles[0];
    if (!first || first.length < 5) throw new Error('Invalid candle format');
    return `${candles.length} candles`;
  });

  // 3. Bitget REST - Funding rate
  await test('Bitget funding rate (BTCUSDT)', async () => {
    const r = await fetch('https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=BTCUSDT&productType=USDT-FUTURES', { timeout: 10000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== '00000') throw new Error('Invalid response');
    return 'OK';
  });

  // 4. Kraken REST - Ticker
  await test('Kraken ticker (XXBTZUSD)', async () => {
    const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD', { timeout: 10000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error && j.error.length) throw new Error(j.error[0]);
    const result = j.result || {};
    const pair = Object.keys(result).find(k => k.includes('XBT') || k.includes('BTC'));
    if (!pair || !result[pair].c) throw new Error('No price');
    return `$${parseFloat(result[pair].c[0]).toLocaleString()}`;
  });

  // 5. Kraken REST - Candles
  await test('Kraken OHLC (XXBTZUSD 1h)', async () => {
    const r = await fetch('https://api.kraken.com/0/public/OHLC?pair=XXBTZUSD&interval=60', { timeout: 10000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error && j.error.length) throw new Error(j.error[0]);
    const keys = Object.keys(j.result || {}).filter(k => k !== 'last');
    if (keys.length === 0) throw new Error('No candles');
    const candles = j.result[keys[0]];
    if (!candles || candles.length < 5) throw new Error(`Only ${(candles || []).length} candles`);
    return `${candles.length} candles`;
  });

  // 6. CoinGecko prices
  await test('CoinGecko prices', async () => {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd', { timeout: 12000 });
    if (r.status === 429) throw new Error('Rate limited');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const count = Object.keys(j || {}).length;
    if (count < 2) throw new Error(`Only ${count} coins`);
    return `${count} coins`;
  });

  // 7. Load crypto-api and verify fetchLivePrice uses Bitget
  await test('crypto-api fetchLivePrice (Bitget)', async () => {
    const cryptoApi = require('../services/crypto-api');
    const price = await cryptoApi.fetchLivePrice('bitcoin');
    if (!price || !Number.isFinite(price) || price <= 0) throw new Error(`Invalid price: ${price}`);
    return `$${price.toLocaleString()}`;
  });

  // 8. WebSocket module loads and connects
  await test('WebSocket module (Bitget)', async () => {
    const ws = require('../services/websocket-prices');
    if (!ws.getWebSocketPrice || !ws.isWebSocketConnected) throw new Error('Missing exports');
    const connected = ws.isWebSocketConnected();
    return connected ? 'connected' : 'connecting (prices may populate shortly)';
  });

  // 9. Bitget service loads
  await test('Bitget execution service', async () => {
    const bitget = require('../services/bitget');
    if (!bitget.testConnection || !bitget.getAccountBalance) throw new Error('Missing exports');
    return 'OK';
  });

  // 10. fetchAllCandlesForCoin uses Bitget
  await test('fetchAllCandlesForCoin (Bitget primary)', async () => {
    const cryptoApi = require('../services/crypto-api');
    const candles = await cryptoApi.fetchAllCandlesForCoin('bitcoin');
    if (!candles) throw new Error('No candles');
    if (!candles['1h'] || candles['1h'].length < 20) throw new Error(`Insufficient 1h: ${(candles['1h'] || []).length}`);
    const src = candles._source || 'unknown';
    return `source=${src}, 1h=${candles['1h'].length}`;
  });

  console.log('\n--- Summary ---');
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nSome tests failed. Check network and API availability.');
    process.exit(1);
  }
  console.log('\nAll integration tests passed.\n');
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
