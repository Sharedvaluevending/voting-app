/**
 * LLM Chat - interactive chat with full platform context.
 * User can ask about markets, trades, strategies, indicators, etc.
 * When executeActions is true, also runs the agent to execute the user's request.
 */

const { chat } = require('./ollama-client');
const { buildContext, runAgent } = require('./llm-agent');

const CHAT_SYSTEM = `You are a crypto trading assistant with full access to this user's trading platform. You can see:
- Market data: Fear & Greed, BTC/ETH dominance, market cap change, volume
- Live signals: current scores, regimes, strategies for tracked coins
- User's open trades with live P&L (each has tradeId for actions)
- Recent closed trades (extended history)
- Performance stats (win rate, total PnL, drawdown, by strategy/regime)
- Score history for key coins
- Regime timeline
- Current settings (risk, max trades, min score, auto-trade mode)
- Last backtest results if any

Answer questions about the market, trades, strategies, and platform. Be concise but helpful. Use the context provided.
When the user asks to move stops, close trades, change settings, etc., you can tell them to use "Execute actions" - or if they have it enabled, the agent will run and perform the actions.`;

/**
 * Run chat for a user. messages = [{role, content}, ...] (user + assistant history)
 * @param {string} userId
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} deps - { User, Trade, getPerformanceStats, fetchLivePrice, getMarketPulse, ... }
 * @param {Object} [opts] - { executeActions?: boolean } - when true, run agent with last user message
 * @returns {Promise<{success: boolean, text?: string, agentResult?: Object, error?: string}>}
 */
async function runChat(userId, messages, deps, opts = {}) {
  const { User, Trade, getPerformanceStats, fetchLivePrice, getMarketPulse } = deps;
  const user = await User.findById(userId);
  if (!user) return { success: false, error: 'User not found' };

  const ollamaUrl = user.settings?.ollamaUrl || 'http://localhost:11434';
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
    const text = await chat(fullMessages, ollamaUrl, model);
    const result = { success: true, text: text || '(No response)' };

    if (opts.executeActions && messages.length > 0) {
      const lastUser = messages.filter(m => m.role === 'user').pop();
      const userRequest = lastUser?.content?.trim();
      if (userRequest) {
        try {
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

  if (ctx.liveSignals && ctx.liveSignals.length > 0) {
    parts.push('Live signals (top coins):');
    ctx.liveSignals.slice(0, 8).forEach(s => {
      parts.push(`  ${s.symbol} ${s.signal} score=${s.score} regime=${s.regime || 'N/A'} strategy=${s.strategyName || 'N/A'}`);
    });
    parts.push('');
  }

  parts.push(`Balance: $${(ctx.balance || 0).toLocaleString()} (initial $${(ctx.initialBalance || 0).toLocaleString()})`);
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

  if (ctx.openTradesCount > 0) {
    parts.push(`Open trades (${ctx.openTradesCount}):`);
    ctx.openTrades.forEach(t => {
      parts.push(`  ${t.symbol} ${t.direction} @ $${t.entryPrice?.toFixed(2)} | P&L: $${(t.pnl || 0).toFixed(2)} (${(t.pnlPercent || 0).toFixed(1)}%) | Score: ${t.score}`);
    });
    parts.push('');
  }

  if (ctx.recentTrades && ctx.recentTrades.length) {
    parts.push('Recent closed:');
    ctx.recentTrades.slice(0, 10).forEach(t => {
      parts.push(`  ${t.symbol} ${t.direction} P&L: $${(t.pnl || 0).toFixed(2)} (${(t.pnlPercent || 0)?.toFixed(1)}%)`);
    });
    parts.push('');
  }

  if (ctx.scoreHistory && Object.keys(ctx.scoreHistory).length > 0) {
    parts.push('Score history (recent): ' + JSON.stringify(ctx.scoreHistory));
  }
  if (ctx.regimeTimeline && ctx.regimeTimeline.length > 0) {
    parts.push('Regime timeline: ' + JSON.stringify(ctx.regimeTimeline.slice(-3)));
  }

  const s = ctx.settings || {};
  parts.push(`Settings: riskPerTrade=${s.riskPerTrade ?? 2}%, maxOpenTrades=${s.maxOpenTrades ?? 3}, autoTradeMinScore=${s.autoTradeMinScore ?? 55}, autoTrade=${s.autoTrade ?? false}`);

  if (ctx.lastBacktest) {
    parts.push(`Last backtest: ${ctx.lastBacktest.days}d, ${ctx.lastBacktest.totalTrades} trades, WR ${ctx.lastBacktest.winRate}%, PnL ${ctx.lastBacktest.totalPnlPercent}%`);
  }

  return parts.join('\n');
}

module.exports = { runChat };
