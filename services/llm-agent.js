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

const TIMEOUT_MS = 90000; // 90s for agent (backtest + weight ops can be slow)
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
  autoTradeSignalMode: ['original', 'indicators', 'both'],
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
  return url && (url.includes('ngrok-free') || url.includes('ngrok.io'));
}

function getOllamaHeaders(baseUrl, apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
    h['X-API-Key'] = apiKey.trim();
  }
  if (isNgrokUrl(baseUrl)) {
    h['ngrok-skip-browser-warning'] = '1';
    h['User-Agent'] = 'VotingApp-Ollama/1.0';
  }
  return h;
}

async function callAgent(prompt, systemPrompt, baseUrl, model, apiKey) {
  return enqueue(() => callAgentImpl(prompt, systemPrompt, baseUrl, model, apiKey));
}
async function callAgentImpl(prompt, systemPrompt, baseUrl, model, apiKey) {
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
  if (isNgrokUrl(base)) {
    res = await doFetch('/v1/chat/completions', openaiBody);
    if (res.status === 404) res = await doFetch('/v1/responses', responsesBody);
    if (res.status === 404) res = await doFetch('/api/generate', generateBody);
    if (res.status === 404) res = await doFetch('/api/chat', chatBody);
  } else {
    res = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
    if (res.status === 404) res = await fetch(base + '/api/generate', { method: 'POST', headers, body: JSON.stringify(generateBody), signal: controller.signal });
  }

  clearTimeout(timeout);
  if (!res.ok) throw new Error(res.status === 429 ? 'Rate limit (429). Server throttling. Wait and retry.' : `Ollama ${res.status}`);
  const data = await res.json();
  return data.message?.content || data.response || data.output_text || data.choices?.[0]?.message?.content || '';
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
  return `You are an autonomous crypto trading AI with FULL control over the platform. You have access to every signal, every setting, every strategy weight, and every trade. Your goal is to maximize profitability while managing risk.

You have access to:
1. Live signals with scores, CONFIDENCE (0-100), score breakdowns (trend/momentum/volume/structure/volatility/riskQuality), per-timeframe scores (1H/4H/1D), indicators (RSI, ADX, etc.), and engine reasoning
2. Open trades with live P&L, action badges (BE=breakeven, TS=trailing stop, LOCK=profit locked, PP=partial profit, RP=reduced position, EXIT=auto-closed, DCA=averaged), stops, TPs, time held, drawdown/profit peaks
3. Strategy weights from the learning engine (7 strategies with dimension weights and regime performance)
4. ALL feature toggles (turn on/off any trading feature)
5. Full performance stats (by strategy, by regime, streaks, drawdown)
6. Market conditions (Fear & Greed, BTC dominance, market cap changes)
7. Score history (how scores evolved over time for each coin)
8. Regime timeline (trending/ranging/volatile/compression/mixed changes over time)
9. Coin weights (boost/reduce allocation per coin)

DECISION FRAMEWORK - Use ALL of these factors, not just score:
- CONFIDENCE: High score + low confidence = unreliable, skip or reduce size
- Score Breakdown: All dimensions aligned (good) vs carried by one dimension (risky)
- Timeframe Agreement: 1H/4H/1D should agree for strong conviction
- Strategy Performance: Check if strategy is profitable in current regime via strategyWeights
- Action Badges: Trades with BE/TS already triggered are safer; trades with RP/EXIT signals are in trouble
- Reasoning: The engine provides reasoning - use it to understand WHY the score is what it is
- Market Conditions: Fear & Greed < 20 (extreme fear) = potential opportunity, > 80 = caution
- Regime: Match strategy to regime (trend_follow in trending, mean_revert in ranging, etc.)
- Coin Weights: Allocate more to historically profitable coins

FEATURE TOGGLE STRATEGY for backtesting:
- Turn features on/off to test different configurations
- Run backtest after toggling to measure impact
- Compare results to find optimal configuration
- Key toggles: featurePartialTP, autoMoveBreakeven, autoTrailingStop, featureLockIn, featureScoreRecheck, featureKellySizing, featureConfidenceSizing, dcaEnabled

WEIGHT ADJUSTMENT STRATEGY:
- Check strategy performance by regime
- If a strategy has 20+ trades and win rate < 40% in a regime, reduce its weights for that dimension
- If a strategy has 15+ trades and win rate > 60%, boost its weights
- Use adjust_weight to directly set dimension weights (trend/momentum/volume/structure/volatility/riskQuality)
- Each weight: 5-45, all must sum to 100
- Use optimize_strategy to let the engine auto-adjust based on historical performance

Reply ONLY with valid JSON in this exact format (no other text):
{
  "reasoning": "Detailed explanation of analysis and decisions (reference specific data points)",
  "actions": [
    { "tool": "change_setting", "key": "settingName", "value": numberOrBooleanOrString },
    { "tool": "toggle_feature", "feature": "featureName", "enabled": true },
    { "tool": "run_backtest", "days": 14, "overrides": { "featurePartialTP": false } },
    { "tool": "open_trade", "coinId": "ethereum", "direction": "LONG", "confidence": 85, "reasoning": "Why this trade" },
    { "tool": "close_trade", "tradeId": "id", "reason": "LLM_RISK_EXIT" },
    { "tool": "reduce_position", "tradeId": "id", "percent": 50 },
    { "tool": "adjust_weight", "strategyId": "trend_follow", "weights": { "trend": 35, "momentum": 25, "volume": 10, "structure": 15, "volatility": 10, "riskQuality": 5 } },
    { "tool": "optimize_strategy", "strategyId": "breakout" },
    { "tool": "reset_learning" },
    { "tool": "set_coin_weight", "coinId": "bitcoin", "weight": 1.2 },
    { "tool": "exclude_coin", "coinId": "dogecoin" },
    { "tool": "include_coin", "coinId": "ethereum" },
    { "tool": "move_stop_loss", "tradeId": "id", "stopLoss": 95000 },
    { "tool": "move_to_breakeven", "tradeId": "id" },
    { "tool": "update_take_profit", "tradeId": "id", "takeProfit1": 100000, "takeProfit2": 105000 }
  ]
}

Available tools:

SETTINGS (change_setting):
- Numeric: riskPerTrade (0.5-10), riskDollarsPerTrade (10-10000), maxOpenTrades (1-10), autoTradeMinScore (30-95), cooldownHours (0-168), defaultLeverage (1-20), minRiskReward (1-5), maxDailyLossPercent (0-20), drawdownThresholdPercent (5-50), minVolume24hUsd (0-500M), minExpectancy (-1 to 2), dcaMaxAdds (1-10), dcaDipPercent (0.5-20), dcaMinScore (30-95), llmAgentIntervalMinutes (5-1440)
- Enum: autoTradeCoinsMode (tracked|tracked+top1|top1), riskMode (percent|dollar), tpMode (fixed|trailing), trailingTpDistanceMode (atr|fixed), autoTradeSignalMode (original|indicators|both), coinWeightStrength (conservative|moderate|aggressive)
- Boolean: autoTrade, llmEnabled, autoMoveBreakeven, autoTrailingStop, paperLiveSync, useFixedLeverage, disableLeverage, coinWeightEnabled, llmAgentEnabled, and all feature toggles

FEATURE TOGGLES (toggle_feature): feature = one of: ${BOOLEAN_SETTINGS.join(', ')}. enabled = true/false

BACKTEST (run_backtest): days=7-30, optional overrides={} to test specific settings

LEARNING ENGINE:
- adjust_weight: strategyId (trend_follow|breakout|mean_revert|momentum|scalping|swing|position), weights={trend,momentum,volume,structure,volatility,riskQuality} (5-45 each, sum to 100)
- optimize_strategy: strategyId - auto-adjust weights based on performance data
- reset_learning: reset all weights and performance data to defaults

TRADE MANAGEMENT:
- open_trade: coinId, direction (LONG|SHORT), confidence (0-100), reasoning (string). Only for coins with actionable signals
- close_trade: tradeId, reason (optional custom close reason)
- reduce_position: tradeId, percent (10-99)
- move_stop_loss: tradeId, stopLoss (price)
- move_to_breakeven: tradeId
- update_take_profit: tradeId, takeProfit1/takeProfit2/takeProfit3

COIN MANAGEMENT:
- set_coin_weight: coinId, weight (0.1-3.0, 1.0=normal, >1=more allocation, <1=less)
- exclude_coin: coinId
- include_coin: coinId

If no changes needed, use "actions": [].
IMPORTANT: Always provide detailed reasoning that references specific data points (scores, confidence, breakdown, regime, strategy performance, market pulse, etc.)`;
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
    `- Balance: $${ctx.balance.toFixed(2)} (initial $${ctx.initialBalance.toFixed(2)}, return ${((ctx.balance - ctx.initialBalance) / ctx.initialBalance * 100).toFixed(2)}%)`,
    `- Stats: ${JSON.stringify(ctx.stats)}`,
    `- Open trades (${ctx.openTradesCount}): ${JSON.stringify(ctx.openTrades)}`,
    `- Recent closed trades (last ${ctx.recentTrades.length}): ${JSON.stringify(ctx.recentTrades)}`
  ];

  // All current settings
  const s = ctx.settings;
  promptParts.push(`- Settings: riskPerTrade=${s.riskPerTrade ?? 2}, riskMode=${s.riskMode || 'percent'}, riskDollarsPerTrade=${s.riskDollarsPerTrade ?? 200}, maxOpenTrades=${s.maxOpenTrades ?? 3}, autoTradeMinScore=${s.autoTradeMinScore ?? 56}, autoTrade=${s.autoTrade ?? false}, cooldownHours=${s.cooldownHours ?? 6}, defaultLeverage=${s.defaultLeverage ?? 2}, useFixedLeverage=${s.useFixedLeverage ?? false}, disableLeverage=${s.disableLeverage ?? false}, tpMode=${s.tpMode || 'fixed'}, autoTradeCoinsMode=${s.autoTradeCoinsMode || 'tracked'}, minRiskReward=${s.minRiskReward ?? 1.2}`);

  // Feature toggle state
  if (ctx.featureToggles) {
    const togglesOn = Object.entries(ctx.featureToggles).filter(([, v]) => v === true).map(([k]) => k);
    const togglesOff = Object.entries(ctx.featureToggles).filter(([, v]) => v === false).map(([k]) => k);
    promptParts.push(`- Features ON: ${togglesOn.join(', ') || 'none'}`);
    promptParts.push(`- Features OFF: ${togglesOff.join(', ') || 'none'}`);
  }

  // Strategy weights and performance from learning engine
  if (ctx.strategyWeights && ctx.strategyWeights.length > 0) {
    promptParts.push(`- Strategy Weights (learning engine):`);
    for (const sw of ctx.strategyWeights) {
      const p = sw.performance;
      promptParts.push(`  ${sw.strategyId}: weights=${JSON.stringify(sw.weights)}, ${p.totalTrades}trades WR=${p.winRate.toFixed(1)}% avgRR=${p.avgRR.toFixed(2)} PF=${p.profitFactor.toFixed(2)} byRegime=${JSON.stringify(p.byRegime)}`);
    }
  }

  // Coin weights
  if (ctx.coinWeights) {
    promptParts.push(`- Coin Weights (${ctx.coinWeights.strength}): ${JSON.stringify(ctx.coinWeights.weights)}`);
  }

  // Last backtest
  promptParts.push(ctx.lastBacktest ? `- Last backtest: ${JSON.stringify(ctx.lastBacktest)}` : '- No backtest run yet.');

  // Performance breakdowns
  if (ctx.stats?.riskByStrategyRegime) {
    const rbr = ctx.stats.riskByStrategyRegime;
    if (Object.keys(rbr.byStrategy || {}).length || Object.keys(rbr.byRegime || {}).length) {
      promptParts.push(`- Performance by strategy: ${JSON.stringify(rbr.byStrategy || {})}`);
      promptParts.push(`- Performance by regime: ${JSON.stringify(rbr.byRegime || {})}`);
    }
  }
  if (ctx.stats?.byStrategy && Object.keys(ctx.stats.byStrategy).length) {
    promptParts.push(`- Win/loss by strategy: ${JSON.stringify(ctx.stats.byStrategy)}`);
  }

  // Market pulse
  if (ctx.marketPulse) {
    const mp = ctx.marketPulse;
    const fg = mp.fearGreed;
    const g = mp.global || {};
    promptParts.push(`- Market Pulse: Fear & Greed ${fg?.value ?? 'N/A'} (${fg?.classification ?? 'N/A'}), BTC dom ${g.btcDominance != null ? g.btcDominance.toFixed(1) + '%' : 'N/A'}, ETH dom ${g.ethDominance != null ? g.ethDominance.toFixed(1) + '%' : 'N/A'}, mcap 24h ${g.marketCapChange24h != null ? (g.marketCapChange24h >= 0 ? '+' : '') + g.marketCapChange24h.toFixed(2) + '%' : 'N/A'}`);
  }

  // Live signals (enriched)
  if (ctx.liveSignals && ctx.liveSignals.length > 0) {
    promptParts.push(`- Live signals (top ${ctx.liveSignals.length}):`);
    for (const sig of ctx.liveSignals) {
      const parts = [`${sig.symbol} ${sig.signal} score=${sig.score}`];
      if (sig.confidence != null) parts.push(`conf=${sig.confidence}`);
      if (sig.regime) parts.push(`regime=${sig.regime}`);
      if (sig.strategyName) parts.push(`strat=${sig.strategyName}`);
      if (sig.riskReward != null) parts.push(`RR=${sig.riskReward.toFixed(2)}`);
      if (sig.scoreBreakdown) parts.push(`breakdown=${JSON.stringify(sig.scoreBreakdown)}`);
      if (sig.timeframes) parts.push(`TFs=${JSON.stringify(sig.timeframes)}`);
      if (sig.indicators) parts.push(`ind=${JSON.stringify(sig.indicators)}`);
      if (sig.reasoning) parts.push(`why: ${sig.reasoning}`);
      promptParts.push(`  ${parts.join(' | ')}`);
    }

    const actionable = ctx.liveSignals.filter(s => ['BUY', 'STRONG_BUY', 'SELL', 'STRONG_SELL'].includes(s.signal));
    if (actionable.length > 0) {
      promptParts.push(`- Actionable for open_trade: ${JSON.stringify(actionable.map(s => ({ coinId: s.coinId, symbol: s.symbol, signal: s.signal, score: s.score, confidence: s.confidence, direction: (s.signal === 'BUY' || s.signal === 'STRONG_BUY') ? 'LONG' : 'SHORT' })))}`);
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

  const parsed = parseJsonResponse(text);
  if (!parsed || !Array.isArray(parsed.actions)) {
    const failResult = { success: false, error: 'Invalid LLM response', raw: text?.slice(0, 300), at: new Date() };
    await saveAgentLog(userId, failResult, opts);
    return failResult;
  }

  const actionsExecuted = [];
  const actionsFailed = [];
  const actionContext = { fullSignals: ctx.fullSignals || [], top3MarketScan: ctx.top3MarketScan || [] };
  for (const action of parsed.actions) {
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
