#!/usr/bin/env node
/**
 * Runs load test and captures /api/ops/metrics snapshots in parallel.
 *
 * Usage:
 * BASE_URL=http://127.0.0.1:3000 CONCURRENCY=500 DURATION_SEC=120 PATHS=/api/health,/ node scripts/loadtest-with-metrics.js
 * Optional:
 * OPS_METRICS_PATH=/api/ops/metrics OPS_KEY=your-key METRICS_INTERVAL_MS=5000
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3000';
const metricsPath = process.env.OPS_METRICS_PATH || '/api/ops/metrics';
const metricsIntervalMs = Math.max(1000, Number(process.env.METRICS_INTERVAL_MS || 5000));
const opsKey = process.env.OPS_KEY || process.env.OPS_METRICS_KEY || '';

const base = new URL(baseUrl);
const client = base.protocol === 'https:' ? https : http;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchMetricsOnce() {
  return new Promise((resolve) => {
    const req = client.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: metricsPath,
      timeout: 6000,
      headers: {
        Accept: 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ok: false, status: res.statusCode, body: body.slice(0, 200) });
        }
        try {
          const json = JSON.parse(body);
          resolve({ ok: true, status: res.statusCode, json });
        } catch (err) {
          resolve({ ok: false, status: res.statusCode, body: 'Invalid JSON from metrics endpoint' });
        }
      });
    });
    if (opsKey) req.setHeader('x-ops-key', opsKey);
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, body: err.message || 'request error' }));
    req.end();
  });
}

async function main() {
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'data', 'loadtest-results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `loadtest-metrics-${runStamp}.json`);

  const env = { ...process.env };
  const child = spawn(process.execPath, [path.join(__dirname, 'loadtest-smoke.js')], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const snapshots = [];
  let loadtestStdout = '';
  let loadtestStderr = '';
  let active = true;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    loadtestStdout += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    loadtestStderr += text;
    process.stderr.write(text);
  });

  const poller = (async () => {
    while (active) {
      const at = new Date().toISOString();
      const snapshot = await fetchMetricsOnce();
      snapshots.push({ at, ...snapshot });
      if (snapshot.ok && snapshot.json) {
        const httpP95 = snapshot.json?.http?.p95 ?? 'n/a';
        const dbP95 = snapshot.json?.db?.p95 ?? 'n/a';
        console.log(`[metrics] ${at} http.p95=${httpP95}ms db.p95=${dbP95}ms`);
      } else {
        console.log(`[metrics] ${at} unavailable status=${snapshot.status} reason=${snapshot.body || 'unknown'}`);
      }
      await wait(metricsIntervalMs);
    }
  })();

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  active = false;
  await poller;
  const finalSnapshot = await fetchMetricsOnce();

  const payload = {
    runAt: new Date().toISOString(),
    config: {
      baseUrl,
      metricsPath,
      metricsIntervalMs,
      hasOpsKey: Boolean(opsKey),
      concurrency: Number(process.env.CONCURRENCY || 100),
      durationSec: Number(process.env.DURATION_SEC || 60),
      paths: process.env.PATHS || '/api/health'
    },
    loadtestExitCode: exitCode,
    loadtestStdout,
    loadtestStderr,
    snapshots,
    finalSnapshot
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`\n[metrics] saved ${outFile}`);
  if (exitCode !== 0) process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
