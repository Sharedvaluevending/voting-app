/**
 * LLM Chat - interactive chat with full platform context.
 * User can ask about markets, trades, strategies, indicators, weights, features, etc.
 * When executeActions is true, also runs the agent to execute the user's request.
 */

const { chat } = require('./ollama-client');
const { buildContext, runAgent } = require('./llm-agent');

const CHAT_SYSTEM = `You are a crypto trading assistant with FULL access to this user's trading platform. You can see:
- Market data: Fear & Greed, BTC/ETH dominance, market cap change, volume
- Live signals: current scores, CONFIDENCE levels, score breakdowns (trend/momentum/volume/structure/volatility/riskQuality), per-timeframe scores, indicators, and engine reasoning
- User's open trades with live P&L, action badges (BE=breakeven, TS=trailing stop, LOCK=profit locked, PP=partial profit, RP=reduced position, DCA=averaged), stops, TPs, and time held
- Recent closed trades (extended history with close reasons and badges)
- Performance stats (win rate, total PnL, drawdown, by strategy/regime)
- Strategy weights from the learning engine (7 strategies with dimension weights and regime-specific performance)
- ALL feature toggles and their current state (on/off for each trading feature)
- Coin weights (allocation boost/reduction per coin)
- Score history for key coins
- Regime timeline
- Current settings (risk, max trades, min score, auto-trade mode, leverage, etc.)
- Last backtest results if any

When analyzing trades or signals, consider ALL factors:
- Score AND confidence (high score + low confidence = unreliable)
- Score breakdown by dimension (are all aligned or carried by one?)
- Timeframe alignment (1H/4H/1D agreement)
- Strategy performance in current regime
- Action badges on trades (what's already happened)
- Market conditions (Fear & Greed, BTC correlation)

Answer questions about the market, trades, strategies, weights, features, and platform. Be concise but helpful. Use the context provided.
When the user asks to move stops, close trades, change settings, toggle features, adjust weights, etc., you can tell them to use "Execute actions" - or if they have it enabled, the agent will run and perform the actions.`;

/**
 * Run chat for a user. messages = [{role, content}, ...] (user + assistant history)
 */
async function runChat(userId, messages, deps, opts = {}) {
  const { User, Trade, getPerformanceStats, fetchLivePrice, getMarketPulse } = deps;
  const user = await User.findById(userId);
  if (!user) return { success: false, error: 'User not found' };

  const ollamaUrl = user.settings?.ollamaUrl || 'http://localhost:11434';
  const ollamaApiKey = user.settings?.ollamaApiKey || '';
  const model = user.settings?.ollamaModel || 'qwen3-coder:480b-cloud';

  const extraDeps = (deps.fetchAllPrices && deps.buildEngineOptions && deps.analyzeAllCoins)
    ? {
        fetchAllPrices: deps.fetchAllPrices,
        fetchAllCandles: deps.fetchAllCandles,
        fetchAllHistory: deps.fetchAllHistory,
        buildEngineOptions: deps.buildEngineOptions,
        analyzeAllCoins: deps.analyzeAllCoins,
        getScoreHistory: deps.getScoreHistory,
        getRegimeTimeline: deps.getRegimeTimeline,
        getMarketPulse: deps.getMarketPulse,
        getTop3FullCached: deps.getTop3FullCached
      }
    : null;

  let ctx;
  try {
    ctx = await buildContext(user, User, Trade, getPerformanceStats, fetchLivePrice, extraDeps);
  } catch (e) {
    ctx = { balance: 0, stats: {}, openTrades: [], recentTrades: [], settings: {}, lastBacktest: null };
  }

  let pulse = null;
  try {
    pulse = await getMarketPulse();
  } catch (e) { /* ignore */ }

  const contextBlock = buildContextBlock(ctx, pulse);
  const systemContent = CHAT_SYSTEM + '\n\n---\nCurrent platform context (use this to answer):\n' + contextBlock;

  const fullMessages = [
    { role: 'system', content: systemContent },
    ...messages
  ];

  try {
    const text = await chat(fullMessages, ollamaUrl, model, ollamaApiKey);
    const result = { success: true, text: text || '(No response)' };

    if (opts.executeActions && messages.length > 0) {
      const lastUser = messages.filter(m => m.role === 'user').pop();
      const userRequest = lastUser?.content?.trim();
      if (userRequest) {
        try {
          // Brief pause so server can release resources before next LLM request
          await new Promise(r => setTimeout(r, 2000));
          const agentResult = await runAgent(userId, deps, { userRequest, source: 'chat' });
          result.agentResult = agentResult;
        } catch (agentErr) {
          result.agentError = agentErr.message;
        }
      }
    }

    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function buildContextBlock(ctx, pulse) {
  const parts = [];

  // Market pulse
  if (pulse) {
    const fg = pulse.fearGreed;
    const g = pulse.global || {};
    parts.push('Market:');
    if (fg && fg.value != null) parts.push(`  Fear & Greed: ${fg.value} (${fg.classification || 'N/A'})`);
    if (g.btcDominance != null) parts.push(`  BTC dominance: ${g.btcDominance.toFixed(1)}%`);
    if (g.ethDominance != null) parts.push(`  ETH dominance: ${g.ethDominance.toFixed(1)}%`);
    if (g.marketCapChange24h != null) parts.push(`  Market cap 24h: ${g.marketCapChange24h >= 0 ? '+' : ''}${g.marketCapChange24h.toFixed(2)}%`);
    if (g.volumeChange24h != null) parts.push(`  Volume 24h: ${g.volumeChange24h >= 0 ? '+' : ''}${g.volumeChange24h.toFixed(1)}%`);
    parts.push('');
  }

  // Live signals with full detail
  if (ctx.liveSignals && ctx.liveSignals.length > 0) {
    parts.push('Live signals:');
    ctx.liveSignals.slice(0, 10).forEach(s => {
      const sigParts = [`${s.symbol} ${s.signal} score=${s.score}`];
      if (s.confidence != null) sigParts.push(`conf=${s.confidence}`);
      sigParts.push(`regime=${s.regime || 'N/A'} strategy=${s.strategyName || 'N/A'}`);
      if (s.riskReward != null) sigParts.push(`RR=${s.riskReward.toFixed(2)}`);
      if (s.scoreBreakdown) sigParts.push(`breakdown=${JSON.stringify(s.scoreBreakdown)}`);
      if (s.timeframes) sigParts.push(`TFs=${JSON.stringify(s.timeframes)}`);
      if (s.reasoning) sigParts.push(`why: ${s.reasoning}`);
      parts.push(`  ${sigParts.join(' | ')}`);
    });
    parts.push('');
  }

  // Balance and stats
  parts.push(`Balance: $${(ctx.balance || 0).toLocaleString()} (initial $${(ctx.initialBalance || 0).toLocaleString()}, return ${ctx.initialBalance > 0 ? ((ctx.balance - ctx.initialBalance) / ctx.initialBalance * 100).toFixed(2) : '0'}%)`);
  if (ctx.stats && Object.keys(ctx.stats).length) {
    parts.push('Stats: ' + JSON.stringify(ctx.stats));
  }
  if (ctx.stats?.riskByStrategyRegime) {
    const rbr = ctx.stats.riskByStrategyRegime;
    if (Object.keys(rbr.byStrategy || {}).length || Object.keys(rbr.byRegime || {}).length) {
      parts.push('By strategy: ' + JSON.stringify(rbr.byStrategy || {}));
      parts.push('By regime: ' + JSON.stringify(rbr.byRegime || {}));
    }
  }

  // Open trades with badges
  if (ctx.openTradesCount > 0) {
    parts.push(`\nOpen trades (${ctx.openTradesCount}):`);
    ctx.openTrades.forEach(t => {
      const tradeParts = [
        `${t.symbol} ${t.direction} @ $${t.entryPrice?.toFixed(2)}`,
        `P&L: $${(t.pnl || 0).toFixed(2)} (${(t.pnlPercent || 0).toFixed(1)}%)`,
        `Score: ${t.score}`
      ];
      if (t.llmConfidence) tradeParts.push(`LLM_conf: ${t.llmConfidence}`);
      if (t.badges && t.badges.length > 0) tradeParts.push(`Badges: [${t.badges.join(',')}]`);
      if (t.timeHeld) tradeParts.push(`Held: ${t.timeHeld}`);
      if (t.stopLoss) tradeParts.push(`SL: $${t.stopLoss.toFixed(2)}`);
      parts.push(`  ${tradeParts.join(' | ')}`);
    });
    parts.push('');
  }

  // Recent closed trades
  if (ctx.recentTrades && ctx.recentTrades.length) {
    parts.push('Recent closed:');
    ctx.recentTrades.slice(0, 10).forEach(t => {
      const closeParts = [`${t.symbol} ${t.direction} P&L: $${(t.pnl || 0).toFixed(2)} (${(t.pnlPercent || 0)?.toFixed(1)}%)`];
      if (t.closeReason) closeParts.push(`reason: ${t.closeReason}`);
      if (t.badges && t.badges.length > 0) closeParts.push(`badges: [${t.badges.join(',')}]`);
      parts.push(`  ${closeParts.join(' | ')}`);
    });
    parts.push('');
  }

  // Strategy weights from learning engine
  if (ctx.strategyWeights && ctx.strategyWeights.length > 0) {
    parts.push('Strategy Weights (learning engine):');
    for (const sw of ctx.strategyWeights) {
      const p = sw.performance;
      parts.push(`  ${sw.strategyId}: W=${JSON.stringify(sw.weights)} | ${p.totalTrades}trades WR=${(p.winRate || 0).toFixed(1)}% PF=${(p.profitFactor || 0).toFixed(2)} byRegime=${JSON.stringify(p.byRegime)}`);
    }
    parts.push('');
  }

  // Feature toggles
  if (ctx.featureToggles) {
    const on = Object.entries(ctx.featureToggles).filter(([, v]) => v === true).map(([k]) => k);
    const off = Object.entries(ctx.featureToggles).filter(([, v]) => v === false).map(([k]) => k);
    parts.push(`Features ON: ${on.join(', ') || 'none'}`);
    parts.push(`Features OFF: ${off.join(', ') || 'none'}`);
  }

  // Coin weights
  if (ctx.coinWeights) {
    parts.push(`Coin Weights (${ctx.coinWeights.strength}): ${JSON.stringify(ctx.coinWeights.weights)}`);
  }

  // Score and regime history
  if (ctx.scoreHistory && Object.keys(ctx.scoreHistory).length > 0) {
    parts.push('Score history (recent): ' + JSON.stringify(ctx.scoreHistory));
  }
  if (ctx.regimeTimeline && ctx.regimeTimeline.length > 0) {
    parts.push('Regime timeline: ' + JSON.stringify(ctx.regimeTimeline.slice(-3)));
  }

  // Settings
  const s = ctx.settings || {};
  parts.push(`\nSettings: riskPerTrade=${s.riskPerTrade ?? 2}%, riskMode=${s.riskMode || 'percent'}, maxOpenTrades=${s.maxOpenTrades ?? 3}, autoTradeMinScore=${s.autoTradeMinScore ?? 55}, autoTrade=${s.autoTrade ?? false}, cooldownHours=${s.cooldownHours ?? 6}, defaultLeverage=${s.defaultLeverage ?? 2}, tpMode=${s.tpMode || 'fixed'}, minRiskReward=${s.minRiskReward ?? 1.2}`);

  if (ctx.lastBacktest) {
    parts.push(`Last backtest: ${ctx.lastBacktest.days}d, ${ctx.lastBacktest.totalTrades} trades, WR ${ctx.lastBacktest.winRate}%, PnL ${ctx.lastBacktest.totalPnlPercent}%`);
  }

  return parts.join('\n');
}

module.exports = { runChat };
