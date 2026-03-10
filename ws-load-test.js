const WebSocket = require('ws');

const TARGET = process.env.WS_TARGET || 'wss://alphaconfluence.com/ws/voice';
const CONCURRENCY = Number(process.env.WS_CONCURRENCY || 100);
const HOLD_MS = Number(process.env.WS_HOLD_MS || 30000);

const connections = [];
let opened = 0;
let failed = 0;

console.log(`Opening ${CONCURRENCY} websocket connections to ${TARGET}`);

for (let i = 0; i < CONCURRENCY; i += 1) {
  const ws = new WebSocket(TARGET);
  ws.on('open', () => {
    opened += 1;
    connections.push(ws);
    console.log(`Connection ${i + 1} established (${opened}/${CONCURRENCY})`);
  });
  ws.on('error', (err) => {
    failed += 1;
    console.log(`Connection ${i + 1} failed: ${err.message}`);
  });
}

setTimeout(() => {
  for (const ws of connections) {
    try {
      ws.close();
    } catch (_) {
      // Ignore close errors during teardown.
    }
  }
  console.log('--- WS LOAD TEST SUMMARY ---');
  console.log('Target:', TARGET);
  console.log('Requested:', CONCURRENCY);
  console.log('Opened:', opened);
  console.log('Failed:', failed);
  console.log('Hold time ms:', HOLD_MS);
  console.log('----------------------------');
  process.exit(0);
}, HOLD_MS);
