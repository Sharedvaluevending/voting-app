#!/usr/bin/env node
/**
 * Test DeepSeek API connection.
 * Run: node scripts/test-deepseek.js
 * Requires: DEEPSEEK_API_KEY in .env (or environment)
 */
require('dotenv').config();
const { callDeepSeek } = require('../services/ollama-client');

async function main() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key || !key.trim()) {
    console.error('FAIL: DEEPSEEK_API_KEY not set in .env or environment');
    process.exit(1);
  }
  console.log('Testing DeepSeek API...');
  try {
    const text = await callDeepSeek([
      { role: 'user', content: 'Reply with exactly: OK' }
    ], { maxTokens: 10 });
    const ok = text && text.trim().toUpperCase().includes('OK');
    if (ok) {
      console.log('OK: DeepSeek connected. Response:', text.trim().slice(0, 80));
    } else {
      console.log('WARN: Got response but unexpected format:', text?.slice(0, 100) || '(empty)');
    }
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  }
}
main();
