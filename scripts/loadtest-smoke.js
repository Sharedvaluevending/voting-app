#!/usr/bin/env node
/**
 * Lightweight HTTP load tester (no external deps).
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 CONCURRENCY=200 DURATION_SEC=60 PATHS=/api/health node scripts/loadtest-smoke.js
 *   BASE_URL=https://example.com CONCURRENCY=500 DURATION_SEC=120 PATHS=/api/health,/ node scripts/loadtest-smoke.js
 */
const http = require('http');
const https = require('https');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3000';
const concurrency = Math.max(1, Number(process.env.CONCURRENCY || 100));
const durationSec = Math.max(10, Number(process.env.DURATION_SEC || 60));
const timeoutMs = Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS || 8000));
const method = (process.env.METHOD || 'GET').toUpperCase();
const paths = String(process.env.PATHS || '/api/health')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (paths.length === 0) {
  console.error('No PATHS provided');
  process.exit(1);
}

const base = new URL(baseUrl);
const client = base.protocol === 'https:' ? https : http;
const stopAt = Date.now() + (durationSec * 1000);

const latencies = [];
let sent = 0;
let ok = 0;
let failed = 0;
let timeouts = 0;
let inFlight = 0;
let p95Checkpoint = Date.now();

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function nextPath(i) {
  return paths[i % paths.length];
}

function printCheckpoint() {
  const now = Date.now();
  if (now - p95Checkpoint < 5000) return;
  p95Checkpoint = now;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const elapsedSec = Math.max(1, Math.round((now - (stopAt - durationSec * 1000)) / 1000));
  const rps = Math.round(sent / elapsedSec);
  console.log(`[loadtest] sent=${sent} ok=${ok} fail=${failed} inflight=${inFlight} rps~${rps} p95=${p95}ms`);
}

function requestOnce(workerId, seq) {
  if (Date.now() >= stopAt) return Promise.resolve();

  const path = nextPath(workerId + seq);
  const started = Date.now();
  sent += 1;
  inFlight += 1;
  let settled = false;

  function settle(outcome, elapsed) {
    if (settled) return;
    settled = true;
    if (typeof elapsed === 'number') latencies.push(elapsed);
    if (outcome === 'ok') ok += 1;
    else if (outcome === 'timeout') {
      timeouts += 1;
      failed += 1;
    } else {
      failed += 1;
    }
    inFlight -= 1;
    printCheckpoint();
  }

  return new Promise((resolve) => {
    const req = client.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      path,
      method,
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        Connection: 'keep-alive'
      }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        const elapsed = Date.now() - started;
        if (res.statusCode >= 200 && res.statusCode < 500) settle('ok', elapsed);
        else settle('error', elapsed);
        resolve();
      });
    });

    req.on('timeout', () => {
      settle('timeout', Date.now() - started);
      req.destroy(new Error('timeout'));
      resolve();
    });

    req.on('error', () => {
      settle('error', Date.now() - started);
      resolve();
    });

    req.end();
  }).then(() => requestOnce(workerId, seq + 1));
}

async function main() {
  console.log(`[loadtest] target=${baseUrl} concurrency=${concurrency} duration=${durationSec}s paths=${paths.join(',')}`);
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(requestOnce(i, 0));
  await Promise.all(workers);

  const sorted = [...latencies].sort((a, b) => a - b);
  const elapsedSec = Math.max(1, durationSec);
  const rps = Number((sent / elapsedSec).toFixed(1));
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const successRate = sent > 0 ? Number(((ok / sent) * 100).toFixed(2)) : 0;

  console.log('\n=== Load Test Summary ===');
  console.log(`sent: ${sent}`);
  console.log(`ok: ${ok}`);
  console.log(`failed: ${failed}`);
  console.log(`timeouts: ${timeouts}`);
  console.log(`successRate: ${successRate}%`);
  console.log(`rps: ${rps}`);
  console.log(`p50: ${p50}ms`);
  console.log(`p95: ${p95}ms`);
  console.log(`p99: ${p99}ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
