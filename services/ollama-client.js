/**
 * Ollama client for LLM-based trade approval.
 * Calls local Ollama API (http://localhost:11434 by default).
 * Used when user enables "Use LLM" in auto-trade settings.
 */

const fetch = require('node-fetch');

const DEFAULT_URL = 'http://localhost:11434';
const TIMEOUT_MS = 15000;

function isNgrokUrl(url) {
  return url && (url.includes('ngrok-free') || url.includes('ngrok.io'));
}

function getHeaders(baseUrl) {
  const h = { 'Content-Type': 'application/json' };
  if (isNgrokUrl(baseUrl)) h['ngrok-skip-browser-warning'] = 'true';
  return h;
}

/**
 * Ask Ollama whether to approve opening a trade.
 * @param {Object} ctx - Trade context
 * @param {string} ctx.coinId - e.g. 'bitcoin'
 * @param {string} ctx.symbol - e.g. 'BTC'
 * @param {string} ctx.direction - 'LONG' | 'SHORT'
 * @param {number} ctx.score - Signal score 0-100
 * @param {string} ctx.strategy - Strategy type
 * @param {string} ctx.regime - Market regime
 * @param {number} ctx.riskReward - R:R ratio
 * @param {string} baseUrl - Ollama base URL
 * @param {string} model - Ollama model name (default llama3.2)
 * @returns {Promise<boolean>} true = approve, false = reject or error
 */
async function approveTrade(ctx, baseUrl = DEFAULT_URL, model = 'llama3.2') {
  const base = baseUrl.replace(/\/$/, '');
  const prompt = buildPrompt(ctx);
  const systemPrompt = 'You are a crypto trading advisor. Reply ONLY with JSON: {"approve":true} or {"approve":false,"reason":"..."}. No other text.';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const headers = getHeaders(base);

    const generateBody = { model: model || 'llama3.2', prompt: systemPrompt + '\n\n' + prompt };
    const chatBody = {
      model: model || 'llama3.2',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    };
    const openaiBody = { model: model || 'llama3.2', messages: chatBody.messages };

    // Try native endpoints first; for ngrok, add fallback to OpenAI-compatible /v1/chat/completions
    let res;
    if (isNgrokUrl(base)) {
      res = await fetch(base + '/api/generate', { method: 'POST', headers, body: JSON.stringify(generateBody), signal: controller.signal });
      if (res.status === 404) res = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
      if (res.status === 404) res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(openaiBody), signal: controller.signal });
    } else {
      res = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
      if (res.status === 404) res = await fetch(base + '/api/generate', { method: 'POST', headers, body: JSON.stringify(generateBody), signal: controller.signal });
    }

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn('[Ollama]', res.status, res.statusText, base.includes('ngrok') ? '(try updating Ollama: ollama update)' : '');
      return false;
    }

    const data = await res.json();
    const text = data.message?.content || data.response || data.choices?.[0]?.message?.content || '';
    const json = parseJsonResponse(text);
    if (json && json.approve === true) {
      return true;
    }
    if (json && json.reason) {
      console.log('[Ollama] Rejected:', json.reason);
    }
    return false;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[Ollama] Timeout after', TIMEOUT_MS, 'ms');
    } else {
      console.warn('[Ollama]', err.message);
    }
    return false;
  }
}

function buildPrompt(ctx) {
  return `Trade candidate:
- Coin: ${ctx.symbol || ctx.coinId} (${ctx.coinId})
- Direction: ${ctx.direction}
- Score: ${ctx.score}/100
- Strategy: ${ctx.strategy || 'unknown'}
- Regime: ${ctx.regime || 'unknown'}
- Risk:Reward: ${ctx.riskReward != null ? ctx.riskReward.toFixed(2) : 'N/A'}

Should we open this trade? Reply with JSON only: {"approve":true} or {"approve":false,"reason":"..."}`;
}

function parseJsonResponse(text) {
  try {
    const trimmed = text.trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}') + 1;
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end));
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Check if Ollama is reachable.
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
async function checkOllamaReachable(baseUrl = DEFAULT_URL) {
  try {
    const url = baseUrl.replace(/\/$/, '') + '/api/tags';
    const headers = getHeaders(baseUrl);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch (e) {
    return false;
  }
}

module.exports = {
  approveTrade,
  checkOllamaReachable,
  DEFAULT_URL
};
