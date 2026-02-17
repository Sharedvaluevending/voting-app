#!/usr/bin/env node
/**
 * Test chart candles API - verifies the /api/candles endpoint returns valid data for Lightweight Charts
 */
const http = require('http');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function run() {
  console.log('=== Chart Candles API Test ===\n');
  let passed = 0;
  let failed = 0;

  // 1. Bitcoin 1h
  try {
    const r = await fetch(`${BASE}/api/candles/bitcoin?interval=1h`);
    if (r.status !== 200) {
      console.log('FAIL  /api/candles/bitcoin?interval=1h  status', r.status);
      failed++;
    } else if (!r.data.success || !r.data.candles || r.data.candles.length < 20) {
      console.log('FAIL  /api/candles/bitcoin?interval=1h  no candles or too few:', r.data.candles?.length || 0);
      failed++;
    } else {
      const c = r.data.candles;
      const asc = c[0].time < c[c.length - 1].time;
      if (!asc) {
        console.log('FAIL  /api/candles/bitcoin?interval=1h  candles not ascending');
        failed++;
      } else {
        console.log('OK    /api/candles/bitcoin?interval=1h  ' + c.length + ' candles, ascending');
        passed++;
      }
    }
  } catch (e) {
    console.log('FAIL  /api/candles/bitcoin?interval=1h  ' + e.message);
    failed++;
  }

  // 2. Ethereum 4h
  try {
    const r = await fetch(`${BASE}/api/candles/ethereum?interval=4h`);
    if (r.status !== 200 || !r.data.success || !r.data.candles || r.data.candles.length < 5) {
      console.log('FAIL  /api/candles/ethereum?interval=4h  ' + (r.data?.candles?.length || 0) + ' candles');
      failed++;
    } else {
      const c = r.data.candles;
      const asc = c[0].time < c[c.length - 1].time;
      console.log(asc ? 'OK    /api/candles/ethereum?interval=4h  ' + c.length + ' candles' : 'FAIL  candles not ascending');
      passed += asc ? 1 : 0;
      failed += asc ? 0 : 1;
    }
  } catch (e) {
    console.log('FAIL  /api/candles/ethereum?interval=4h  ' + e.message);
    failed++;
  }

  // 3. Invalid coin
  try {
    const r = await fetch(`${BASE}/api/candles/invalidcoin?interval=1h`);
    if (r.status === 404) {
      console.log('OK    /api/candles/invalidcoin  404 as expected');
      passed++;
    } else {
      console.log('FAIL  /api/candles/invalidcoin  expected 404, got', r.status);
      failed++;
    }
  } catch (e) {
    console.log('FAIL  /api/candles/invalidcoin  ' + e.message);
    failed++;
  }

  console.log('\n--- Summary ---');
  console.log('  Passed:', passed, '  Failed:', failed);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
