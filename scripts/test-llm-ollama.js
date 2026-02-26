#!/usr/bin/env node
// scripts/test-llm-ollama.js
// Tests LLM/Ollama connectivity and agent tools. Run: node scripts/test-llm-ollama.js
// Set OLLAMA_URL env var to test against ngrok or custom URL (default: http://localhost:11434)

require('dotenv').config();

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

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
  console.log('\n=== LLM/Ollama connectivity & agent test ===\n');
  console.log(`  URL: ${OLLAMA_URL}\n`);

  let passed = 0;
  let failed = 0;

  // 1. Ollama reachable (/api/tags)
  const r1 = await test('Ollama reachable (GET /api/tags)', async () => {
    const { checkOllamaReachable } = require('../services/ollama-client');
    const result = await checkOllamaReachable(OLLAMA_URL);
    if (!result.ok) throw new Error(result.error || 'Ollama not reachable');
    return 'connected';
  });
  if (r1.ok) passed++; else failed++;

  if (!r1.ok) {
    console.log('\n  Ollama not reachable - skipping approveTrade test.');
    console.log('  Run: ollama run qwen3-coder:480b-cloud  (or set OLLAMA_URL for ngrok)\n');
  } else {
    // 2. approveTrade (POST /api/chat or /api/generate)
  const r2 = await test('approveTrade (chat/generate)', async () => {
    const { approveTrade } = require('../services/ollama-client');
    const result = await approveTrade({
      coinId: 'bitcoin',
      symbol: 'BTC',
      direction: 'LONG',
      score: 72,
      strategy: 'Trend Following',
      regime: 'trending',
      riskReward: 1.8
    }, OLLAMA_URL, 'qwen3-coder:480b-cloud');
    return typeof result === 'boolean' ? (result ? 'approved' : 'rejected') : 'error';
  });
  if (r2.ok) passed++; else failed++;
  }

  // 3. llm-agent module loads
  const r3 = await test('llm-agent module loads', async () => {
    const { runAgent, SETTING_BOUNDS, BOOLEAN_SETTINGS } = require('../services/llm-agent');
    if (typeof runAgent !== 'function') throw new Error('runAgent not a function');
    if (!SETTING_BOUNDS || !SETTING_BOUNDS.riskPerTrade) throw new Error('SETTING_BOUNDS missing');
    if (!BOOLEAN_SETTINGS || !BOOLEAN_SETTINGS.includes('autoTrade')) throw new Error('BOOLEAN_SETTINGS missing');
    return 'ok';
  });
  if (r3.ok) passed++; else failed++;

  // 4. closeTradePartial exported
  const r4 = await test('closeTradePartial exported from paper-trading', async () => {
    const { closeTrade, closeTradePartial } = require('../services/paper-trading');
    if (typeof closeTrade !== 'function') throw new Error('closeTrade missing');
    if (typeof closeTradePartial !== 'function') throw new Error('closeTradePartial missing');
    return 'ok';
  });
  if (r4.ok) passed++; else failed++;

  console.log(`\n  Result: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
