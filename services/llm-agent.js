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
  'featureConfidenceSizing', 'featureKellySizing', 'minRiskRewardEnabled', 'dcaEnabled'
];

/**
 * Call Ollama with agent prompt.
 */
function isNgrokUrl(url) {
  return url && (url.includes('ngrok-free') || url.includes('ngrok.io'));
}

async function callAgent(prompt, systemPrompt, baseUrl, model) {
  const base = baseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json' };
  if (isNgrokUrl(base)) headers['ngrok-skip-browser-warning'] = 'true';

  const generateBody = { model: model || 'llama3.2', prompt: systemPrompt + '\n\n' + prompt };
  const chatBody = {
    model: model || 'llama3.2',
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
  };

  let res;
  if (isNgrokUrl(base)) {
    res = await fetch(base + '/api/generate', { method: 'POST', headers, body: JSON.stringify(generateBody), signal: controller.signal });
    if (res.status === 404) {
      res = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
    }
  } else {
    res = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify(chatBody), signal: controller.signal });
    if (res.status === 404) {
      res = await fetch(base + '/api/generate', { method: 'POST', headers, body: JSON.stringify(generateBody), signal: controller.signal });
    }
  }

  clearTimeout(timeout);
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return data.message?.content || data.response || '';
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
 */
async function buildContext(user, User, Trade, getPerformanceStats, fetchLivePrice) {
  const stats = await getPerformanceStats(user._id);
  const openTradesRaw = await Trade.find({ userId: user._id, status: 'OPEN' }).lean();
  const recentTrades = await Trade.find({ userId: user._id, status: { $ne: 'OPEN' } })
    .sort({ exitTime: -1 }).limit(10).lean();

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
      entryTime: t.entryTime
    });
  }

  return {
    balance: user.paperBalance ?? 10000,
    initialBalance: user.initialBalance ?? 10000,
    stats: stats || {},
    openTrades,
    openTradesCount: openTrades.length,
    recentTrades: recentTrades.map(t => ({
      symbol: t.symbol,
      direction: t.direction,
      pnl: t.pnl,
      pnlPercent: t.pnlPercent,
      status: t.status
    })),
    settings: user.settings || {},
    lastBacktest: user.llmAgentLastBacktest || null
  };
}

/**
 * Execute a single action. Returns { ok, message }.
 */
async function executeAction(action, user, deps) {
  const { tool, key, value } = action;
  const { User, Trade, runBacktest, closeTrade, closeTradePartial, fetchLivePrice } = deps;

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

  return { ok: false, message: `Unknown tool: ${tool}` };
}

/**
 * Run the LLM agent for a user.
 * @returns {Object} { success, actionsExecuted, actionsFailed, reasoning }
 */
async function runAgent(userId, deps) {
  const { User, Trade, runBacktest, getPerformanceStats } = deps;
  const user = await User.findById(userId);
  if (!user) return { success: false, error: 'User not found' };

  const ollamaUrl = user.settings?.ollamaUrl || 'http://localhost:11434';
  const model = user.settings?.ollamaModel || 'llama3.2';

  const ctx = await buildContext(user, User, Trade, getPerformanceStats, deps.fetchLivePrice);

  const systemPrompt = `You are an autonomous crypto trading assistant. You can change settings, run backtests, monitor open trades, close them, or reduce positions.

Reply ONLY with valid JSON in this exact format (no other text):
{
  "reasoning": "Brief explanation of what you're doing and why",
  "actions": [
    { "tool": "change_setting", "key": "settingName", "value": numberOrBoolean },
    { "tool": "run_backtest", "days": 14 },
    { "tool": "close_trade", "tradeId": "trade_id_string" },
    { "tool": "reduce_position", "tradeId": "trade_id_string", "percent": 50 }
  ]
}

Available tools:
- change_setting: key = setting name, value = number, boolean, or string. Allowed: riskPerTrade (0.5-10), riskDollarsPerTrade (10-10000), maxOpenTrades (1-10), autoTradeMinScore (30-95), autoTrade (bool), cooldownHours (0-168), defaultLeverage (1-20), minRiskReward (1-5), maxDailyLossPercent (0-20), autoTradeCoinsMode (tracked|tracked+top1|top1), riskMode (percent|dollar).
- run_backtest: days = 7 to 14. Runs historical simulation.
- close_trade: tradeId = id of open trade. Closes the entire position.
- reduce_position: tradeId = id of open trade, percent = 10-99 (how much to close). Reduces position size.

If no changes needed, use "actions": [].
Be conservative. Only close or reduce when the trade is clearly against you or risk management demands it.`;

  const prompt = `Current state:
- Balance: $${ctx.balance} (initial $${ctx.initialBalance})
- Stats: ${JSON.stringify(ctx.stats)}
- Open trades (${ctx.openTradesCount}): ${JSON.stringify(ctx.openTrades)}
- Recent trades: ${JSON.stringify(ctx.recentTrades)}
- Current settings (relevant): riskPerTrade=${ctx.settings.riskPerTrade}, riskDollarsPerTrade=${ctx.settings.riskDollarsPerTrade}, maxOpenTrades=${ctx.settings.maxOpenTrades}, autoTradeMinScore=${ctx.settings.autoTradeMinScore}, autoTrade=${ctx.settings.autoTrade}
${ctx.lastBacktest ? `- Last backtest (${ctx.lastBacktest.at}): ${JSON.stringify(ctx.lastBacktest)}` : '- No backtest run yet.'}

Review open trades. Should we close any, reduce any, change settings, or run a backtest? Reply with JSON only.`;

  let text;
  try {
    text = await callAgent(prompt, systemPrompt, ollamaUrl, model);
  } catch (err) {
    return { success: false, error: err.message };
  }

  const parsed = parseJsonResponse(text);
  if (!parsed || !Array.isArray(parsed.actions)) {
    return { success: false, error: 'Invalid LLM response', raw: text?.slice(0, 200) };
  }

  const actionsExecuted = [];
  const actionsFailed = [];
  for (const action of parsed.actions) {
    if (!action.tool) continue;
    const result = await executeAction(action, user, deps);
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

  return runResult;
}

module.exports = {
  runAgent,
  SETTING_BOUNDS,
  BOOLEAN_SETTINGS
};
