/**
 * LLM Agent - autonomous agent with FULL platform control.
 * Uses Ollama. Tools are validated and bounded for safety.
 *
 * The LLM has access to:
 * - All feature toggles (turn on/off any trading feature)
 * - All numeric settings (risk, leverage, scores, etc.)
 * - Learning engine weights (read, adjust, optimize, reset)
 * - Strategy comparison data (performance by strategy x regime)
 * - Trade management (open, close, reduce, stops, TPs)
 * - Backtesting (run historical sims with current settings)
 * - Coin management (exclude, include, set weight allocation)
 * - Full market context (signals, scores, confidence, breakdowns, indicators)
 */

const fetch = require('node-fetch');
const { enqueue } = require('./ollama-queue');
const { parseNdjsonContent, callDeepSeek } = require('./ollama-client');

const TIMEOUT_MS = 120000; // 120s for agent (remote models can be slow)
const NGROK_429_RETRIES = 3;
const NGROK_429_WAIT_MS = 30000;

async function fetchWithRetry(url, opts, retries = NGROK_429_RETRIES) {
  let res = await fetch(url, opts);
  while (res.status === 429 && retries > 0) {
    console.warn('[LLMAgent] 429 ngrok rate limit — waiting', NGROK_429_WAIT_MS / 1000, 's');
    await new Promise(r => setTimeout(r, NGROK_429_WAIT_MS));
    retries--;
    res = await fetch(url, opts);
  }
  return res;
}

// Allowed numeric settings with min/max bounds
const SETTING_BOUNDS = {
  riskPerTrade: { min: 0.5, max: 10 },
  riskDollarsPerTrade: { min: 10, max: 10000 },
  maxOpenTrades: { min: 1, max: 10 },
  maxBalancePercentPerTrade: { min: 5, max: 100 },
  cooldownHours: { min: 0, max: 168 },
  autoTradeMinScore: { min: 30, max: 95 },
  defaultLeverage: { min: 1, max: 20 },
  minRiskReward: { min: 1, max: 5 },
  maxDailyLossPercent: { min: 0, max: 20 },
  drawdownThresholdPercent: { min: 5, max: 50 },
  scoreCheckGraceMinutes: { min: 0, max: 60 },
  stopCheckGraceMinutes: { min: 0, max: 30 },
  minVolume24hUsd: { min: 0, max: 500000000 },
  minExpectancy: { min: -1, max: 2 },
  trailingTpAtrMultiplier: { min: 0.5, max: 5 },
  trailingTpFixedPercent: { min: 0.5, max: 10 },
  dcaMaxAdds: { min: 1, max: 10 },
  dcaDipPercent: { min: 0.5, max: 20 },
  dcaAddSizePercent: { min: 25, max: 200 },
  dcaMinScore: { min: 30, max: 95 },
  makerFeePercent: { min: 0, max: 1 },
  takerFeePercent: { min: 0, max: 1 },
  llmAgentIntervalMinutes: { min: 5, max: 1440 }
};

const ENUM_SETTINGS = {
  autoTradeCoinsMode: ['tracked', 'tracked+top1', 'top1'],
  riskMode: ['percent', 'dollar'],
  tpMode: ['fixed', 'trailing'],
  trailingTpDistanceMode: ['atr', 'fixed'],
  autoTradeSignalMode: ['original', 'indicators', 'setups', 'both'],
  autoTradeBothLogic: ['or', 'and'],
  coinWeightStrength: ['conservative', 'moderate', 'aggressive']
};

const BOOLEAN_SETTINGS = [
  'autoTrade', 'llmEnabled', 'autoExecuteActions', 'autoMoveBreakeven', 'autoTrailingStop',
  'featureBtcFilter', 'featureBtcCorrelation', 'featureSessionFilter', 'featurePartialTP',
  'featureLockIn', 'featureScoreRecheck', 'featureSlCap', 'featureMinSlDistance',
  'featureConfidenceSizing', 'featureKellySizing', 'minRiskRewardEnabled', 'dcaEnabled',
  'featureThemeDetector', 'featurePriceActionConfluence', 'featureVolatilityFilter',
  'featureVolumeConfirmation', 'featureFundingRateFilter', 'correlationFilterEnabled',
  'expectancyFilterEnabled', 'paperLiveSync', 'drawdownSizingEnabled', 'useFixedLeverage',
  'disableLeverage', 'coinWeightEnabled', 'llmAgentEnabled'
];

// Valid weight dimensions that can be adjusted
const WEIGHT_DIMENSIONS = ['trend', 'momentum', 'volume', 'structure', 'volatility', 'riskQuality'];

function userSettingsToBacktestFeatures(s) {
  if (!s) return {};
  return {
    btcFilter: s.featureBtcFilter !== false,
    btcCorrelation: s.featureBtcCorrelation !== false,
    sessionFilter: s.featureSessionFilter !== false,
    partialTP: s.featurePartialTP !== false,
    breakeven: s.autoMoveBreakeven !== false,
    trailingStop: s.autoTrailingStop !== false,
    lockIn: s.featureLockIn !== false,
    minSlDistance: s.featureMinSlDistance !== false,
    scoreRecheck: s.featureScoreRecheck !== false,
    slCap: s.featureSlCap !== false,
    confidenceSizing: s.featureConfidenceSizing !== false,
    kellySizing: s.featureKellySizing !== false,
    priceActionConfluence: s.featurePriceActionConfluence !== false,
    volatilityFilter: s.featureVolatilityFilter === true,
    volumeConfirmation: s.featureVolumeConfirmation !== false,
    fundingRateFilter: s.featureFundingRateFilter === true,
    minRiskRewardEnabled: s.minRiskRewardEnabled !== false,
    minRiskReward: s.minRiskReward ?? 1.2,
    maxDailyLossPercent: s.maxDailyLossPercent ?? 0,
    drawdownSizingEnabled: s.drawdownSizingEnabled === true,
    drawdownThresholdPercent: s.drawdownThresholdPercent ?? 10,
    minVolume24hUsd: s.minVolume24hUsd ?? 0,
    fees: true,
    slippage: true,
    closeBasedStops: true,
    dca: s.dcaEnabled === true,
    dcaMaxAdds: s.dcaMaxAdds ?? 3,
    dcaDipPercent: s.dcaDipPercent ?? 2,
    dcaAddSizePercent: s.dcaAddSizePercent ?? 100,
    dcaMinScore: s.dcaMinScore ?? 52
  };
}

// ====================================================
// Ollama call helpers
// ====================================================

function isNgrokUrl(url) {
  return url && (url.includes('ngrok-free') || url.includes('ngrok.io') || url.includes('ngrok'));
}

/** Remote URL (not localhost) - may be Open WebUI, try OpenAI-compat paths */
function isRemoteUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return !u.includes('localhost') && !u.includes('127.0.0.1');
}

function getOllamaHeaders(baseUrl, apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
    const key = apiKey.trim();
    h['X-API-Key'] = key;
    h['Authorization'] = 'Bearer ' + key; // Open WebUI uses Bearer
  }
  if (isNgrokUrl(baseUrl) || isRemoteUrl(baseUrl)) {
    h['ngrok-skip-browser-warning'] = '1';
    h['User-Agent'] = 'VotingApp-Ollama/1.0';
  }
  return h;
}

async function callAgent(prompt, systemPrompt, baseUrl, model, apiKey) {
  return enqueue(() => callAgentImpl(prompt, systemPrompt, baseUrl, model, apiKey));
}
async function callAgentImpl(prompt, systemPrompt, baseUrl, model, apiKey) {
  if (process.env.DEEPSEEK_API_KEY) {
    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }];
    return await callDeepSeek(messages, { maxTokens: 1024 });
  }

  const base = baseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = getOllamaHeaders(base, apiKey);

  const generateBody = { model: model || 'llama3.1:8b', prompt: systemPrompt + '\n\n' + prompt, stream: true, options: { num_ctx: 4096, num_predict: 1024 } };
  const chatBody = {
    model: model || 'llama3.1:8b',
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
    stream: true,
    options: { num_ctx: 4096, num_predict: 1024 }
  };
  const openaiBody = { model: model || 'llama3.1:8b', messages: chatBody.messages, stream: false };
  const responsesBody = { model: model || 'llama3.1:8b', input: systemPrompt + '\n\n' + prompt };

  const doFetch = (path, body) => isNgrokUrl(base)
    ? fetchWithRetry(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
    : fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });

  let res;
  if (isNgrokUrl(base) || isRemoteUrl(base)) {
    // Open WebUI / OpenAI-compat: try non-stream first for cleaner JSON
    res = await doFetch('/v1/chat/completions', openaiBody);
    if (res.status === 404) res = await doFetch('/api/chat/completions', openaiBody);
    if (res.status === 404) res = await doFetch('/v1/responses', responsesBody);
    if (res.status === 404) res = await doFetch('/api/generate', generateBody);
    if (res.status === 404) res = await doFetch('/api/chat', chatBody);
  } else {
    res = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
    if (res.status === 404) res = await fetch(base + '/api/generate', { method: 'POST', headers, body: JSON.stringify(generateBody), signal: controller.signal });
  }

  clearTimeout(timeout);
  if (!res.ok) throw new Error(res.status === 429 ? 'Rate limit (429). Server throttling. Wait and retry.' : `Ollama ${res.status}`);
  const raw = await res.text();
  let text = '';
  try {
    if (raw.includes('\n')) {
      text = parseNdjsonContent(raw);
    }
    if (!text) {
      const data = JSON.parse(raw);
      text = data.message?.content || data.response || data.output_text || data.choices?.[0]?.message?.content || '';
    }
  } catch (parseErr) {
    text = parseNdjsonContent(raw);
  }
  return text;
}

/** Robustly extract agent JSON from model output (handles markdown, code blocks, extra text) */
function parseAgentResponse(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Try ```json ... ``` or ``` ... ``` block first
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const block = codeBlockMatch[1].trim();
      const start = block.indexOf('{');
      const end = block.lastIndexOf('}') + 1;
      if (start >= 0 && end > start) {
        const parsed = JSON.parse(block.slice(start, end));
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (e) { /* fall through */ }
  }

  // 2. Find JSON object with "actions" key (handles multiple objects or extra text)
  const jsonCandidates = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(trimmed.slice(start, i + 1));
          if (obj && typeof obj === 'object' && 'actions' in obj) return obj;
          jsonCandidates.push(obj);
        } catch (e) { /* skip */ }
        start = -1;
      }
    }
  }

  // 3. Fallback: first { to last }
  const fallbackStart = trimmed.indexOf('{');
  const fallbackEnd = trimmed.lastIndexOf('}') + 1;
  if (fallbackStart >= 0 && fallbackEnd > fallbackStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(fallbackStart, fallbackEnd));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) { /* ignore */ }
  }

  return jsonCandidates.length > 0 ? jsonCandidates[0] : null;
}

// ====================================================
// Context building (enriched with learning, badges, feature state)
// ====================================================

async function buildContext(user, User, Trade, getPerformanceStats, fetchLivePrice, extraDeps) {
  const stats = await getPerformanceStats(user._id);
  const openTradesRaw = await Trade.find({ userId: user._id, status: 'OPEN' }).lean();
  const recentLimit = extraDeps ? 30 : 10;
  const recentTrades = await Trade.find({ userId: user._id, status: { $ne: 'OPEN' } })
    .sort({ exitTime: -1 }).limit(recentLimit).lean();

  const openTrades = [];
  for (const t of openTradesRaw) {
    let currentPrice = null;
    try {
      currentPrice = await fetchLivePrice(t.coinId);
    } catch (e) { /* ignore */ }
    const price = currentPrice != null && Number.isFinite(currentPrice) ? currentPrice : t.entryPrice;
    let pnl = 0;
    let pnlPercent = 0;
    if (t.entryPrice > 0 && price > 0) {
      if (t.direction === 'LONG') {
        pnl = ((price - t.entryPrice) / t.entryPrice) * t.positionSize;
      } else {
        pnl = ((t.entryPrice - price) / t.entryPrice) * t.positionSize;
      }
      pnlPercent = (pnl / (t.margin || t.positionSize)) * 100;
    }

    const badges = (t.actions || []).map(a => a.type).filter(Boolean);
    const lastAction = t.actions && t.actions.length > 0 ? t.actions[t.actions.length - 1] : null;

    openTrades.push({
      tradeId: t._id.toString(),
      symbol: t.symbol,
      coinId: t.coinId,
      direction: t.direction,
      entryPrice: t.entryPrice,
      currentPrice: price,
      positionSize: t.positionSize,
      margin: t.margin,
      pnl,
      pnlPercent,
      score: t.score,
      llmConfidence: t.llmConfidence,
      strategyType: t.strategyType,
      regime: t.regime,
      entryTime: t.entryTime,
      stopLoss: t.stopLoss,
      takeProfit1: t.takeProfit1,
      takeProfit2: t.takeProfit2,
      takeProfit3: t.takeProfit3,
      leverage: t.leverage,
      breakevenHit: t.breakevenHit,
      trailingActivated: t.trailingActivated,
      reducedByScore: t.reducedByScore,
      badges,
      lastAction: lastAction ? { type: lastAction.type, description: lastAction.description, timestamp: lastAction.timestamp } : null,
      scoreBreakdown: t.scoreBreakdownAtEntry,
      reasoning: t.reasoning,
      dcaCount: t.dcaCount || 0,
      maxDrawdownPercent: t.maxDrawdownPercent || 0,
      maxProfitPercent: t.maxProfitPercent || 0,
      timeHeld: t.entryTime ? Math.round((Date.now() - new Date(t.entryTime).getTime()) / 60000) + 'min' : 'unknown'
    });
  }

  const ctx = {
    balance: user.paperBalance ?? 10000,
    initialBalance: user.initialBalance ?? 10000,
    stats: stats || {},
    openTrades,
    openTradesCount: openTrades.length,
    recentTrades: recentTrades.map(t => ({
      symbol: t.symbol,
      coinId: t.coinId,
      direction: t.direction,
      pnl: t.pnl,
      pnlPercent: t.pnlPercent,
      status: t.status,
      strategyType: t.strategyType,
      regime: t.regime,
      score: t.score,
      llmConfidence: t.llmConfidence,
      badges: (t.actions || []).map(a => a.type).filter(Boolean),
      closeReason: t.closeReason,
      riskReward: t.margin > 0 ? Math.abs(t.pnl / t.margin) : 0
    })),
    settings: user.settings || {},
    lastBacktest: user.llmAgentLastBacktest || null,
    liveSignals: null,
    scoreHistory: null,
    regimeTimeline: null,
    strategyWeights: null,
    featureToggles: null,
    coinWeights: null
  };

  // Collect feature toggle state for the LLM
  const s = user.settings || {};
  ctx.featureToggles = {};
  for (const key of BOOLEAN_SETTINGS) {
    ctx.featureToggles[key] = s[key] !== undefined ? s[key] : null;
  }

  // Coin weights
  if (user.coinWeightEnabled && user.coinWeights && Object.keys(user.coinWeights).length > 0) {
    ctx.coinWeights = { enabled: true, strength: user.coinWeightStrength || 'moderate', weights: user.coinWeights };
  }

  // SMC setups (enabled IDs + available list). [] = scan all, [ids] = scan these
  const setupIds = s.autoTradeSetupIds || [];
  if (s.autoTradeUseSetups || setupIds.length > 0) {
    ctx.setupsEnabled = setupIds.length > 0 ? setupIds : [];
    try {
      const { getAllScenarios } = require('./smc-scenarios/scenario-definitions');
      ctx.availableSetups = getAllScenarios();
    } catch (e) { ctx.availableSetups = []; }
  }

  // Strategy weights from learning engine
  try {
    const StrategyWeight = require('../models/StrategyWeight');
    const strategies = await StrategyWeight.find({ active: true }).lean();
    ctx.strategyWeights = strategies.map(sw => ({
      strategyId: sw.strategyId,
      name: sw.name,
      weights: sw.weights,
      performance: {
        totalTrades: sw.performance?.totalTrades || 0,
        wins: sw.performance?.wins || 0,
        losses: sw.performance?.losses || 0,
        winRate: sw.performance?.winRate || 0,
        avgRR: sw.performance?.avgRR || 0,
        profitFactor: sw.performance?.profitFactor || 0,
        byRegime: sw.performance?.byRegime || {}
      }
    }));
  } catch (e) { /* ignore */ }

  // Full context: live signals, score history, regime timeline
  if (extraDeps?.fetchAllPrices && extraDeps?.fetchAllCandles && extraDeps?.fetchAllHistory &&
      extraDeps?.buildEngineOptions && extraDeps?.analyzeAllCoins) {
    try {
      const [prices, allCandles, allHistory] = await Promise.all([
        extraDeps.fetchAllPrices(),
        Promise.resolve(extraDeps.fetchAllCandles()),
        extraDeps.fetchAllHistory()
      ]);
      if (prices && prices.length > 0) {
        const options = await extraDeps.buildEngineOptions(prices, allCandles, allHistory, user);
        const signals = extraDeps.analyzeAllCoins(prices, allCandles, allHistory, options);
        ctx.fullSignals = (signals || []).slice(0, 15);
        ctx.liveSignals = ctx.fullSignals.map(s => ({
          symbol: s.coin?.symbol || s.coin?.id,
          coinId: s.coin?.id,
          signal: s.signal,
          score: s.score,
          confidence: s.confidence,
          regime: s.regime,
          strategyName: s.strategyName,
          scoreBreakdown: s.scoreBreakdown,
          reasoning: Array.isArray(s.reasoning) ? s.reasoning.join('; ') : s.reasoning,
          timeframes: s.timeframes ? { '1H': s.timeframes['1H']?.score, '4H': s.timeframes['4H']?.score, '1D': s.timeframes['1D']?.score } : null,
          entry: s.entry,
          stopLoss: s.stopLoss,
          takeProfit1: s.takeProfit1,
          riskReward: s.riskReward,
          indicators: s.indicators ? {
            rsi: s.indicators.rsi,
            adx: s.indicators.adx,
            trendDirection: s.indicators.trendDirection,
            volatilityState: s.indicators.volatilityState,
            marketStructure: s.indicators.marketStructure,
            fundingRate: s.indicators.fundingRate,
            relativeVolume: s.indicators.relativeVolume
          } : null
        }));

        if (extraDeps.getScoreHistory) {
          const coinIds = new Set(openTrades.map(t => t.coinId));
          signals.slice(0, 3).forEach(s => { if (s.coin?.id) coinIds.add(s.coin.id); });
          const scoreHistory = {};
          for (const cid of coinIds) {
            const hist = extraDeps.getScoreHistory(cid) || [];
            if (hist.length > 0) {
              scoreHistory[cid] = hist.slice(-8).map(h => ({ score: h.score, signal: h.signal, regime: h.regime }));
            }
          }
          ctx.scoreHistory = Object.keys(scoreHistory).length ? scoreHistory : null;
        }

        if (extraDeps.getRegimeTimeline) {
          const tl = extraDeps.getRegimeTimeline() || [];
          ctx.regimeTimeline = tl.slice(-5).map(s => s.counts || {});
        }
      }

      if (extraDeps.getTop3FullCached) {
        try {
          ctx.top3MarketScan = extraDeps.getTop3FullCached() || [];
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  if (extraDeps?.getMarketPulse) {
    try {
      ctx.marketPulse = await extraDeps.getMarketPulse();
    } catch (e) { /* ignore */ }
  }

  return ctx;
}

// ====================================================
// Action execution (all tools the LLM can use)
// ====================================================

async function executeAction(action, user, deps, actionContext = {}) {
  const { tool, key, value } = action;
  const { User, Trade, runBacktest, closeTrade, closeTradePartial, updateTradeLevels, fetchLivePrice, openTrade } = deps;

  // ── change_setting ──
  if (tool === 'change_setting') {
    if (!key || typeof key !== 'string') return { ok: false, message: 'Missing key' };
    const bounds = SETTING_BOUNDS[key];
    const isBool = BOOLEAN_SETTINGS.includes(key);
    const enumVals = ENUM_SETTINGS[key];
    if (enumVals && enumVals.includes(value)) {
      user.settings = user.settings || {};
      user.settings[key] = value;
      await user.save();
      return { ok: true, message: `Set ${key}=${value}` };
    }
    if (bounds) {
      const num = Number(value);
      if (!Number.isFinite(num)) return { ok: false, message: `Invalid number for ${key}` };
      const clamped = Math.max(bounds.min, Math.min(bounds.max, num));
      user.settings = user.settings || {};
      user.settings[key] = clamped;
      await user.save();
      return { ok: true, message: `Set ${key}=${clamped}` };
    }
    if (isBool) {
      const boolVal = value === true || value === 'true' || value === 1;
      user.settings = user.settings || {};
      user.settings[key] = boolVal;
      await user.save();
      return { ok: true, message: `Set ${key}=${boolVal}` };
    }
    return { ok: false, message: `Setting ${key} not allowed` };
  }

  // ── toggle_feature ──
  if (tool === 'toggle_feature') {
    const feature = action.feature;
    const enabled = action.enabled;
    if (!feature || typeof feature !== 'string') return { ok: false, message: 'Missing feature name' };
    if (!BOOLEAN_SETTINGS.includes(feature)) return { ok: false, message: `Feature ${feature} not recognized. Available: ${BOOLEAN_SETTINGS.join(', ')}` };
    const boolVal = enabled === true || enabled === 'true' || enabled === 1;
    user.settings = user.settings || {};
    user.settings[feature] = boolVal;
    await user.save();
    return { ok: true, message: `${feature} = ${boolVal ? 'ON' : 'OFF'}` };
  }

  // ── run_backtest ──
  if (tool === 'run_backtest') {
    const days = Math.min(30, Math.max(7, Number(action.days) || 14));
    const endMs = Date.now();
    const startMs = endMs - days * 24 * 60 * 60 * 1000;
    const s = user.settings || {};
    const features = userSettingsToBacktestFeatures(s);

    // Allow LLM to override specific settings for this backtest run
    if (action.overrides && typeof action.overrides === 'object') {
      for (const [ok, ov] of Object.entries(action.overrides)) {
        if (SETTING_BOUNDS[ok]) {
          const num = Number(ov);
          if (Number.isFinite(num)) features[ok] = Math.max(SETTING_BOUNDS[ok].min, Math.min(SETTING_BOUNDS[ok].max, num));
        }
        if (typeof ov === 'boolean') features[ok] = ov;
      }
    }

    try {
      const result = await runBacktest(startMs, endMs, {
        features,
        riskPerTrade: s.riskPerTrade ?? 2,
        riskDollarsPerTrade: s.riskDollarsPerTrade ?? 200,
        riskMode: s.riskMode === 'dollar' ? 'dollar' : 'percent',
        initialBalance: 10000
      });
      const sm = result.summary || {};
      const totalTrades = sm.totalTrades || 0;
      const wins = sm.wins || 0;
      const summary = {
        days,
        totalTrades,
        wins,
        losses: sm.losses || 0,
        winRate: totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0,
        totalPnl: sm.totalPnl != null ? sm.totalPnl.toFixed(2) : 'N/A',
        totalPnlPercent: sm.returnPct != null ? sm.returnPct.toFixed(2) : 'N/A',
        maxDrawdown: sm.maxDrawdownPct != null ? sm.maxDrawdownPct.toFixed(2) : 'N/A',
        profitFactor: sm.profitFactor != null ? sm.profitFactor.toFixed(2) : 'N/A',
        avgRR: sm.avgRR != null ? sm.avgRR.toFixed(2) : 'N/A',
        bestTrade: sm.bestTrade != null ? sm.bestTrade.toFixed(2) : 'N/A',
        worstTrade: sm.worstTrade != null ? sm.worstTrade.toFixed(2) : 'N/A',
        byStrategy: sm.byStrategy || null,
        overrides: action.overrides || null
      };
      user.llmAgentLastBacktest = { ...summary, at: new Date() };
      await user.save();
      return { ok: true, message: `Backtest ${days}d: ${summary.totalTrades} trades, WR ${summary.winRate}%, PnL ${summary.totalPnlPercent}%, MDD ${summary.maxDrawdown}%, PF ${summary.profitFactor}` };
    } catch (err) {
      return { ok: false, message: `Backtest failed: ${err.message}` };
    }
  }

  // ── adjust_weight ──
  if (tool === 'adjust_weight') {
    const strategyId = action.strategyId;
    const weights = action.weights;
    if (!strategyId || typeof strategyId !== 'string') return { ok: false, message: 'Missing strategyId' };
    if (!weights || typeof weights !== 'object') return { ok: false, message: 'Missing weights object' };

    try {
      const StrategyWeight = require('../models/StrategyWeight');
      const sw = await StrategyWeight.findOne({ strategyId });
      if (!sw) return { ok: false, message: `Strategy ${strategyId} not found` };

      for (const dim of WEIGHT_DIMENSIONS) {
        if (weights[dim] != null) {
          const val = Math.max(5, Math.min(45, Math.round(Number(weights[dim]))));
          if (Number.isFinite(val)) sw.weights[dim] = val;
        }
      }

      // Normalize to 100
      const total = Object.values(sw.weights).reduce((a, b) => a + b, 0);
      if (total > 0 && total !== 100) {
        for (const k of Object.keys(sw.weights)) {
          sw.weights[k] = Math.max(5, Math.round((sw.weights[k] / total) * 100));
        }
        const newTotal = Object.values(sw.weights).reduce((a, b) => a + b, 0);
        if (newTotal !== 100) {
          const largest = Object.entries(sw.weights).sort((a, b) => b[1] - a[1])[0][0];
          sw.weights[largest] += (100 - newTotal);
        }
      }

      sw.updatedAt = new Date();
      sw.markModified('weights');
      await sw.save();

      return { ok: true, message: `Adjusted ${strategyId} weights: ${JSON.stringify(sw.weights)}` };
    } catch (err) {
      return { ok: false, message: `Weight adjustment failed: ${err.message}` };
    }
  }

  // ── optimize_strategy ──
  if (tool === 'optimize_strategy') {
    const strategyId = action.strategyId;
    if (!strategyId) return { ok: false, message: 'Missing strategyId' };

    try {
      const { adjustWeights } = require('./learning-engine');
      await adjustWeights();
      const StrategyWeight = require('../models/StrategyWeight');
      const sw = await StrategyWeight.findOne({ strategyId }).lean();
      if (!sw) return { ok: false, message: `Strategy ${strategyId} not found` };
      return {
        ok: true,
        message: `Optimized ${strategyId}: weights=${JSON.stringify(sw.weights)}, WR=${(sw.performance?.winRate || 0).toFixed(1)}%, PF=${(sw.performance?.profitFactor || 0).toFixed(2)}`
      };
    } catch (err) {
      return { ok: false, message: `Optimize failed: ${err.message}` };
    }
  }

  // ── reset_learning ──
  if (tool === 'reset_learning') {
    try {
      const { resetStrategyWeights } = require('./learning-engine');
      await resetStrategyWeights();
      return { ok: true, message: 'All strategy weights and performance data reset to defaults' };
    } catch (err) {
      return { ok: false, message: `Reset failed: ${err.message}` };
    }
  }

  // ── set_coin_weight ──
  if (tool === 'set_coin_weight') {
    const coinId = action.coinId;
    const weight = Number(action.weight);
    if (!coinId || typeof coinId !== 'string') return { ok: false, message: 'Missing coinId' };
    if (!Number.isFinite(weight) || weight < 0.1 || weight > 3.0) return { ok: false, message: 'weight must be 0.1-3.0 (1.0 = normal)' };

    user.coinWeights = user.coinWeights || {};
    user.coinWeights[coinId] = Math.round(weight * 100) / 100;
    user.coinWeightEnabled = true;
    user.markModified('coinWeights');
    await user.save();
    return { ok: true, message: `Coin weight ${coinId} = ${weight}x` };
  }

  // ── close_trade ──
  if (tool === 'close_trade') {
    const tradeId = action.tradeId;
    if (!tradeId) return { ok: false, message: 'Missing tradeId' };
    const trade = await Trade.findOne({ _id: tradeId, userId: user._id, status: 'OPEN' });
    if (!trade) return { ok: false, message: 'Trade not found or already closed' };
    let price;
    try {
      price = await fetchLivePrice(trade.coinId);
    } catch (e) { /* ignore */ }
    if (price == null || !Number.isFinite(price) || price <= 0) {
      price = trade.entryPrice;
    }
    await closeTrade(user._id, trade._id, price, action.reason || 'LLM_AGENT_CLOSE');
    return { ok: true, message: `Closed ${trade.symbol} ${trade.direction}` };
  }

  // ── reduce_position ──
  if (tool === 'reduce_position') {
    const tradeId = action.tradeId;
    const percent = Math.min(99, Math.max(10, Number(action.percent) || 50));
    if (!tradeId) return { ok: false, message: 'Missing tradeId' };
    const trade = await Trade.findOne({ _id: tradeId, userId: user._id, status: 'OPEN' });
    if (!trade) return { ok: false, message: 'Trade not found or already closed' };
    const portionSize = (trade.positionSize * percent) / 100;
    let price;
    try {
      price = await fetchLivePrice(trade.coinId);
    } catch (e) { /* ignore */ }
    if (price == null || !Number.isFinite(price) || price <= 0) {
      price = trade.entryPrice;
    }
    await closeTradePartial(trade, price, portionSize, 'LLM_AGENT_REDUCE');
    return { ok: true, message: `Reduced ${trade.symbol} by ${percent}%` };
  }

  // ── exclude_coin ──
  if (tool === 'exclude_coin') {
    const coinId = action.coinId;
    if (!coinId || typeof coinId !== 'string') return { ok: false, message: 'Missing coinId' };
    user.excludedCoins = user.excludedCoins || [];
    if (!user.excludedCoins.includes(coinId)) {
      user.excludedCoins.push(coinId);
      await user.save();
      return { ok: true, message: `Excluded ${coinId} from auto-trade` };
    }
    return { ok: true, message: `${coinId} already excluded` };
  }

  // ── include_coin ──
  if (tool === 'include_coin') {
    const coinId = action.coinId;
    if (!coinId || typeof coinId !== 'string') return { ok: false, message: 'Missing coinId' };
    user.excludedCoins = user.excludedCoins || [];
    user.excludedCoins = user.excludedCoins.filter(c => c !== coinId);
    await user.save();
    return { ok: true, message: `Included ${coinId} in auto-trade` };
  }

  // ── move_stop_loss ──
  if (tool === 'move_stop_loss') {
    const tradeId = action.tradeId;
    const stopLoss = Number(action.stopLoss);
    if (!tradeId) return { ok: false, message: 'Missing tradeId' };
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) return { ok: false, message: 'Invalid stopLoss price' };
    const trade = await Trade.findOne({ _id: tradeId, userId: user._id, status: 'OPEN' });
    if (!trade) return { ok: false, message: 'Trade not found or already closed' };
    let price;
    try { price = await fetchLivePrice(trade.coinId); } catch (e) { /* ignore */ }
    const cp = price ?? trade.entryPrice;
    const result = await updateTradeLevels(user._id, tradeId, { stopLoss }, cp);
    return result.ok ? { ok: true, message: `Moved ${trade.symbol} stop to $${stopLoss.toFixed(2)}` } : result;
  }

  // ── move_to_breakeven ──
  if (tool === 'move_to_breakeven') {
    const tradeId = action.tradeId;
    if (!tradeId) return { ok: false, message: 'Missing tradeId' };
    const trade = await Trade.findOne({ _id: tradeId, userId: user._id, status: 'OPEN' });
    if (!trade) return { ok: false, message: 'Trade not found or already closed' };
    const BE_BUFFER = 0.003;
    const newSl = trade.direction === 'LONG'
      ? trade.entryPrice * (1 + BE_BUFFER)
      : trade.entryPrice * (1 - BE_BUFFER);
    let price;
    try { price = await fetchLivePrice(trade.coinId); } catch (e) { /* ignore */ }
    const cp = price ?? trade.entryPrice;
    const result = await updateTradeLevels(user._id, tradeId, { stopLoss: newSl }, cp);
    return result.ok ? { ok: true, message: `Moved ${trade.symbol} stop to breakeven` } : result;
  }

  // ── update_take_profit ──
  if (tool === 'update_take_profit') {
    const tradeId = action.tradeId;
    if (!tradeId) return { ok: false, message: 'Missing tradeId' };
    const trade = await Trade.findOne({ _id: tradeId, userId: user._id, status: 'OPEN' });
    if (!trade) return { ok: false, message: 'Trade not found or already closed' };
    const updates = {};
    if (action.takeProfit1 != null && Number.isFinite(Number(action.takeProfit1))) updates.takeProfit1 = Number(action.takeProfit1);
    if (action.takeProfit2 != null && Number.isFinite(Number(action.takeProfit2))) updates.takeProfit2 = Number(action.takeProfit2);
    if (action.takeProfit3 != null && Number.isFinite(Number(action.takeProfit3))) updates.takeProfit3 = Number(action.takeProfit3);
    if (Object.keys(updates).length === 0) return { ok: false, message: 'Provide at least one of takeProfit1, takeProfit2, takeProfit3' };
    let price;
    try { price = await fetchLivePrice(trade.coinId); } catch (e) { /* ignore */ }
    const cp = price ?? trade.entryPrice;
    const result = await updateTradeLevels(user._id, tradeId, updates, cp);
    return result.ok ? { ok: true, message: `Updated ${trade.symbol} take profit levels` } : result;
  }

  // ── setup_backtest ──
  if (tool === 'setup_backtest') {
    const coinId = (action.coinId || 'bitcoin').toString().toLowerCase().trim();
    const setupId = (action.setupId || '').toString().trim();
    const days = Math.min(90, Math.max(7, Number(action.days) || 30));
    const timeframe = ['1h', '4h'].includes(action.timeframe) ? action.timeframe : '1h';
    if (!setupId) return { ok: false, message: 'Missing setupId (e.g. fvg_liquidity_long)' };
    try {
      const { runSetupBacktest } = require('./smc-backtest');
      const { getAllScenarios } = require('./smc-scenarios/scenario-definitions');
      const validIds = getAllScenarios().map(s => s.id);
      if (!validIds.includes(setupId)) return { ok: false, message: `Unknown setup. Valid: ${validIds.slice(0, 5).join(', ')}...` };
      const endMs = Date.now();
      const startMs = endMs - days * 24 * 60 * 60 * 1000;
      const result = await runSetupBacktest(coinId, setupId, startMs, endMs, { initialBalance: 10000, leverage: 2, timeframe });
      if (result.error) return { ok: false, message: result.error };
      const sm = result.summary || {};
      const msg = `Setup backtest ${setupId} on ${coinId} (${days}d ${timeframe}): ${sm.totalTrades || 0} trades, WR ${(sm.winRate || 0).toFixed(1)}%, PnL ${(sm.totalPnlPercent != null ? sm.totalPnlPercent.toFixed(1) : 'N/A')}%, MDD ${(sm.maxDrawdownPct || 0).toFixed(1)}%`;
      return { ok: true, message: msg };
    } catch (err) {
      return { ok: false, message: `Setup backtest failed: ${err.message}` };
    }
  }

  // ── scan_setups ──
  if (tool === 'scan_setups') {
    const setupId = action.setupId ? [action.setupId.toString().trim()] : null;
    try {
      const { scanMarketForSetups } = require('./smc-scanner');
      const fetchAllCandles = deps.fetchAllCandles;
      const fetchAllPrices = deps.fetchAllPrices;
      if (!fetchAllCandles || !fetchAllPrices) return { ok: false, message: 'Candle/price data not available' };
      const candles = typeof fetchAllCandles === 'function' ? fetchAllCandles() : null;
      const prices = await fetchAllPrices();
      if (!candles || Object.keys(candles).length === 0) return { ok: false, message: 'No candle data. Wait for refresh.' };
      const results = scanMarketForSetups(candles, Array.isArray(prices) ? prices : [], setupId);
      const ready = [];
      for (const r of results) {
        for (const sc of r.scenarios || []) {
          if (sc.ready && sc.entry != null && sc.sl != null) ready.push({ coinId: r.coinId, setupId: sc.scenarioId, setupName: sc.name, direction: sc.direction, entry: sc.entry, sl: sc.sl, tp1: sc.tp1, tp2: sc.tp2, tp3: sc.tp3, score: sc.score, htfBias: sc.htfBias || r.htfBias });
        }
      }
      if (ready.length > 0) {
        const SetupNotification = require('../models/SetupNotification');
        const source = actionContext.source === 'scheduled' ? 'llm_autonomous' : 'llm_scan';
        for (const item of ready) {
          await SetupNotification.create({
            userId: user._id,
            coinId: item.coinId,
            setupId: item.setupId,
            setupName: item.setupName,
            direction: item.direction,
            entry: item.entry,
            sl: item.sl,
            tp1: item.tp1,
            tp2: item.tp2,
            tp3: item.tp3,
            score: item.score,
            htfBias: item.htfBias,
            source
          });
        }
        return { ok: true, message: `Found ${ready.length} ready setup(s): ${ready.map(x => `${x.coinId} ${x.setupName}`).join('; ')}. Push notifications created.` };
      }
      return { ok: true, message: `Scanned. No ready setups found. (${results.length} coins had partial matches)` };
    } catch (err) {
      return { ok: false, message: `Setup scan failed: ${err.message}` };
    }
  }

  // ── open_trade ──
  if (tool === 'open_trade') {
    const coinId = (action.coinId || '').toString().toLowerCase().trim();
    const direction = (action.direction || '').toUpperCase();
    if (!coinId) return { ok: false, message: 'Missing coinId' };
    if (direction !== 'LONG' && direction !== 'SHORT') return { ok: false, message: 'direction must be LONG or SHORT' };
    if (!openTrade) return { ok: false, message: 'openTrade not available' };

    // Register scanner meta for top 3 coins so fetchLivePrice can use Bitget/Kraken (fixes "Live price unavailable")
    const { registerScannerCoinMeta } = require('./crypto-api');
    const top3Scan = actionContext.top3MarketScan || [];
    const top3Match = top3Scan.find(s => ((s.coin?.id || s.coinData?.id) || '').toLowerCase() === coinId);
    if (top3Match && (top3Match.coin?.symbol || top3Match.coinData?.symbol)) {
      registerScannerCoinMeta(coinId, top3Match.coin?.symbol || top3Match.coinData?.symbol);
    }

    const fullSignals = actionContext.fullSignals || [];
    const wantBuy = direction === 'LONG';
    const matchSignal = (s) => {
      const cid = (s.coin?.id || s.coinData?.id || '').toLowerCase();
      if (cid !== coinId) return false;
      const sig = s.signal || '';
      if (wantBuy) return sig === 'STRONG_BUY' || sig === 'BUY';
      return sig === 'STRONG_SELL' || sig === 'SELL';
    };
    let sig = fullSignals.find(matchSignal) || top3Scan.find(matchSignal);
    if (!sig) return { ok: false, message: `No actionable signal for ${coinId} ${direction}. Check liveSignals or top3MarketScan.` };

    let livePrice;
    try { livePrice = await fetchLivePrice(coinId); } catch (e) { /* ignore */ }
    if (!Number.isFinite(livePrice) || livePrice <= 0) {
      livePrice = sig.coin?.price || sig.coinData?.price;
    }
    if (!Number.isFinite(livePrice) || livePrice <= 0) return { ok: false, message: `Could not get live price for ${coinId}` };

    const strat = sig.topStrategies?.[0] || sig._bestStrat || {};
    let useSL = strat.stopLoss || sig.stopLoss;
    let useTP1 = strat.takeProfit1 || sig.takeProfit1;
    let useTP2 = strat.takeProfit2 || sig.takeProfit2;
    let useTP3 = strat.takeProfit3 || sig.takeProfit3;
    const analysisEntry = strat.entry || sig.entry || sig.coin?.price || sig.coinData?.price;
    if (analysisEntry && analysisEntry > 0 && useSL && Math.abs(livePrice - analysisEntry) / analysisEntry > 0.005) {
      const ratio = livePrice / analysisEntry;
      useSL = parseFloat((useSL * ratio).toFixed(6));
      if (useTP1) useTP1 = parseFloat((useTP1 * ratio).toFixed(6));
      if (useTP2) useTP2 = parseFloat((useTP2 * ratio).toFixed(6));
      if (useTP3) useTP3 = parseFloat((useTP3 * ratio).toFixed(6));
    }
    if (!useSL) {
      const defaultSlPct = 0.05;
      useSL = direction === 'LONG' ? livePrice * (1 - defaultSlPct) : livePrice * (1 + defaultSlPct);
      useSL = parseFloat(useSL.toFixed(6));
    }
    if (direction === 'LONG') {
      if (useTP1 && useTP1 <= livePrice * 0.99) useTP1 = null;
      if (useTP2 && useTP2 <= livePrice * 0.99) useTP2 = null;
      if (useTP3 && useTP3 <= livePrice * 0.99) useTP3 = null;
      if (useSL >= livePrice * 1.01) useSL = livePrice * 0.95;
    } else {
      if (useTP1 && useTP1 >= livePrice * 1.01) useTP1 = null;
      if (useTP2 && useTP2 >= livePrice * 1.01) useTP2 = null;
      if (useTP3 && useTP3 >= livePrice * 1.01) useTP3 = null;
      if (useSL <= livePrice * 0.99) useSL = livePrice * 1.05;
    }

    const { getCoinMeta } = require('./crypto-api');
    const meta = getCoinMeta(coinId);
    const coinData = sig.coin || sig.coinData || {};
    const symbol = meta?.symbol || coinData.symbol || coinId.toUpperCase();
    const useStratType = (strat && strat.id) || sig.strategyType || 'auto';
    let strategyStats = {};
    try {
      const StrategyWeight = require('../models/StrategyWeight');
      const sw = await StrategyWeight.find({ active: true }).lean();
      (sw || []).forEach(s => {
        strategyStats[s.strategyId] = {
          totalTrades: s.performance?.totalTrades || 0,
          winRate: s.performance?.winRate ?? 0,
          avgRR: s.performance?.avgRR ?? 0
        };
      });
    } catch (e) { /* ignore */ }

    const suggestLeverage = require('./paper-trading').suggestLeverage;
    const lev = user.settings?.disableLeverage ? 1
      : (user.settings?.useFixedLeverage ? (user.settings?.defaultLeverage ?? 2)
        : (sig.suggestedLeverage || suggestLeverage(sig.score || 50, sig.regime || 'mixed', sig.indicators?.volatilityState || 'normal')));

    const llmConfidence = Number(action.confidence) || null;

    const tradeData = {
      coinId,
      symbol,
      direction,
      entry: livePrice,
      stopLoss: useSL,
      takeProfit1: useTP1,
      takeProfit2: useTP2,
      takeProfit3: useTP3,
      volume24h: coinData.volume24h,
      leverage: lev,
      score: sig.score || 50,
      strategyType: useStratType,
      regime: sig.regime || 'unknown',
      reasoning: sig.reasoning || [],
      indicators: sig.indicators || {},
      scoreBreakdown: sig.scoreBreakdown || {},
      stopType: sig.stopType || 'ATR_SR_FIB',
      stopLabel: sig.stopLabel || 'ATR + S/R + Fib',
      tpType: sig.tpType || 'R_multiple',
      tpLabel: sig.tpLabel || 'R multiples',
      strategyStats,
      autoTriggered: false,
      llmConfidence,
      llmReasoning: action.reasoning || ''
    };

    try {
      await openTrade(user._id, tradeData);
      return { ok: true, message: `Opened ${direction} on ${symbol} at $${livePrice.toFixed(2)}${llmConfidence ? ` (confidence: ${llmConfidence})` : ''}` };
    } catch (err) {
      return { ok: false, message: `Open trade failed: ${err.message}` };
    }
  }

  return { ok: false, message: `Unknown tool: ${tool}` };
}

// ====================================================
// Agent log persistence
// ====================================================

async function saveAgentLog(userId, result, opts = {}) {
  try {
    const LlmAgentLog = require('../models/LlmAgentLog');
    await LlmAgentLog.create({
      userId,
      success: result.success === true,
      source: opts.source || 'manual',
      reasoning: result.reasoning || '',
      actionsExecuted: result.actionsExecuted || [],
      actionsFailed: result.actionsFailed || [],
      error: result.error,
      userRequest: opts.userRequest,
      at: result.at || new Date()
    });
  } catch (e) {
    console.warn('[LLMAgent] Failed to save log:', e.message);
  }
}

// ====================================================
// System prompt: complete documentation of all capabilities
// ====================================================

function buildSystemPrompt() {
  return `You are an autonomous crypto trading AI. You have FULL control over the platform.
GOAL: Maximize profitability while managing risk.

CONTEXT:
1. Live signals with scores, CONFIDENCE (0-100), breakdowns (trend/momentum/volume/structure), indicators.
2. Open trades (P&L, badges: BE=breakeven, TS=trailing, RP=reduced, EXIT=closed).
3. Strategy weights (learning engine) and performance stats.
4. Feature toggles (turn on/off features).
5. Market conditions (Fear & Greed, BTC dominance).

DECISION LOGIC:
- CONFIDENCE: High score + low confidence = unreliable.
- BREAKDOWN: All dimensions aligned is best.
- REGIME: Match strategy to regime (e.g. Trend Following in 'trending').
- BADGES: Respect existing trade states (BE, TS).
- MARKET: Fear < 20 = opportunity? Fear > 80 = caution?

OUTPUT FORMAT:
Reply ONLY with valid JSON. No markdown. No explanations outside JSON.
{
  "reasoning": "Detailed analysis referencing specific data points",
  "actions": [
    { "tool": "change_setting", "key": "settingName", "value": "val" },
    { "tool": "toggle_feature", "feature": "featureName", "enabled": true },
    { "tool": "open_trade", "coinId": "btc", "direction": "LONG", "confidence": 85, "reasoning": "..." },
    { "tool": "close_trade", "tradeId": "id", "reason": "RISK_EXIT" },
    { "tool": "reduce_position", "tradeId": "id", "percent": 50 },
    { "tool": "adjust_weight", "strategyId": "trend_follow", "weights": { "trend": 30, "momentum": 30, "volume": 20, "structure": 20 } },
    { "tool": "move_stop_loss", "tradeId": "id", "stopLoss": 95000 },
    { "tool": "move_to_breakeven", "tradeId": "id" },
    { "tool": "update_take_profit", "tradeId": "id", "takeProfit1": 100000 },
    { "tool": "setup_backtest", "coinId": "bitcoin", "setupId": "fvg_liquidity_long", "days": 30, "timeframe": "1h" },
    { "tool": "scan_setups", "setupId": "fvg_liquidity_long" }
  ]
}

TOOLS:
- change_setting: riskPerTrade, maxOpenTrades, autoTradeMinScore, cooldownHours, defaultLeverage, autoTrade, llmEnabled
- toggle_feature: featurePartialTP, autoMoveBreakeven, autoTrailingStop, featureLockIn, featureScoreRecheck, dcaEnabled
- open_trade, close_trade, reduce_position
- move_stop_loss, move_to_breakeven, update_take_profit
- adjust_weight, reset_learning
- set_coin_weight, exclude_coin, include_coin
- run_backtest: days (7-30), optional overrides
- setup_backtest: coinId, setupId, days (7-90), timeframe (1h|4h)
- scan_setups: setupId (optional, null=all), creates notifications when ready setups found

If no action needed, return "actions": [].`;
}

// ====================================================
// Main agent entry point
// ====================================================

async function runAgent(userId, deps, opts = {}) {
  const { User, Trade, runBacktest, getPerformanceStats } = deps;
  const user = await User.findById(userId);
  if (!user) return { success: false, error: 'User not found' };

  const ollamaUrl = user.settings?.ollamaUrl || 'http://localhost:11434';
  const ollamaApiKey = user.settings?.ollamaApiKey || '';
  const model = user.settings?.ollamaModel || 'llama3.1:8b';

  const extraDeps = {
    fetchAllPrices: deps.fetchAllPrices,
    fetchAllCandles: deps.fetchAllCandles,
    fetchAllHistory: deps.fetchAllHistory,
    buildEngineOptions: deps.buildEngineOptions,
    analyzeAllCoins: deps.analyzeAllCoins,
    getScoreHistory: deps.getScoreHistory,
    getRegimeTimeline: deps.getRegimeTimeline,
    getMarketPulse: deps.getMarketPulse,
    getTop3FullCached: deps.getTop3FullCached
  };
  const ctx = await buildContext(user, User, Trade, getPerformanceStats, deps.fetchLivePrice, extraDeps);

  const systemPrompt = buildSystemPrompt();

  const promptParts = [
    `Current state:`,
    `- Balance: $${ctx.balance.toFixed(0)} (Ret: ${((ctx.balance - ctx.initialBalance) / ctx.initialBalance * 100).toFixed(1)}%)`,
    `- Stats: ${JSON.stringify(ctx.stats)}`,
    `- Open trades (${ctx.openTradesCount}): ${JSON.stringify(ctx.openTrades.map(t => ({ id: t.tradeId, s: t.symbol, pnl: t.pnl.toFixed(0), score: t.score })))}`,
    `- Recent: ${JSON.stringify(ctx.recentTrades.slice(0, 3).map(t => ({ s: t.symbol, pnl: t.pnl.toFixed(0) })))}`
  ];

  // All current settings (compact)
  const s = ctx.settings;
  promptParts.push(`- Settings: risk=${s.riskPerTrade ?? 2}%, maxTr=${s.maxOpenTrades ?? 3}, minSc=${s.autoTradeMinScore ?? 56}, auto=${s.autoTrade ?? false}, cd=${s.cooldownHours ?? 6}h, lev=${s.defaultLeverage ?? 2}x`);

  // Feature toggle state (compact)
  if (ctx.featureToggles) {
    const on = Object.entries(ctx.featureToggles).filter(([, v]) => v === true).map(([k]) => k.replace('feature', ''));
    promptParts.push(`- Features ON: ${on.join(',') || 'none'}`);
  }

  // Strategy weights (compact)
  if (ctx.strategyWeights && ctx.strategyWeights.length > 0) {
    promptParts.push(`- Strat wts: ` + ctx.strategyWeights.map(sw => `${sw.strategyId.slice(0, 3)}=${JSON.stringify(sw.weights)} WR=${sw.performance?.winRate.toFixed(0)}%`).join('; '));
  }

  // Coin weights
  if (ctx.coinWeights) {
    promptParts.push(`- Coin wts: ${JSON.stringify(ctx.coinWeights.weights)}`);
  }

  // Market pulse (compact)
  if (ctx.marketPulse) {
    const mp = ctx.marketPulse;
    const fg = mp.fearGreed;
    const g = mp.global || {};
    promptParts.push(`- Market: F&G ${fg?.value ?? '?'} (${fg?.classification ?? '?'}), BTC ${g.btcDominance?.toFixed(0)}%, ETH ${g.ethDominance?.toFixed(0)}%`);
  }

  // Live signals (enriched, compact)
  if (ctx.liveSignals && ctx.liveSignals.length > 0) {
    promptParts.push(`- Live signals (top ${ctx.liveSignals.length}):`);
    for (const sig of ctx.liveSignals) {
      const parts = [`${sig.symbol} ${sig.signal} sc=${sig.score}`];
      if (sig.confidence != null) parts.push(`conf=${sig.confidence}`);
      if (sig.scoreBreakdown) parts.push(`bd=${JSON.stringify(sig.scoreBreakdown)}`);
      if (sig.indicators) parts.push(`ind=${JSON.stringify(sig.indicators)}`);
      promptParts.push(`  ${parts.join(' | ')}`);
    }

    const actionable = ctx.liveSignals.filter(s => ['BUY', 'STRONG_BUY', 'SELL', 'STRONG_SELL'].includes(s.signal));
    if (actionable.length > 0) {
      promptParts.push(`- Actionable: ${JSON.stringify(actionable.map(s => ({ coinId: s.coinId, sym: s.symbol, sig: s.signal, sc: s.score, conf: s.confidence, dir: (s.signal.includes('BUY')) ? 'LONG' : 'SHORT' })))}`);
    }
  }

  // Top 3 from market scan
  if (ctx.top3MarketScan && ctx.top3MarketScan.length > 0) {
    const top3 = ctx.top3MarketScan.map(s => ({
      coinId: s.coin?.id || s.coinData?.id,
      symbol: s.coin?.symbol || s.coinData?.symbol,
      signal: s.signal,
      score: s.score,
      confidence: s.confidence,
      regime: s.regime,
      strategyName: s.strategyName,
      entry: s.entry,
      stopLoss: s.stopLoss,
      takeProfit1: s.takeProfit1,
      riskReward: s.riskReward,
      direction: ['BUY', 'STRONG_BUY'].includes(s.signal) ? 'LONG' : ['SELL', 'STRONG_SELL'].includes(s.signal) ? 'SHORT' : null
    }));
    promptParts.push(`- Top 3 from 80-coin market scan: ${JSON.stringify(top3)}`);
  }

  // Score & regime history
  if (ctx.scoreHistory && Object.keys(ctx.scoreHistory).length > 0) {
    promptParts.push(`- Score history (recent): ${JSON.stringify(ctx.scoreHistory)}`);
  }
  if (ctx.regimeTimeline && ctx.regimeTimeline.length > 0) {
    promptParts.push(`- Regime timeline (recent): ${JSON.stringify(ctx.regimeTimeline)}`);
  }
  if (user.excludedCoins && user.excludedCoins.length > 0) {
    promptParts.push(`- Excluded coins: ${JSON.stringify(user.excludedCoins)}`);
  }

  // SMC setups (enabled setup IDs, available setups)
  if (ctx.setupsEnabled && ctx.setupsEnabled.length > 0) {
    promptParts.push(`- Setups enabled: ${ctx.setupsEnabled.join(', ')}. Use scan_setups to find active setups.`);
  }
  if (ctx.availableSetups && ctx.availableSetups.length > 0) {
    promptParts.push(`- Available setups: ${ctx.availableSetups.slice(0, 8).map(s => s.id).join(', ')}`);
  }

  // User request or default review
  if (opts.userRequest) {
    promptParts.push(`\nUser request: "${opts.userRequest}"\n\nAnalyze the situation using ALL available data (scores, confidence, breakdowns, strategy performance, regime, indicators, badges, market pulse). Take the appropriate actions. Use tradeId from open trades above. Include detailed reasoning referencing specific data points. Reply with JSON only.`);
  } else {
    promptParts.push(`\nAUTONOMOUS REVIEW — Analyze everything:
1. Open trades: Check P&L, badges, score evolution, regime fit. Close/reduce losers. Tighten stops on winners.
2. Live signals: Any high-score + high-confidence opportunities? Check breakdown alignment and strategy regime fit.
3. Feature toggles: Are current settings optimal? Consider toggling + backtest to validate.
4. Strategy weights: Any strategy underperforming in current regime? Adjust weights or optimize.
5. Risk settings: Is risk appropriate for current market conditions (Fear & Greed, volatility)?
6. Coin weights: Any coins consistently winning/losing? Adjust allocation.
7. SMC setups: If setups enabled, use scan_setups to find active setups. Creates push notifications when found.

Use confidence, score breakdown, and reasoning to make decisions — not just raw score. Reply with JSON only.`);
  }

  const prompt = promptParts.join('\n');

  let text;
  try {
    text = await callAgent(prompt, systemPrompt, ollamaUrl, model, ollamaApiKey);
  } catch (err) {
    const failResult = { success: false, error: err.message, at: new Date() };
    await saveAgentLog(userId, failResult, opts);
    return failResult;
  }

  const parsed = parseAgentResponse(text);
  if (!parsed || typeof parsed !== 'object') {
    const failResult = { success: false, error: 'Invalid LLM response', raw: text?.slice(0, 500), at: new Date() };
    await saveAgentLog(userId, failResult, opts);
    return failResult;
  }
  // Normalize actions: must be array (model sometimes omits or returns wrong type)
  const actions = Array.isArray(parsed.actions) ? parsed.actions : (parsed.actions ? [parsed.actions] : []);

  const actionsExecuted = [];
  const actionsFailed = [];
  const actionContext = { fullSignals: ctx.fullSignals || [], top3MarketScan: ctx.top3MarketScan || [], source: opts.source };
  for (const action of actions) {
    if (!action.tool) continue;
    const result = await executeAction(action, user, deps, actionContext);
    if (result.ok) {
      actionsExecuted.push({ ...action, message: result.message });
    } else {
      actionsFailed.push({ ...action, message: result.message });
    }
  }

  const runResult = {
    success: true,
    reasoning: parsed.reasoning || '',
    actionsExecuted,
    actionsFailed,
    at: new Date()
  };

  user.llmAgentLastRun = runResult;
  await user.save();

  await saveAgentLog(userId, runResult, opts);

  return runResult;
}

module.exports = {
  runAgent,
  buildContext,
  SETTING_BOUNDS,
  BOOLEAN_SETTINGS
};
