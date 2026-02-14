#!/usr/bin/env node
/**
 * Test that the chart page loads and the candles API returns data.
 * Run: node scripts/test-chart-page.js
 * Requires the server to be running on PORT (default 3000).
 */
const http = require('http');

const PORT = process.env.PORT || 3000;
const BASE = `http://127.0.0.1:${PORT}`;

function fetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

async function main() {
  console.log('Testing chart page...');
  const page = await fetch(`${BASE}/chart/bitcoin`);
  if (page.status !== 200) {
    console.error('FAIL: Chart page returned', page.status);
    process.exit(1);
  }
  const hasLoadCandles = page.data.includes("loadCandles('1h')");
  const hasLightweight = page.data.includes('lightweight-charts');
  const hasLwContainer = page.data.includes('lw-chart-container');
  if (!hasLoadCandles || !hasLightweight || !hasLwContainer) {
    console.error('FAIL: Chart page missing expected content', { hasLoadCandles, hasLightweight, hasLwContainer });
    process.exit(1);
  }
  console.log('  Chart page OK');

  const api = await fetch(`${BASE}/api/candles/bitcoin?interval=1h`);
  if (api.status !== 200) {
    console.error('FAIL: Candles API returned', api.status);
    process.exit(1);
  }
  let json;
  try {
    json = JSON.parse(api.data);
  } catch (e) {
    console.error('FAIL: Candles API invalid JSON');
    process.exit(1);
  }
  if (!json.success || !json.candles || json.candles.length === 0) {
    console.error('FAIL: Candles API empty or failed', json);
    process.exit(1);
  }
  console.log('  Candles API OK (' + json.candles.length + ' candles)');
  console.log('All chart tests passed.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
