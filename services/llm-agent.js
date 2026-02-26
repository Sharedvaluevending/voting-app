/**
 * LLM Agent - autonomous agent that can change settings, run backtests, and optimize.
 * Uses Ollama. Tools are validated and bounded for safety.
 */

const fetch = require('node-fetch');

const TIMEOUT_MS = 60000; // 60s for agent (backtest can be slow)

// Allowed settings with min/max bounds. Keys must match User.settings.
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
  stopCheckGraceMinutes: { min: 0, max: 30 }
};

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

const ENUM_SETTINGS = {
  autoTradeCoinsMode: ['tracked', 'tracked+top1', 'top1'],
  riskMode: ['percent', 'dollar']
};

const BOOLEAN_SETTINGS = [
  'autoTrade', 'llmEnabled', 'autoExecuteActions', 'autoMoveBreakeven', 'autoTrailingStop',
  'featureBtcFilter', 'featureBtcCorrelation', 'featureSessionFilter', 'featurePartialTP',
  'featureLockIn', 'featureScoreRecheck', 'featureSlCap', 'featureMinSlDistance',
  'featureConfidenceSizing', 'featureKellySizing', 'minRiskRewardEnabled', 'dcaEnabled',
  'featureThemeDetector', 'featurePriceActionConfluence', 'featureVolatilityFilter',
  'featureVolumeConfirmation', 'featureFundingRateFilter', 'correlationFilterEnabled',
  'expectancyFilterEnabled', 'paperLiveSync'
];

/**
 * Call Ollama with agent prompt.
 */
function isNgrokUrl(url) {
  return url && (url.includes('ngrok-free') || url.includes('ngrok.io'));
}

function getOllamaHeaders(baseUrl) {
  const h = { 'Content-Type': 'application/json' };
  if (isNgrokUrl(baseUrl)) {
    h['ngrok-skip-browser-warning'] = '1';
    h['User-Agent'] = 'VotingApp-Ollama/1.0';
  }
  return h;
}

async function callAgent(prompt, systemPrompt, baseUrl, model) {
  const base = baseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = getOllamaHeaders(base);

  const generateBody = { model: model || 'qwen3-coder:480b-cloud', prompt: systemPrompt + '\n\n' + prompt };
  const chatBody = {
    model: model || 'qwen3-coder:480b-cloud',
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
  };
  const openaiBody = { model: model || 'qwen3-coder:480b-cloud', messages: chatBody.messages };
  const responsesBody = { model: model || 'qwen3-coder:480b-cloud', input: systemPrompt + '\n\n' + prompt };

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
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
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

/**
 * Build context for the agent.
 * @param {Object} user
 * @param {Object} User - User model
 * @param {Object} Trade - Trade model
 * @param {Function} getPerformanceStats
 * @param {Function} fetchLivePrice
 * @param {Object} [extraDeps] - Optional: fetchAllPrices, fetchAllCandles, fetchAllHistory, buildEngineOptions, analyzeAllCoins, getScoreHistory, getRegimeTimeline, getMarketPulse, getTop3FullCached
 */
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
      strategyType: t.strategyType,
      regime: t.regime,
      entryTime: t.entryTime
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
      regime: t.regime
    })),
    settings: user.settings || {},
    lastBacktest: user.llmAgentLastBacktest || null,
    liveSignals: null,
    scoreHistory: null,
    regimeTimeline: null
  };

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
          riskReward: s.riskReward
        }));

        // Score history for open-trade coins + top 3 from signals
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

        // Regime timeline (last 5 snapshots)
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

/**
 * Execute a single action. Returns { ok, message }.
 * @param {Object} actionContext - Optional: { fullSignals, top3MarketScan } for open_trade
 */
async function executeAction(action, user, deps, actionContext = {}) {
  const { tool, key, value } = action;
  const { User, Trade, runBacktest, closeTrade, closeTradePartial, updateTradeLevels, fetchLivePrice, openTrade } = deps;

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

  if (tool === 'run_backtest') {
    const days = Math.min(14, Math.max(7, Number(action.days) || 14));
    const endMs = Date.now();
    const startMs = endMs - days * 24 * 60 * 60 * 1000;
    const s = user.settings || {};
    const features = userSettingsToBacktestFeatures(s);
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
        totalPnlPercent: sm.returnPct != null ? sm.returnPct.toFixed(2) : 'N/A'
      };
      user.llmAgentLastBacktest = { ...summary, at: new Date() };
      await user.save();
      return { ok: true, message: `Backtest ${days}d: ${summary.totalTrades} trades, WR ${summary.winRate}%, PnL ${summary.totalPnlPercent}%` };
    } catch (err) {
      return { ok: false, message: `Backtest failed: ${err.message}` };
    }
  }

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
    await closeTrade(user._id, trade._id, price, 'LLM_AGENT_CLOSE');
    return { ok: true, message: `Closed ${trade.symbol} ${trade.direction}` };
  }

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

  if (tool === 'include_coin') {
    const coinId = action.coinId;
    if (!coinId || typeof coinId !== 'string') return { ok: false, message: 'Missing coinId' };
    user.excludedCoins = user.excludedCoins || [];
    user.excludedCoins = user.excludedCoins.filter(c => c !== coinId);
    await user.save();
    return { ok: true, message: `Included ${coinId} in auto-trade` };
  }

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

  if (tool === 'open_trade') {
    const coinId = (action.coinId || '').toString().toLowerCase().trim();
    const direction = (action.direction || '').toUpperCase();
    if (!coinId) return { ok: false, message: 'Missing coinId' };
    if (direction !== 'LONG' && direction !== 'SHORT') return { ok: false, message: 'direction must be LONG or SHORT' };
    if (!openTrade) return { ok: false, message: 'openTrade not available' };

    // Find signal from context (fullSignals = tracked coins, top3MarketScan = 80-coin scan)
    const fullSignals = actionContext.fullSignals || [];
    const top3Scan = actionContext.top3MarketScan || [];
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
      autoTriggered: false
    };

    try {
      await openTrade(user._id, tradeData);
      return { ok: true, message: `Opened ${direction} on ${symbol} at $${livePrice.toFixed(2)}` };
    } catch (err) {
      return { ok: false, message: `Open trade failed: ${err.message}` };
    }
  }

  return { ok: false, message: `Unknown tool: ${tool}` };
}

/**
 * Save agent run to LlmAgentLog for the LLM Logs page.
 */
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

/**
 * Run the LLM agent for a user.
 * @param {string} userId
 * @param {Object} deps
 * @param {Object} [opts] - { userRequest?: string, source?: 'manual'|'scheduled'|'chat' }
 * @returns {Object} { success, actionsExecuted, actionsFailed, reasoning }
 */
async function runAgent(userId, deps, opts = {}) {
  const { User, Trade, runBacktest, getPerformanceStats } = deps;
  const user = await User.findById(userId);
  if (!user) return { success: false, error: 'User not found' };

  const ollamaUrl = user.settings?.ollamaUrl || 'http://localhost:11434';
  const model = user.settings?.ollamaModel || 'qwen3-coder:480b-cloud';

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

  const systemPrompt = `You are an autonomous crypto trading assistant with full market and portfolio context. You have access to everything: live signals (tracked 20 coins + top 3 from 80-coin market scan), Market Pulse (Fear & Greed, dominance), open trades, performance stats, score history, regime timeline. You can change settings, run backtests, open new trades, close/reduce positions, move stops, and exclude/include coins.

Reply ONLY with valid JSON in this exact format (no other text):
{
  "reasoning": "Brief explanation of what you're doing and why",
  "actions": [
    { "tool": "change_setting", "key": "settingName", "value": numberOrBoolean },
    { "tool": "run_backtest", "days": 14 },
    { "tool": "open_trade", "coinId": "ethereum", "direction": "LONG" },
    { "tool": "close_trade", "tradeId": "trade_id_string" },
    { "tool": "reduce_position", "tradeId": "trade_id_string", "percent": 50 },
    { "tool": "exclude_coin", "coinId": "bitcoin" },
    { "tool": "include_coin", "coinId": "bitcoin" },
    { "tool": "move_stop_loss", "tradeId": "trade_id_string", "stopLoss": 95000 },
    { "tool": "move_to_breakeven", "tradeId": "trade_id_string" },
    { "tool": "update_take_profit", "tradeId": "trade_id_string", "takeProfit1": 100000, "takeProfit2": 105000 }
  ]
}

Available tools:
- change_setting: key = setting name, value = number, boolean, or string. Allowed: riskPerTrade (0.5-10), riskDollarsPerTrade (10-10000), maxOpenTrades (1-10), autoTradeMinScore (30-95), autoTrade (bool), cooldownHours (0-168), defaultLeverage (1-20), minRiskReward (1-5), maxDailyLossPercent (0-20), autoTradeCoinsMode (tracked|tracked+top1|top1), riskMode (percent|dollar), autoMoveBreakeven (bool), autoTrailingStop (bool).
- run_backtest: days = 7 to 14. Runs historical simulation.
- open_trade: coinId = coin id (e.g. ethereum, solana), direction = LONG or SHORT. Opens a new trade using the signal from liveSignals or top3MarketScan. Only use coins that have an actionable signal (BUY/STRONG_BUY for LONG, SELL/STRONG_SELL for SHORT) in the context.
- close_trade: tradeId = id of open trade. Closes the entire position.
- reduce_position: tradeId = id of open trade, percent = 10-99 (how much to close). Reduces position size.
- exclude_coin: coinId = coin id. Excludes from auto-trade.
- include_coin: coinId = coin id. Re-includes in auto-trade.
- move_stop_loss: tradeId = id of open trade, stopLoss = new stop price (number). LONG: stop below entry. SHORT: stop above entry.
- move_to_breakeven: tradeId = id of open trade. Moves stop to entry (with fee buffer).
- update_take_profit: tradeId = id of open trade, takeProfit1/takeProfit2/takeProfit3 = new TP prices (provide at least one). LONG: TPs above entry. SHORT: TPs below entry.

If no changes needed, use "actions": [].
When opening: use open_trade when a coin has BUY/STRONG_BUY (for LONG) or SELL/STRONG_SELL (for SHORT), score >= autoTradeMinScore, and you have capacity. Only close or reduce when the trade is clearly against you or risk management demands it.`;

  const promptParts = [
    `Current state:`,
    `- Balance: $${ctx.balance} (initial $${ctx.initialBalance})`,
    `- Stats: ${JSON.stringify(ctx.stats)}`,
    `- Open trades (${ctx.openTradesCount}): ${JSON.stringify(ctx.openTrades)}`,
    `- Recent trades (last ${ctx.recentTrades.length}): ${JSON.stringify(ctx.recentTrades)}`,
    `- Current settings: riskPerTrade=${ctx.settings.riskPerTrade}, riskDollarsPerTrade=${ctx.settings.riskDollarsPerTrade}, maxOpenTrades=${ctx.settings.maxOpenTrades}, autoTradeMinScore=${ctx.settings.autoTradeMinScore}, autoTrade=${ctx.settings.autoTrade}`,
    ctx.lastBacktest ? `- Last backtest: ${JSON.stringify(ctx.lastBacktest)}` : '- No backtest run yet.'
  ];

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

  if (ctx.marketPulse) {
    const mp = ctx.marketPulse;
    const fg = mp.fearGreed;
    const g = mp.global || {};
    promptParts.push(`- Market Pulse: Fear & Greed ${fg?.value ?? 'N/A'} (${fg?.classification ?? 'N/A'}), BTC dom ${g.btcDominance != null ? g.btcDominance.toFixed(1) + '%' : 'N/A'}, ETH dom ${g.ethDominance != null ? g.ethDominance.toFixed(1) + '%' : 'N/A'}, mcap 24h ${g.marketCapChange24h != null ? (g.marketCapChange24h >= 0 ? '+' : '') + g.marketCapChange24h.toFixed(2) + '%' : 'N/A'}`);
  }
  if (ctx.liveSignals && ctx.liveSignals.length > 0) {
    promptParts.push(`- Live signals (tracked coins, top ${ctx.liveSignals.length}): ${JSON.stringify(ctx.liveSignals)}`);
    const actionable = ctx.liveSignals.filter(s => ['BUY', 'STRONG_BUY', 'SELL', 'STRONG_SELL'].includes(s.signal));
    if (actionable.length > 0) {
      promptParts.push(`- Actionable for open_trade (use coinId + direction LONG for BUY/STRONG_BUY, SHORT for SELL/STRONG_SELL): ${JSON.stringify(actionable.map(s => ({ coinId: s.coinId, symbol: s.symbol, signal: s.signal, score: s.score, direction: (s.signal === 'BUY' || s.signal === 'STRONG_BUY') ? 'LONG' : 'SHORT' })))}`);
    }
  }
  if (ctx.top3MarketScan && ctx.top3MarketScan.length > 0) {
    const top3 = ctx.top3MarketScan.map(s => ({
      coinId: s.coin?.id || s.coinData?.id,
      symbol: s.coin?.symbol || s.coinData?.symbol,
      signal: s.signal,
      score: s.score,
      regime: s.regime,
      strategyName: s.strategyName,
      entry: s.entry,
      stopLoss: s.stopLoss,
      takeProfit1: s.takeProfit1,
      riskReward: s.riskReward,
      direction: ['BUY', 'STRONG_BUY'].includes(s.signal) ? 'LONG' : ['SELL', 'STRONG_SELL'].includes(s.signal) ? 'SHORT' : null
    }));
    promptParts.push(`- Top 3 from 80-coin market scan (use coinId + direction for open_trade when signal is BUY/STRONG_BUY or SELL/STRONG_SELL): ${JSON.stringify(top3)}`);
  }
  if (ctx.scoreHistory && Object.keys(ctx.scoreHistory).length > 0) {
    promptParts.push(`- Score history (recent): ${JSON.stringify(ctx.scoreHistory)}`);
  }
  if (ctx.regimeTimeline && ctx.regimeTimeline.length > 0) {
    promptParts.push(`- Regime timeline (recent): ${JSON.stringify(ctx.regimeTimeline)}`);
  }
  if (user.excludedCoins && user.excludedCoins.length > 0) {
    promptParts.push(`- Excluded coins: ${JSON.stringify(user.excludedCoins)}`);
  }

  if (opts.userRequest) {
    promptParts.push(`\nUser request: "${opts.userRequest}"\n\nTake the appropriate actions. Use tradeId from open trades above. Reply with JSON only.`);
  } else {
    promptParts.push(`\nReview open trades, live signals, and performance. Should we OPEN any new trades (if signals are strong and under maxOpenTrades), close any, reduce any, move stops, change settings, exclude/include coins, or run a backtest? When signals have BUY/STRONG_BUY or SELL/STRONG_SELL and score >= autoTradeMinScore, consider open_trade. Reply with JSON only.`);
  }

  const prompt = promptParts.join('\n');

  let text;
  try {
    text = await callAgent(prompt, systemPrompt, ollamaUrl, model);
  } catch (err) {
    const failResult = { success: false, error: err.message, at: new Date() };
    await saveAgentLog(userId, failResult, opts);
    return failResult;
  }

  const parsed = parseJsonResponse(text);
  if (!parsed || !Array.isArray(parsed.actions)) {
    const failResult = { success: false, error: 'Invalid LLM response', raw: text?.slice(0, 200), at: new Date() };
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
