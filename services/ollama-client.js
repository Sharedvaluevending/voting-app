/**
 * Ollama client for LLM-based trade approval.
 * Calls local Ollama API (http://localhost:11434 by default).
 * Used when user enables "Use LLM" in auto-trade settings.
 *
 * Returns structured { approve, confidence, reasoning } so the trading
 * engine can modulate position sizing based on LLM confidence.
 */

const fetch = require('node-fetch');
const { enqueue } = require('./ollama-queue');

const DEFAULT_URL = 'http://localhost:11434';
const TIMEOUT_MS = 90000; // 90s for trade approval (remote/slow models)
const NGROK_429_RETRIES = 3;     // Retry up to 3 times on 429 (ngrok free tier rate limit)
const NGROK_429_WAIT_MS = 30000; // Wait 30s before retry (ngrok per-minute limit = 4k req/min)

function isNgrokUrl(url) {
  return url && (url.includes('ngrok-free') || url.includes('ngrok.io') || url.includes('ngrok'));
}

function getHeaders(baseUrl, apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
    const key = apiKey.trim();
    h['X-API-Key'] = key;
    h['Authorization'] = 'Bearer ' + key; // Open WebUI uses Bearer
  }
  if (isNgrokUrl(baseUrl)) {
    h['ngrok-skip-browser-warning'] = '1';
    h['User-Agent'] = 'VotingApp-Ollama/1.0';
  }
  return h;
}

/** Fetch with retry on 429 (ngrok free tier rate limit). */
async function fetchWithRetry(url, opts, retries = NGROK_429_RETRIES) {
  let res = await fetch(url, opts);
  while (res.status === 429 && retries > 0) {
    console.warn('[Ollama] 429 rate limited by ngrok — waiting', NGROK_429_WAIT_MS / 1000, 's before retry');
    await new Promise(r => setTimeout(r, NGROK_429_WAIT_MS));
    retries--;
    res = await fetch(url, opts);
  }
  return res;
}

/**
 * Ask Ollama whether to approve opening a trade.
 * @param {Object} ctx - Trade context (enriched)
 * @param {string} ctx.coinId
 * @param {string} ctx.symbol
 * @param {string} ctx.direction - 'LONG' | 'SHORT'
 * @param {number} ctx.score - Signal score 0-100
 * @param {number} [ctx.confidence] - Signal confidence 0-100
 * @param {Object} [ctx.scoreBreakdown] - { trend, momentum, volume, structure, volatility, riskQuality }
 * @param {Array}  [ctx.reasoning] - Array of reasoning strings from scoring engine
 * @param {string} ctx.strategy - Strategy type
 * @param {string} ctx.regime - Market regime
 * @param {number} ctx.riskReward - R:R ratio
 * @param {Object} [ctx.indicators] - Key indicator values (RSI, MACD, etc.)
 * @param {Object} [ctx.marketPulse] - Fear & Greed, dominance, etc.
 * @param {Object} [ctx.strategyPerformance] - Win rate / PF for this strategy
 * @param {number} [ctx.openTradesCount] - Current open trades
 * @param {number} [ctx.maxOpenTrades] - Max allowed
 * @param {number} [ctx.balance] - Current paper balance
 * @param {Object} [ctx.timeframes] - Per-TF scores { '1H': score, '4H': score, '1D': score }
 * @param {number} [ctx.entry] - Intended entry price
 * @param {number} [ctx.stopLoss] - Intended stop loss
 * @param {number} [ctx.takeProfit1] - First take profit level
 * @param {Object} [ctx.recentPerformance] - { wins, losses, streak, dailyPnl }
 * @param {Object} [ctx.userDefaults] - User's default settings: tpMode, trailingTpDistanceMode, trailingTpAtrMultiplier, trailingTpFixedPercent, useFixedLeverage, defaultLeverage
 * @param {number} [ctx.atr] - ATR value for trailing TP (when trailingTpDistanceMode is atr)
 * @param {string} baseUrl
 * @param {string} model
 * @param {string} [apiKey] - X-API-Key for Open WebUI / remote LLM
 * @returns {Promise<{approve: boolean, confidence: number, reasoning: string, overrides?: Object}>}
 */
async function approveTrade(ctx, baseUrl = DEFAULT_URL, model = 'llama3.1:8b', apiKey) {
  return enqueue(() => approveTradeImpl(ctx, baseUrl, model, apiKey));
}
async function approveTradeImpl(ctx, baseUrl = DEFAULT_URL, model = 'llama3.1:8b', apiKey) {
  const base = baseUrl.replace(/\/$/, '');
  const prompt = buildPrompt(ctx);
  const systemPrompt = `You are an expert crypto trading risk advisor. Analyze the trade candidate using ALL provided data: score, confidence, score breakdown by dimension, reasoning from the scoring engine, indicators, market conditions, strategy historical performance, portfolio state, and risk/reward.

Your job is to decide whether this trade should be opened AND assign a confidence level (0-100) for how good this trade is.

OPTIONALLY, you may adjust trade parameters for this specific setup. If you approve, you can include an "overrides" object to tailor the trade for current conditions:
- stopLoss: adjust price (e.g. wider in volatile markets, tighter in ranging)
- takeProfit1, takeProfit2, takeProfit3: adjust TP levels
- tpMode: "fixed" (use TP1/TP2/TP3) or "trailing" (ride trend with trailing ATR)
- trailingTpDistanceMode: "atr" (dynamic) or "fixed" (fixed %)
- trailingTpAtrMultiplier: 0.5-5 (only when tpMode=trailing and trailingTpDistanceMode=atr)
- trailingTpFixedPercent: 0.5-10 (only when tpMode=trailing and trailingTpDistanceMode=fixed)
- useFixedLeverage: true/false
- leverage: 1-20 (when useFixedLeverage, or to override default)

Consider:
- Score breakdown: Are all dimensions aligned or is the score carried by one dimension?
- Confidence vs score: High score but low confidence = unreliable signal
- Strategy performance: Is this strategy profitable in the current regime?
- Market conditions: Fear & Greed, BTC trend, funding rates
- Portfolio risk: How many trades are already open? Daily P&L?
- Risk/Reward: Is the R:R adequate for the confidence level?
- Timeframe alignment: Do 1H, 4H, 1D agree?
- Reasoning: Do the scoring engine reasons make sense?
- Volatility: High volatility = wider stops, trailing TP may be better. Low volatility = fixed TPs may work.

Reply ONLY with valid JSON:
{"approve":true,"confidence":85,"reasoning":"...","overrides":{"stopLoss":95000,"tpMode":"trailing","trailingTpAtrMultiplier":2}}
or
{"approve":false,"confidence":30,"reasoning":"..."}

confidence must be 0-100. Higher = more certain the trade will be profitable. Omit "overrides" when defaults are fine.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const headers = getHeaders(base, apiKey);

    const chatBody = {
      model: model || 'llama3.1:8b',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
      stream: true,
      options: { num_ctx: 4096, num_predict: 256 }
    };
    const openaiBody = { model: model || 'llama3.1:8b', messages: chatBody.messages };
    const generateBody = { model: model || 'llama3.1:8b', prompt: systemPrompt + '\n\n' + prompt, stream: true, options: { num_ctx: 4096, num_predict: 256 } };
    const responsesBody = { model: model || 'llama3.1:8b', input: systemPrompt + '\n\n' + prompt };

    const doFetch = (path, body) => isNgrokUrl(base)
      ? fetchWithRetry(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      : fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });

    let res;
    if (isNgrokUrl(base)) {
      // Open WebUI: /api/chat/completions (OpenAI-compatible); fallbacks for other proxies
      res = await doFetch('/api/chat/completions', openaiBody);
      if (res.status === 404) res = await doFetch('/v1/chat/completions', openaiBody);
      if (res.status === 404) res = await doFetch('/v1/responses', responsesBody);
      if (res.status === 404) res = await doFetch('/api/generate', generateBody);
      if (res.status === 404) res = await doFetch('/api/chat', chatBody);
    } else {
      res = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
      if (res.status === 404) res = await fetch(base + '/api/generate', { method: 'POST', headers, body: JSON.stringify(generateBody), signal: controller.signal });
    }

    clearTimeout(timeout);

    if (!res.ok) {
      const msg = res.status === 429 ? 'Rate limit (429). Server is throttling requests. Wait a minute and try again.' : `LLM error: ${res.status}`;
      console.warn('[Ollama]', res.status, res.statusText, base.includes('ngrok') ? msg : '');
      return { approve: false, confidence: 0, reasoning: msg };
    }

    const raw = await res.text();
    let text = '';
    try {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('x-ndjson') || contentType.includes('stream')) {
        text = parseNdjsonContent(raw);
      } else {
        const data = JSON.parse(raw);
        text = data.message?.content || data.response || data.output_text || data.choices?.[0]?.message?.content || '';
      }
    } catch (parseErr) {
      text = parseNdjsonContent(raw) || raw;
    }
    const json = parseJsonResponse(text);

    if (json) {
      const confidence = Math.max(0, Math.min(100, Number(json.confidence) || 0));
      const reasoning = json.reasoning || json.reason || '';

      if (json.approve === true) {
        const overrides = validateOverrides(json.overrides, ctx);
        return { approve: true, confidence, reasoning, overrides };
      }
      if (json.reason) {
        console.log('[Ollama] Rejected:', json.reason);
      }
      return { approve: false, confidence, reasoning };
    }

    return { approve: false, confidence: 0, reasoning: 'Failed to parse LLM response' };
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[Ollama] Timeout after', TIMEOUT_MS, 'ms');
    } else {
      console.warn('[Ollama]', err.message);
    }
    return { approve: false, confidence: 0, reasoning: `LLM error: ${err.message}` };
  }
}

function buildPrompt(ctx) {
  const parts = [
    `Trade candidate:`,
    `- Coin: ${ctx.symbol || ctx.coinId} (${ctx.coinId})`,
    `- Direction: ${ctx.direction}`,
    `- Score: ${ctx.score}/100`,
    `- Confidence: ${ctx.confidence != null ? ctx.confidence + '/100' : 'N/A'}`,
    `- Strategy: ${ctx.strategy || 'unknown'}`,
    `- Regime: ${ctx.regime || 'unknown'}`,
    `- Risk:Reward: ${ctx.riskReward != null ? ctx.riskReward.toFixed(2) : 'N/A'}`
  ];

  if (ctx.scoreBreakdown) {
    const sb = ctx.scoreBreakdown;
    parts.push(`- Score Breakdown: trend=${sb.trend ?? '?'}, momentum=${sb.momentum ?? '?'}, volume=${sb.volume ?? '?'}, structure=${sb.structure ?? '?'}, volatility=${sb.volatility ?? '?'}, riskQuality=${sb.riskQuality ?? '?'}`);
  }

  if (ctx.timeframes) {
    const tf = ctx.timeframes;
    parts.push(`- Timeframe Scores: 1H=${tf['1H'] ?? '?'}, 4H=${tf['4H'] ?? '?'}, 1D=${tf['1D'] ?? '?'}`);
  }

  if (ctx.reasoning && Array.isArray(ctx.reasoning) && ctx.reasoning.length > 0) {
    parts.push(`- Engine Reasoning: ${ctx.reasoning.join('; ')}`);
  }

  if (ctx.indicators) {
    const ind = ctx.indicators;
    const indParts = [];
    if (ind.rsi != null) indParts.push(`RSI=${ind.rsi.toFixed(1)}`);
    if (ind.adx != null) indParts.push(`ADX=${ind.adx.toFixed(1)}`);
    if (ind.trendDirection) indParts.push(`trend=${ind.trendDirection}`);
    if (ind.volatilityState) indParts.push(`vol=${ind.volatilityState}`);
    if (ind.fundingRate != null) indParts.push(`funding=${(ind.fundingRate * 100).toFixed(4)}%`);
    if (ind.relativeVolume != null) indParts.push(`relVol=${ind.relativeVolume.toFixed(1)}x`);
    if (ind.bbSqueeze) indParts.push('BB_SQUEEZE');
    if (ind.marketStructure) indParts.push(`structure=${ind.marketStructure}`);
    if (indParts.length > 0) parts.push(`- Indicators: ${indParts.join(', ')}`);
  }

  if (ctx.entry != null) parts.push(`- Entry: $${ctx.entry.toFixed(2)}`);
  if (ctx.stopLoss != null) parts.push(`- Stop Loss: $${ctx.stopLoss.toFixed(2)}`);
  if (ctx.takeProfit1 != null) parts.push(`- Take Profit 1: $${ctx.takeProfit1.toFixed(2)}`);
  if (ctx.takeProfit2 != null) parts.push(`- Take Profit 2: $${ctx.takeProfit2.toFixed(2)}`);
  if (ctx.takeProfit3 != null) parts.push(`- Take Profit 3: $${ctx.takeProfit3.toFixed(2)}`);

  if (ctx.userDefaults) {
    const ud = ctx.userDefaults;
    parts.push(`- User defaults: tpMode=${ud.tpMode || 'fixed'}, trailingTpDistanceMode=${ud.trailingTpDistanceMode || 'atr'}, trailingTpAtrMultiplier=${ud.trailingTpAtrMultiplier ?? 1.5}, trailingTpFixedPercent=${ud.trailingTpFixedPercent ?? 2}, useFixedLeverage=${ud.useFixedLeverage ?? false}, leverage=${ud.defaultLeverage ?? 2}`);
  }
  if (ctx.atr != null && ctx.atr > 0) {
    parts.push(`- ATR: $${ctx.atr.toFixed(6)} (for trailing TP distance)`);
  }

  if (ctx.marketPulse) {
    const mp = ctx.marketPulse;
    const mpParts = [];
    if (mp.fearGreed?.value != null) mpParts.push(`Fear&Greed=${mp.fearGreed.value} (${mp.fearGreed.classification || ''})`);
    if (mp.global?.btcDominance != null) mpParts.push(`BTC_dom=${mp.global.btcDominance.toFixed(1)}%`);
    if (mp.global?.marketCapChange24h != null) mpParts.push(`mcap_24h=${mp.global.marketCapChange24h >= 0 ? '+' : ''}${mp.global.marketCapChange24h.toFixed(2)}%`);
    if (mpParts.length > 0) parts.push(`- Market Conditions: ${mpParts.join(', ')}`);
  }

  if (ctx.strategyPerformance) {
    const sp = ctx.strategyPerformance;
    parts.push(`- Strategy History: ${sp.totalTrades || 0} trades, WR ${(sp.winRate || 0).toFixed(1)}%, avgRR ${(sp.avgRR || 0).toFixed(2)}, PF ${(sp.profitFactor || 0).toFixed(2)}`);
    if (sp.regimeWinRate != null) {
      parts.push(`- Strategy in ${ctx.regime}: WR ${sp.regimeWinRate.toFixed(1)}% (${sp.regimeTrades || 0} trades)`);
    }
  }

  if (ctx.recentPerformance) {
    const rp = ctx.recentPerformance;
    parts.push(`- Recent: ${rp.wins || 0}W/${rp.losses || 0}L, streak=${rp.streak || 0}, dailyPnl=$${(rp.dailyPnl || 0).toFixed(2)}`);
  }

  if (ctx.openTradesCount != null) {
    parts.push(`- Portfolio: ${ctx.openTradesCount}/${ctx.maxOpenTrades || '?'} trades open, balance=$${(ctx.balance || 0).toFixed(2)}`);
  }

  parts.push('');
  parts.push('Analyze ALL dimensions above. Reply with JSON: {"approve":true/false,"confidence":0-100,"reasoning":"...","overrides":{...} (optional)}');

  return parts.join('\n');
}

/**
 * Validate and clamp LLM overrides. Returns sanitized overrides or null if invalid.
 */
function validateOverrides(overrides, ctx) {
  if (!overrides || typeof overrides !== 'object') return null;
  const entry = ctx.entry;
  const direction = ctx.direction;
  const isLong = direction === 'LONG';
  const out = {};

  if (overrides.stopLoss != null && Number.isFinite(Number(overrides.stopLoss)) && entry > 0) {
    const sl = Number(overrides.stopLoss);
    const valid = isLong ? sl < entry : sl > entry;
    if (valid) out.stopLoss = parseFloat(sl.toFixed(6));
  }
  if (overrides.takeProfit1 != null && Number.isFinite(Number(overrides.takeProfit1)) && entry > 0) {
    const tp = Number(overrides.takeProfit1);
    const valid = isLong ? tp > entry : tp < entry;
    if (valid) out.takeProfit1 = parseFloat(tp.toFixed(6));
  }
  if (overrides.takeProfit2 != null && Number.isFinite(Number(overrides.takeProfit2)) && entry > 0) {
    const tp = Number(overrides.takeProfit2);
    const valid = isLong ? tp > entry : tp < entry;
    if (valid) out.takeProfit2 = parseFloat(tp.toFixed(6));
  }
  if (overrides.takeProfit3 != null && Number.isFinite(Number(overrides.takeProfit3)) && entry > 0) {
    const tp = Number(overrides.takeProfit3);
    const valid = isLong ? tp > entry : tp < entry;
    if (valid) out.takeProfit3 = parseFloat(tp.toFixed(6));
  }
  if (overrides.tpMode === 'fixed' || overrides.tpMode === 'trailing') {
    out.tpMode = overrides.tpMode;
  }
  if (overrides.trailingTpDistanceMode === 'atr' || overrides.trailingTpDistanceMode === 'fixed') {
    out.trailingTpDistanceMode = overrides.trailingTpDistanceMode;
  }
  if (overrides.trailingTpAtrMultiplier != null) {
    const v = Math.max(0.5, Math.min(5, Number(overrides.trailingTpAtrMultiplier) || 1.5));
    out.trailingTpAtrMultiplier = v;
  }
  if (overrides.trailingTpFixedPercent != null) {
    const v = Math.max(0.5, Math.min(10, Number(overrides.trailingTpFixedPercent) || 2));
    out.trailingTpFixedPercent = v;
  }
  if (overrides.useFixedLeverage === true || overrides.useFixedLeverage === false) {
    out.useFixedLeverage = overrides.useFixedLeverage;
  }
  if (overrides.leverage != null) {
    const v = Math.max(1, Math.min(20, Math.round(Number(overrides.leverage)) || 2));
    out.leverage = v;
  }

  return Object.keys(out).length > 0 ? out : null;
}

/** Parse Ollama NDJSON stream, return concatenated message content */
function parseNdjsonContent(raw) {
  let out = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      const c = obj.message?.content ?? obj.response ?? obj.output_text ?? obj.choices?.[0]?.message?.content ?? '';
      if (c) out += c;
    } catch (e) { /* skip invalid lines */ }
  }
  return out;
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
 * Check if Ollama / Open WebUI is reachable.
 * Tries multiple paths: Open WebUI (/ollama/api/tags), direct Ollama (/api/tags), OpenAI (/api/v1/models).
 */
async function checkOllamaReachable(baseUrl = DEFAULT_URL, apiKey) {
  const base = baseUrl.replace(/\/$/, '');
  const headers = getHeaders(baseUrl, apiKey);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  const paths = isNgrokUrl(base)
    ? ['/ollama/api/tags', '/api/tags', '/api/v1/models']  // Open WebUI first, then Ollama, then OpenAI
    : ['/api/tags'];
  let lastRes = null;
  for (const path of paths) {
    try {
      const res = await fetch(base + path, { headers, signal: controller.signal });
      lastRes = res;
      if (res.ok) {
        clearTimeout(t);
        return { ok: true };
      }
      if (res.status !== 404) break; // 404 = try next path
    } catch (e) {
      if (e.name === 'AbortError') break;
    }
  }
  clearTimeout(t);
  const res = lastRes;
  if (!res) {
    const msg = controller.signal?.aborted ? 'Timeout (8s)' : 'Connection failed';
    return { ok: false, error: msg };
  }
  const statusText = res.statusText || '';
  let error = `${res.status} ${statusText}`;
  if (res.status === 429) {
    error += ' — Rate limit. Server throttling. Wait a minute and retry.';
  } else if (res.status === 502) {
    error += ' — Server can\'t reach Ollama backend. Is Ollama running? (ollama run llama3.1:8b)';
  } else if (res.status === 404) {
    error += ' — Wrong URL or Ollama/Open WebUI not ready.';
  } else if (res.status === 403 || res.status === 401) {
    error += ' — Access denied. Add API key (Settings > Account in Open WebUI).';
  }
  return { ok: false, status: res.status, statusText, error };
}

/**
 * Chat with Ollama (multi-turn). messages = [{role, content}, ...]
 */
async function chat(messages, baseUrl = DEFAULT_URL, model = 'llama3.1:8b', apiKey) {
  return enqueue(() => chatImpl(messages, baseUrl, model, apiKey));
}
async function chatImpl(messages, baseUrl = DEFAULT_URL, model = 'llama3.1:8b', apiKey) {
  const base = baseUrl.replace(/\/$/, '');
  const headers = getHeaders(base, apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000); // 2 min for chat (large models)
  const chatBody = { model: model || 'llama3.1:8b', messages, stream: true, options: { num_ctx: 4096, num_predict: 512 } };
  const openaiBody = { model: model || 'llama3.1:8b', messages };
  const lastUser = messages.filter(m => m.role === 'user').pop();
  const responsesBody = { model: model || 'llama3.1:8b', input: (lastUser && lastUser.content) || '' };

  let res;
  if (isNgrokUrl(base)) {
    // Open WebUI: /api/chat/completions first
    res = await fetchWithRetry(base + '/api/chat/completions', { method: 'POST', headers, body: JSON.stringify(openaiBody), signal: controller.signal });
    if (res.status === 404) res = await fetchWithRetry(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(openaiBody), signal: controller.signal });
    if (res.status === 404) res = await fetchWithRetry(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify(responsesBody), signal: controller.signal });
    if (res.status === 404) res = await fetchWithRetry(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
  } else {
    res = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
  }
  clearTimeout(timeout);
  if (!res.ok) {
    const msg = res.status === 429 ? 'Rate limit (429). Server throttling. Wait and retry.' : `Ollama ${res.status}`;
    throw new Error(msg);
  }
  const raw = await res.text();
  try {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('x-ndjson') || contentType.includes('stream')) {
      return parseNdjsonContent(raw);
    }
    const data = JSON.parse(raw);
    return data.message?.content || data.response || data.output_text || data.choices?.[0]?.message?.content || '';
  } catch (parseErr) {
    return parseNdjsonContent(raw) || raw;
  }
}

module.exports = {
  approveTrade,
  checkOllamaReachable,
  chat,
  DEFAULT_URL
};
