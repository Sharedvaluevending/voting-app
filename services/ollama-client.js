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
  if (isNgrokUrl(baseUrl)) {
    h['ngrok-skip-browser-warning'] = '1';
    h['User-Agent'] = 'VotingApp-Ollama/1.0'; // non-browser to avoid ngrok interstitial
  }
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
 * @param {string} model - Ollama model name (default qwen3-coder:480b-cloud)
 * @returns {Promise<boolean>} true = approve, false = reject or error
 */
async function approveTrade(ctx, baseUrl = DEFAULT_URL, model = 'qwen3-coder:480b-cloud') {
  const base = baseUrl.replace(/\/$/, '');
  const prompt = buildPrompt(ctx);
  const systemPrompt = 'You are a crypto trading advisor. Reply ONLY with JSON: {"approve":true} or {"approve":false,"reason":"..."}. No other text.';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const headers = getHeaders(base);

    const generateBody = { model: model || 'qwen3-coder:480b-cloud', prompt: systemPrompt + '\n\n' + prompt };
    const chatBody = {
      model: model || 'qwen3-coder:480b-cloud',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    };
    const openaiBody = { model: model || 'qwen3-coder:480b-cloud', messages: chatBody.messages };
    const responsesBody = { model: model || 'qwen3-coder:480b-cloud', input: systemPrompt + '\n\n' + prompt };

    // For ngrok: try multiple endpoints (some return 404 through ngrok)
    let res;
    if (isNgrokUrl(base)) {
      res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(openaiBody), signal: controller.signal });
      if (res.status === 404) res = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify(responsesBody), signal: controller.signal });
      if (res.status === 404) res = await fetch(base + '/api/generate', { method: 'POST', headers, body: JSON.stringify(generateBody), signal: controller.signal });
      if (res.status === 404) res = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
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
    const text = data.message?.content || data.response || data.output_text || data.choices?.[0]?.message?.content || '';
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
 * @returns {Promise<{ok: boolean, status?: number, statusText?: string, error?: string}>}
 */
async function checkOllamaReachable(baseUrl = DEFAULT_URL) {
  try {
    const url = baseUrl.replace(/\/$/, '') + '/api/tags';
    const headers = getHeaders(baseUrl);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(t);
    if (res.ok) return { ok: true };
    const statusText = res.statusText || '';
    let error = `${res.status} ${statusText}`;
    if (res.status === 502) {
      error += ' — ngrok can\'t reach Ollama. Is Ollama running? (ollama run qwen3-coder:480b-cloud)';
    } else if (res.status === 404) {
      error += ' — Wrong URL or Ollama version?';
    } else if (res.status === 403 || res.status === 401) {
      error += ' — Access denied (ngrok/auth?)';
    }
    return { ok: false, status: res.status, statusText, error };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Timeout (8s)' : e.message || 'Connection failed';
    return { ok: false, error: msg };
  }
}

/**
 * Chat with Ollama (multi-turn). messages = [{role, content}, ...]
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} baseUrl
 * @param {string} model
 * @returns {Promise<string>}
 */
async function chat(messages, baseUrl = DEFAULT_URL, model = 'qwen3-coder:480b-cloud') {
  const base = baseUrl.replace(/\/$/, '');
  const headers = getHeaders(base);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const chatBody = { model: model || 'qwen3-coder:480b-cloud', messages };
  const openaiBody = { model: model || 'qwen3-coder:480b-cloud', messages };
  const lastUser = messages.filter(m => m.role === 'user').pop();
  const responsesBody = { model: model || 'qwen3-coder:480b-cloud', input: (lastUser && lastUser.content) || '' };

  let res;
  if (isNgrokUrl(base)) {
    res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(openaiBody), signal: controller.signal });
    if (res.status === 404) res = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify(responsesBody), signal: controller.signal });
    if (res.status === 404) res = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
  } else {
    res = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
  }
  clearTimeout(timeout);
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return data.message?.content || data.response || data.output_text || data.choices?.[0]?.message?.content || '';
}

module.exports = {
  approveTrade,
  checkOllamaReachable,
  chat,
  DEFAULT_URL
};
