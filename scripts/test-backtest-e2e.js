#!/usr/bin/env node
/**
 * E2E test: Start server, POST backtest, poll until complete
 * Run: node scripts/test-backtest-e2e.js
 */
const http = require('http');

const PORT = 3457;
const BODY = JSON.stringify({
  coinId: 'bitcoin',
  startDate: '2025-09-01',
  endDate: '2025-09-10',
  primaryTf: '1h',
  minScore: 52,
  leverage: 2,
  initialBalance: 10000,
  riskMode: 'percent',
  riskPerTrade: 2,
  riskDollarsPerTrade: 200,
  features: { btcFilter: false, btcCorrelation: false }
});

function post() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/backtest',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(BODY) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ error: data }); }
      });
    });
    req.on('error', reject);
    req.write(BODY);
    req.end();
  });
}

function getStatus(jobId) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/api/backtest/status/${jobId}`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ error: data }); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('POST /api/backtest...');
  const init = await post();
  if (init.error) {
    console.error('POST failed:', init.error);
    process.exit(1);
  }
  const jobId = init.jobId;
  if (!jobId) {
    console.error('No jobId:', init);
    process.exit(1);
  }
  console.log('JobId:', jobId);

  const maxPolls = 40;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const status = await getStatus(jobId);
    if (status.summary) {
      console.log('SUCCESS at poll', i + 1);
      console.log('Trades:', status.summary.totalTrades);
      console.log('PnL:', status.summary.totalPnl);
      process.exit(0);
    }
    if (status.error && !status.status) {
      console.error('Error:', status.error);
      process.exit(1);
    }
    console.log('Poll', i + 1, ':', status.progress || status.status);
  }
  console.error('Timeout after', maxPolls, 'polls');
  process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
