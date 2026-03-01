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
- SMC setups: run setup_backtest(coinId, setupId, days, timeframe) or scan_setups(setupId) to find active setups

When analyzing trades or signals, consider ALL factors:
- Score AND confidence (high score + low confidence = unreliable)
- Score breakdown by dimension (are all aligned or carried by one?)
- Timeframe alignment (1H/4H/1D agreement)
- Strategy performance in current regime
- Action badges on trades (what's already happened)
- Market conditions (Fear & Greed, BTC correlation)

Answer questions about the market, trades, strategies, weights, features, and platform. Be concise but helpful. Use the context provided.
When asked about open trades, list them from the "Open trades" section. When asked about performance, use the Stats and Balance data.
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
  const model = user.settings?.ollamaModel || 'llama3.1:8b';

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
  // Cap context to ~8k chars (5k was too aggressive, cut off trades)
  const systemContentTrimmed = systemContent.length > 8000 ? systemContent.slice(0, 8000) + '\n...[truncated]' : systemContent;

  const fullMessages = [
    { role: 'system', content: systemContentTrimmed },
    ...messages.slice(-10)
  ];

  try {
    let text = await chat(fullMessages, ollamaUrl, model, ollamaApiKey);
    if (!text || !text.trim()) {
      console.warn('[LLMChat] Empty response, raw length:', fullMessages.reduce((a, m) => a + (m.content?.length || 0), 0), 'chars input');
    }
    const result = { success: true };
    let displayText = (text && text.trim()) || '';
    if (opts.executeActions && messages.length > 0) {
      const lastUser = messages.filter(m => m.role === 'user').pop();
      const userRequest = lastUser?.content?.trim();
      if (userRequest) {
        try {
          if (!displayText) displayText = 'Executing your request...';
          await new Promise(r => setTimeout(r, 2000));
          const agentResult = await runAgent(userId, deps, { userRequest, source: 'chat' });
          if (agentResult?.success && displayText === 'Executing your request...') {
            const actions = agentResult.actionsExecuted?.map(a => a.message).filter(Boolean);
            displayText = actions?.length ? actions.join('; ') : (agentResult.reasoning || 'Done.');
          }
          result.agentResult = agentResult;
        } catch (agentErr) {
          result.agentError = agentErr.message;
          if (!displayText) displayText = 'Agent error: ' + agentErr.message;
        }
      }
    }
    result.text = displayText || '(No response)';

    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function buildContextBlock(ctx, pulse) {
  const parts = [];

  // Open trades first (most important for "close trade" etc.)
  if (ctx.openTradesCount > 0) {
    parts.push(`Open trades (${ctx.openTradesCount}):`);
    ctx.openTrades.forEach(t => {
      const badgeStr = t.badges?.length > 0 ? (t.badges.length > 3 ? `${t.badges[0]} x${t.badges.length}` : t.badges.join(',')) : '';
      const tradeParts = [
        `${t.symbol} ${t.direction} @ $${t.entryPrice?.toFixed(2)}`,
        `P&L: $${(t.pnl || 0).toFixed(2)} (${(t.pnlPercent || 0).toFixed(1)}%)`,
        `Score: ${t.score}`
      ];
      if (badgeStr) tradeParts.push(`Badges: ${badgeStr}`);
      if (t.stopLoss) tradeParts.push(`SL: $${t.stopLoss.toFixed(2)}`);
      parts.push(`  ${tradeParts.join(' | ')}`);
    });
    parts.push('');
  }

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

  // Live signals with compact breakdown + indicators
  if (ctx.liveSignals && ctx.liveSignals.length > 0) {
    parts.push('Live signals (top 5):');
    ctx.liveSignals.slice(0, 5).forEach(s => {
      const bd = s.scoreBreakdown ? ` [${[s.scoreBreakdown.trend,s.scoreBreakdown.momentum,s.scoreBreakdown.volume,s.scoreBreakdown.structure].map(v=>v??'?').join(',')}]` : '';
      const ind = s.indicators ? ` RSI=${s.indicators.rsi?.toFixed(0)??'?'} ADX=${s.indicators.adx?.toFixed(0)??'?'}` : '';
      parts.push(`  ${s.symbol} ${s.signal} ${s.score} conf=${s.confidence??'?'} RR=${s.riskReward?.toFixed(2)??'?'}${bd}${ind}`);
    });
    parts.push('');
  }

  // Strategy weights (compact)
  if (ctx.strategyWeights && ctx.strategyWeights.length > 0) {
    parts.push('Strategy perf: ' + ctx.strategyWeights.slice(0, 5).map(sw => `${sw.strategyId}: ${sw.performance?.totalTrades ?? 0}t WR=${(sw.performance?.winRate ?? 0).toFixed(0)}%`).join('; '));
  }

  // Last backtest (one line)
  if (ctx.lastBacktest) {
    parts.push(`Backtest: ${ctx.lastBacktest.days}d ${ctx.lastBacktest.totalTrades}t WR=${ctx.lastBacktest.winRate}% PnL=${ctx.lastBacktest.totalPnlPercent}%`);
  }

  // Features on/off
  if (ctx.featureToggles) {
    const on = Object.entries(ctx.featureToggles).filter(([, v]) => v === true).map(([k]) => k).slice(0, 8);
    if (on.length) parts.push(`Features ON: ${on.join(', ')}`);
  }

  // Balance and stats (slimmed)
  parts.push(`Balance: $${(ctx.balance || 0).toLocaleString()} (return ${ctx.initialBalance > 0 ? ((ctx.balance - ctx.initialBalance) / ctx.initialBalance * 100).toFixed(1) : '0'}%)`);
  if (ctx.stats && (ctx.stats.wins != null || ctx.stats.totalTrades != null)) {
    parts.push(`Stats: ${ctx.stats.wins ?? 0}W/${ctx.stats.losses ?? 0}L, WR ${ctx.stats.winRate ?? 0}%, PnL $${(ctx.stats.totalPnl ?? 0).toFixed(0)}`);
  }

  // Recent closed (last 5)
  if (ctx.recentTrades && ctx.recentTrades.length) {
    parts.push('Recent closed:');
    ctx.recentTrades.slice(0, 5).forEach(t => {
      parts.push(`  ${t.symbol} ${t.direction} P&L: $${(t.pnl || 0).toFixed(0)} (${(t.pnlPercent || 0)?.toFixed(1)}%)`);
    });
    parts.push('');
  }

  // Settings (essential only)
  const s = ctx.settings || {};
  parts.push(`Settings: risk=${s.riskPerTrade ?? 2}%, maxTrades=${s.maxOpenTrades ?? 3}, minScore=${s.autoTradeMinScore ?? 55}, autoTrade=${s.autoTrade ?? false}, leverage=${s.defaultLeverage ?? 2}`);

  return parts.join('\n');
}

module.exports = { runChat };
