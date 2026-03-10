const fetch = require('node-fetch');
const Trade = require('../models/Trade');
const User = require('../models/User');
const SystemConfig = require('../models/SystemConfig');

const CONFIG_KEY = 'free_signal_discord';
const DEFAULTS = {
  enabled: false,
  webhookUrl: '',
  coinId: 'fantom',
  paperUserId: '',
  cooldownMinutes: 60,
  updateIntervalMinutes: 15,
  includeActionBadges: true,
  // Position-first mode: prefer lifecycle updates for an actual open trade.
  positionFirstMode: true,
  // Optional fallback while flat (no open trade).
  postWhenNoOpenTrade: false,
  state: {
    lastDigest: '',
    lastUpdateAt: null,
    lastCooldownTradeId: '',
    lastSignalDigest: '',
    lastActionTradeId: '',
    lastActionCount: 0
  }
};

function num(v, digits) {
  if (!Number.isFinite(v)) return 'N/A';
  const d = Number.isFinite(digits) ? digits : (Math.abs(v) >= 1 ? 4 : 6);
  return Number(v).toFixed(d);
}

function compactLines(lines, max = 4) {
  return (Array.isArray(lines) ? lines : [])
    .filter(Boolean)
    .slice(0, max)
    .map((x) => `- ${String(x).trim()}`)
    .join('\n');
}

function bullets(lines) {
  return (Array.isArray(lines) ? lines : [])
    .filter(Boolean)
    .map((x) => `- ${String(x).trim()}`)
    .join('\n');
}

function chunkText(text, maxLen = 3600) {
  const out = [];
  const s = String(text || '').trim();
  if (!s) return out;
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + maxLen));
    i += maxLen;
  }
  return out;
}

function tfSummary(timeframes) {
  if (!timeframes || typeof timeframes !== 'object') return 'N/A';
  const keys = ['15m', '1H', '4H', '1D', '1W'];
  const parts = [];
  for (const k of keys) {
    const t = timeframes[k];
    if (!t) continue;
    parts.push(`${k}: ${t.signal || '-'} (${t.score ?? 0})`);
  }
  return parts.length ? parts.join(' | ').slice(0, 1024) : 'N/A';
}

function topStrategiesSummary(topStrategies) {
  if (!Array.isArray(topStrategies) || topStrategies.length === 0) return 'N/A';
  return topStrategies.slice(0, 8).map((s) => {
    const rr = Number.isFinite(s?.riskReward) ? `${num(s.riskReward, 2)}x` : 'N/A';
    return `${s?.name || s?.id || 'strategy'}: ${s?.signal || 'HOLD'} | fit ${s?.score ?? 0} | R:R ${rr}`;
  }).join('\n').slice(0, 1024);
}

function scoreBreakdownSummary(sb) {
  if (!sb || typeof sb !== 'object') return 'N/A';
  const map = [
    ['Trend', sb.trend, 20],
    ['Momentum', sb.momentum, 20],
    ['Volume', sb.volume, 20],
    ['Structure', sb.structure, 20],
    ['Volatility', sb.volatility, 10],
    ['Risk Quality', sb.riskQuality, 10]
  ];
  return map
    .filter((x) => Number.isFinite(x[1]))
    .map((x) => `${x[0]} ${x[1]}/${x[2]}`)
    .join(' | ')
    .slice(0, 1024) || 'N/A';
}

function indicatorsSummary(ind) {
  if (!ind || typeof ind !== 'object') return 'N/A';
  const pieces = [];
  if (ind.rsi != null) pieces.push(`RSI ${ind.rsi}`);
  if (ind.adx != null) pieces.push(`ADX ${ind.adx}`);
  if (ind.trend) pieces.push(`Trend ${ind.trend}`);
  if (ind.structure) pieces.push(`Structure ${ind.structure}`);
  if (ind.volumeTrend) pieces.push(`Volume ${ind.volumeTrend}`);
  if (ind.relativeVolume != null) pieces.push(`RelVol ${ind.relativeVolume}x`);
  if (ind.btcCorrelation != null) pieces.push(`BTC Corr ${(Number(ind.btcCorrelation) * 100).toFixed(0)}%`);
  if (ind.fundingRate != null) pieces.push(`Funding ${(Number(ind.fundingRate) * 100).toFixed(4)}%`);
  return pieces.join(' | ').slice(0, 1024) || 'N/A';
}

function digestString(parts) {
  return parts.map((x) => String(x ?? '')).join('|');
}

function signalToDirection(signalText) {
  const s = String(signalText || '').toUpperCase();
  if (s === 'BUY' || s === 'STRONG_BUY') return 'LONG';
  if (s === 'SELL' || s === 'STRONG_SELL') return 'SHORT';
  return null;
}

function entryBlockedPayload(symbol, reason, signal) {
  return {
    username: 'AlphaConfluence Free Signal',
    embeds: [{
      title: `🚫 ENTRY BLOCKED ${symbol}`,
      color: 0xf59e0b,
      fields: [
        { name: 'Signal', value: `${signal?.signal || 'N/A'} | score ${signal?.score ?? 0} | confidence ${signal?.confidence ?? 'N/A'}%`, inline: false },
        { name: 'Why no open trade', value: String(reason || 'No details').slice(0, 1024), inline: false }
      ],
      footer: { text: 'Position-first mode: signal seen, but trade open was blocked by safeguards' },
      timestamp: new Date().toISOString()
    }]
  };
}

async function getConfig() {
  const doc = await SystemConfig.findOne({ key: CONFIG_KEY }).lean();
  if (!doc || !doc.value || typeof doc.value !== 'object') return { ...DEFAULTS };
  return {
    ...DEFAULTS,
    ...doc.value,
    state: {
      ...(DEFAULTS.state || {}),
      ...(doc.value.state || {})
    }
  };
}

async function saveConfig(input) {
  const current = await getConfig();
  const next = {
    ...current,
    ...input,
    state: {
      ...(current.state || {}),
      ...((input && input.state) || {})
    }
  };

  if (next.cooldownMinutes == null || !Number.isFinite(Number(next.cooldownMinutes))) {
    next.cooldownMinutes = DEFAULTS.cooldownMinutes;
  }
  if (next.updateIntervalMinutes == null || !Number.isFinite(Number(next.updateIntervalMinutes))) {
    next.updateIntervalMinutes = DEFAULTS.updateIntervalMinutes;
  }
  next.cooldownMinutes = Math.max(5, Math.min(240, Number(next.cooldownMinutes)));
  next.updateIntervalMinutes = Math.max(5, Math.min(60, Number(next.updateIntervalMinutes)));
  next.coinId = String(next.coinId || DEFAULTS.coinId).trim() || DEFAULTS.coinId;
  next.webhookUrl = String(next.webhookUrl || '').trim();
  next.paperUserId = String(next.paperUserId || '').trim();
  next.enabled = !!next.enabled;
  next.includeActionBadges = next.includeActionBadges !== false;
  next.positionFirstMode = next.positionFirstMode !== false;
  next.postWhenNoOpenTrade = next.postWhenNoOpenTrade !== false;

  await SystemConfig.updateOne(
    { key: CONFIG_KEY },
    { $set: { value: next, updatedAt: new Date() } },
    { upsert: true }
  );
  return next;
}

async function postToDiscord(webhookUrl, payload) {
  if (!webhookUrl) return false;
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord webhook failed (${res.status}): ${text.slice(0, 180)}`);
  }
  return true;
}

function tradeMatchesConfig(trade, cfg) {
  if (!trade || !cfg) return false;
  if (String(trade.coinId || '').toLowerCase() !== String(cfg.coinId || '').toLowerCase()) return false;
  if (cfg.paperUserId && String(trade.userId) !== String(cfg.paperUserId)) return false;
  return true;
}

function tradeOpenPayload(trade) {
  const directionEmoji = trade.direction === 'LONG' ? '🟢 BUY OPEN' : '🔴 SELL OPEN';
  const why = bullets(trade.reasoning);
  const whyNot = bullets(trade.counterReasoning);
  const embeds = [{
    title: `${directionEmoji} ${trade.symbol} (${trade.direction})`,
    color: trade.direction === 'LONG' ? 0x10b981 : 0xef4444,
    fields: [
      { name: 'Entry', value: `$${num(trade.entryPrice)}`, inline: true },
      { name: 'Stop Loss', value: trade.stopLoss ? `$${num(trade.stopLoss)}` : 'N/A', inline: true },
      { name: 'TP1 / TP2 / TP3', value: `${trade.takeProfit1 ? `$${num(trade.takeProfit1)}` : 'N/A'} / ${trade.takeProfit2 ? `$${num(trade.takeProfit2)}` : 'N/A'} / ${trade.takeProfit3 ? `$${num(trade.takeProfit3)}` : 'N/A'}`, inline: false },
      { name: 'Score / Regime / Strategy', value: `${trade.score || 0} / ${trade.regime || 'unknown'} / ${trade.strategyType || 'N/A'}`, inline: false },
      { name: 'Stop/TP labels', value: `${trade.stopLabel || trade.stopType || 'N/A'} | ${trade.tpLabel || trade.tpType || 'N/A'}`, inline: false }
    ],
    footer: { text: 'Paper mode • Fantom free signal feed' },
    timestamp: new Date().toISOString()
  }];

  const whyChunks = chunkText(why || 'No reasoning captured.', 3800);
  whyChunks.forEach((chunk, i) => {
    if (embeds.length >= 8) return;
    embeds.push({
      title: i === 0 ? 'Why This Trade (Full)' : `Why This Trade (cont. ${i + 1})`,
      color: 0x10b981,
      description: chunk
    });
  });
  const whyNotChunks = chunkText(whyNot || 'No counter-signals captured.', 3800);
  whyNotChunks.forEach((chunk, i) => {
    if (embeds.length >= 10) return;
    embeds.push({
      title: i === 0 ? 'Why Not This Trade (Full)' : `Why Not This Trade (cont. ${i + 1})`,
      color: 0xef4444,
      description: chunk
    });
  });

  return {
    username: 'AlphaConfluence Free Signal',
    embeds
  };
}

function tradeClosePayload(trade) {
  const won = (trade.pnl || 0) >= 0;
  const pnlSign = won ? '+' : '';
  return {
    username: 'AlphaConfluence Free Signal',
    embeds: [{
      title: `✅ TRADE CLOSED ${trade.symbol} (${trade.direction})`,
      color: won ? 0x10b981 : 0xef4444,
      fields: [
        { name: 'Entry → Exit', value: `$${num(trade.entryPrice)} → $${num(trade.exitPrice)}`, inline: true },
        { name: 'PnL', value: `${pnlSign}$${num(trade.pnl, 2)} (${pnlSign}${num(trade.pnlPercent, 2)}%)`, inline: true },
        { name: 'Close reason', value: String(trade.closeReason || trade.status || 'CLOSED'), inline: true }
      ],
      footer: { text: 'Paper mode • Fantom free signal feed' },
      timestamp: new Date().toISOString()
    }]
  };
}

function actionBadgePayload(trade, action) {
  return {
    username: 'AlphaConfluence Free Signal',
    embeds: [{
      title: `🔔 TRADE UPDATE ${trade.symbol} ${action.type || ''}`,
      color: 0x3b82f6,
      fields: [
        { name: 'Action', value: String(action.type || 'UPDATE'), inline: true },
        { name: 'Price', value: Number.isFinite(action.marketPrice) ? `$${num(action.marketPrice)}` : 'N/A', inline: true },
        { name: 'Details', value: String(action.description || 'No details').slice(0, 1024), inline: false }
      ],
      footer: { text: 'Action badge update' },
      timestamp: new Date().toISOString()
    }]
  };
}

function cooldownPayload(symbol, cooldownMinutes) {
  return {
    username: 'AlphaConfluence Free Signal',
    embeds: [{
      title: '⏳ COOLDOWN ACTIVE',
      color: 0xf59e0b,
      description: `${symbol} is in cooldown for ${cooldownMinutes} minutes before next entry.`,
      footer: { text: 'No immediate re-entry until cooldown ends' },
      timestamp: new Date().toISOString()
    }]
  };
}

function summarizeActionBadges(actions) {
  const arr = Array.isArray(actions) ? actions : [];
  if (arr.length === 0) return 'None yet';
  const counts = {};
  for (const a of arr) {
    const k = String(a?.type || '').trim();
    if (!k) continue;
    counts[k] = (counts[k] || 0) + 1;
  }
  const order = ['BE', 'TS', 'LOCK', 'DCA', 'PP', 'RP', 'EXIT', 'LLM_SL', 'TP1', 'TP2', 'TP3', 'SL'];
  const keys = Object.keys(counts).sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return keys.map((k) => `${k}:${counts[k]}`).join(' | ').slice(0, 1024);
}

function calcUnrealized(trade, currentPrice) {
  const entry = Number(trade?.entryPrice || 0);
  const size = Number(trade?.positionSize || 0);
  const margin = Number(trade?.margin || 0);
  const dir = String(trade?.direction || '');
  const price = Number(currentPrice || 0);
  if (!(entry > 0) || !(size > 0) || !(price > 0) || (dir !== 'LONG' && dir !== 'SHORT')) {
    return { pnl: 0, pnlPercent: 0 };
  }
  const raw = dir === 'LONG'
    ? ((price - entry) / entry) * size
    : ((entry - price) / entry) * size;
  const fees = Number(trade?.fees || 0);
  const pnl = raw - fees;
  const pnlPercent = margin > 0 ? (pnl / margin) * 100 : 0;
  return { pnl, pnlPercent };
}

function openPositionUpdatePayload(signal, trade, symbol) {
  const price = Number(signal?.coin?.price || signal?.entry || trade?.entryPrice || 0);
  const u = calcUnrealized(trade, price);
  const sign = u.pnl >= 0 ? '+' : '';
  const side = trade?.direction || 'LONG';
  const embeds = [{
    title: `📍 OPEN POSITION UPDATE ${symbol} (${side})`,
    color: side === 'LONG' ? 0x10b981 : 0xef4444,
    fields: [
      { name: 'Price / Entry', value: `$${num(price)} / $${num(trade?.entryPrice)}`, inline: true },
      { name: 'Unrealized PnL', value: `${sign}$${num(u.pnl, 2)} (${sign}${num(u.pnlPercent, 2)}%)`, inline: true },
      { name: 'Leverage / Margin', value: `${trade?.leverage || 1}x / $${num(trade?.margin, 2)}`, inline: true },
      { name: 'Stop Loss', value: trade?.stopLoss ? `$${num(trade.stopLoss)}` : 'N/A', inline: true },
      { name: 'TP1 / TP2 / TP3', value: `${trade?.takeProfit1 ? `$${num(trade.takeProfit1)}` : 'N/A'} / ${trade?.takeProfit2 ? `$${num(trade.takeProfit2)}` : 'N/A'} / ${trade?.takeProfit3 ? `$${num(trade.takeProfit3)}` : 'N/A'}`, inline: false },
      { name: 'Badges so far', value: summarizeActionBadges(trade?.actions), inline: false },
      { name: 'Score / Confidence / R:R', value: `${signal?.score ?? trade?.score ?? 0} / ${signal?.confidence ?? 'N/A'}% / ${num(signal?.riskReward, 2)}x`, inline: true },
      { name: 'Regime / Strategy', value: `${signal?.regime || trade?.regime || 'unknown'} / ${signal?.strategyName || trade?.strategyType || 'N/A'}`, inline: true },
      { name: 'Timeframes', value: tfSummary(signal?.timeframes), inline: false },
      { name: 'Why / Why not (short)', value: `${compactLines(signal?.reasoning, 3) || '-'}\n${compactLines(signal?.counterReasons, 2) || ''}`.slice(0, 1024), inline: false }
    ],
    footer: { text: 'Position-first free signal feed • 15m cadence while OPEN' },
    timestamp: new Date().toISOString()
  }];
  return { username: 'AlphaConfluence Free Signal', embeds };
}

function periodicSignalPayload(signal, symbol, hasOpenTrade) {
  const isBuy = signal?.signal === 'BUY' || signal?.signal === 'STRONG_BUY';
  const isSell = signal?.signal === 'SELL' || signal?.signal === 'STRONG_SELL';
  const side = isBuy ? 'BUY' : isSell ? 'SELL' : 'HOLD';
  const color = isBuy ? 0x10b981 : isSell ? 0xef4444 : 0xeab308;
  const why = bullets(signal?.reasoning);
  const whyNot = bullets(signal?.counterReasons);
  const embeds = [{
    title: `📊 15m UPDATE ${symbol} — ${side}`,
    color,
    fields: [
      { name: 'Signal', value: `${signal?.signal || 'HOLD'} | score ${signal?.score || 0} | confidence ${signal?.confidence ?? 0}%`, inline: true },
      { name: 'Confluence / R:R', value: `${signal?.confluenceLevel || 0}/3 TF | ${num(signal?.riskReward, 2)}x`, inline: true },
      { name: 'Regime / Strategy', value: `${signal?.regime || 'unknown'} / ${signal?.strategyName || 'N/A'}`, inline: true },
      { name: 'Levels', value: `Entry $${num(signal?.entry)}\nSL ${signal?.stopLoss ? `$${num(signal.stopLoss)}` : 'N/A'}\nTP1 ${signal?.takeProfit1 ? `$${num(signal.takeProfit1)}` : 'N/A'} | TP2 ${signal?.takeProfit2 ? `$${num(signal.takeProfit2)}` : 'N/A'} | TP3 ${signal?.takeProfit3 ? `$${num(signal.takeProfit3)}` : 'N/A'}`, inline: false },
      { name: 'Stop/TP labels', value: `${signal?.stopLabel || signal?.stopType || 'N/A'} | ${signal?.tpLabel || signal?.tpType || 'N/A'}`, inline: false },
      { name: 'Timeframes', value: tfSummary(signal?.timeframes), inline: false },
      { name: 'Top strategy fits', value: topStrategiesSummary(signal?.topStrategies), inline: false },
      { name: 'Score breakdown', value: scoreBreakdownSummary(signal?.scoreBreakdown), inline: false },
      { name: 'Indicators', value: indicatorsSummary(signal?.indicators), inline: false },
      { name: 'Trade status', value: hasOpenTrade ? 'OPEN position is active' : 'No open position', inline: true }
    ],
    footer: { text: 'Dashboard + detail-page expanded snapshot' },
    timestamp: new Date().toISOString()
  }];

  const whyChunks = chunkText(why || 'No reasons captured.', 3800);
  whyChunks.forEach((chunk, i) => {
    if (embeds.length >= 8) return;
    embeds.push({
      title: i === 0 ? 'Why This Trade (Full)' : `Why This Trade (cont. ${i + 1})`,
      color: 0x10b981,
      description: chunk
    });
  });

  const whyNotChunks = chunkText(whyNot || 'No counter-reasons captured.', 3800);
  whyNotChunks.forEach((chunk, i) => {
    if (embeds.length >= 10) return;
    embeds.push({
      title: i === 0 ? 'Why Not This Trade (Full)' : `Why Not This Trade (cont. ${i + 1})`,
      color: 0xef4444,
      description: chunk
    });
  });

  return {
    username: 'AlphaConfluence Free Signal',
    embeds
  };
}

async function notifyTradeOpened(trade) {
  try {
    const cfg = await getConfig();
    if (!cfg.enabled || !cfg.webhookUrl) return;
    if (!tradeMatchesConfig(trade, cfg)) return;
    await postToDiscord(cfg.webhookUrl, tradeOpenPayload(trade));
  } catch (e) {
    console.warn('[FreeSignal] notifyTradeOpened:', e.message);
  }
}

async function notifyTradeClosed(trade) {
  try {
    const cfg = await getConfig();
    if (!cfg.enabled || !cfg.webhookUrl) return;
    if (!tradeMatchesConfig(trade, cfg)) return;
    await postToDiscord(cfg.webhookUrl, tradeClosePayload(trade));
    await postToDiscord(cfg.webhookUrl, cooldownPayload(trade.symbol || 'Fantom', cfg.cooldownMinutes));
    await saveConfig({
      state: {
        lastCooldownTradeId: String(trade._id || ''),
        lastActionTradeId: '',
        lastActionCount: 0
      }
    });
  } catch (e) {
    console.warn('[FreeSignal] notifyTradeClosed:', e.message);
  }
}

async function notifyActionBadge(trade, action) {
  try {
    const cfg = await getConfig();
    if (!cfg.enabled || !cfg.webhookUrl || cfg.includeActionBadges === false) return;
    if (!tradeMatchesConfig(trade, cfg)) return;
    await postToDiscord(cfg.webhookUrl, actionBadgePayload(trade, action || {}));
  } catch (e) {
    console.warn('[FreeSignal] notifyActionBadge:', e.message);
  }
}

async function runPeriodicFreeSignalUpdate(buildSignalFn, opts = {}) {
  const cfg = await getConfig();
  if (!cfg.enabled || !cfg.webhookUrl) return { skipped: true, reason: 'disabled' };
  if (!cfg.paperUserId) return { skipped: true, reason: 'paper_user_missing' };

  const feedUser = await User.findById(cfg.paperUserId).select('settings disabledRegimesByCoin').lean();
  if (!feedUser) return { skipped: true, reason: 'paper_user_not_found' };

  const signal = await Promise.resolve().then(() => buildSignalFn(cfg.coinId, feedUser));
  let openTrade = await Trade.findOne({
    userId: cfg.paperUserId,
    coinId: cfg.coinId,
    status: 'OPEN'
  }).sort({ createdAt: -1 }).lean();

  // Position-first open path:
  // when there's no open trade for this feed coin, try opening from the current signal first.
  // Uses paper-trading.openTrade so ALL normal safeguards still apply (maxOpenTrades, cooldown,
  // expectancy/risk filters, confidence, correlation, balance checks, etc).
  let openAttempt = null;
  if (!openTrade && cfg.positionFirstMode !== false && typeof opts.openTradeFn === 'function' && signal) {
    const direction = signalToDirection(signal.signal);
    const minScore = feedUser?.settings?.autoTradeMinScore ?? 56;
    const score = Number(signal.score || 0);
    if (direction && score >= minScore) {
      const coinData = signal.coin || {};
      const symbol = coinData.symbol || String(cfg.coinId || 'COIN').toUpperCase();
      const top = Array.isArray(signal.topStrategies) && signal.topStrategies.length > 0 ? signal.topStrategies[0] : null;
      const tradeData = {
        coinId: cfg.coinId,
        symbol,
        direction,
        entry: Number(signal.entry || coinData.price || 0),
        stopLoss: top?.stopLoss ?? signal.stopLoss,
        takeProfit1: top?.takeProfit1 ?? signal.takeProfit1,
        takeProfit2: top?.takeProfit2 ?? signal.takeProfit2,
        takeProfit3: top?.takeProfit3 ?? signal.takeProfit3,
        volume24h: coinData.volume24h,
        score,
        confidence: Number(signal.confidence),
        strategyType: top?.id || signal.strategyType || signal.strategyName || 'free_signal',
        regime: signal.regime || 'unknown',
        reasoning: signal.reasoning || [],
        counterReasons: signal.counterReasons || [],
        indicators: signal.indicators || {},
        scoreBreakdown: signal.scoreBreakdown || {},
        stopType: signal.stopType || 'ATR_SR_FIB',
        stopLabel: signal.stopLabel || 'ATR + S/R + Fib',
        tpType: signal.tpType || 'R_multiple',
        tpLabel: signal.tpLabel || 'R multiples',
        autoTriggered: true
      };

      try {
        const opened = await opts.openTradeFn(cfg.paperUserId, tradeData);
        openTrade = opened?.toObject ? opened.toObject() : opened;
        openAttempt = { opened: true };
        await saveConfig({
          state: {
            lastUpdateAt: new Date().toISOString()
          }
        });
        // openTrade() already triggers notifyTradeOpened for this feed when coin/user matches.
        return { ok: true, posted: 'trade_opened' };
      } catch (e) {
        openAttempt = { opened: false, reason: e?.message || 'open_failed' };
      }
    }
  }

  const since = new Date(Date.now() - (cfg.cooldownMinutes * 60 * 1000));
  const latestClosed = await Trade.findOne({
    userId: cfg.paperUserId,
    coinId: cfg.coinId,
    status: { $ne: 'OPEN' },
    exitTime: { $gte: since }
  }).sort({ exitTime: -1 }).lean();

  if (!openTrade && latestClosed && cfg.state?.lastCooldownTradeId !== String(latestClosed._id)) {
    await postToDiscord(cfg.webhookUrl, cooldownPayload(latestClosed.symbol || 'Fantom', cfg.cooldownMinutes));
    await saveConfig({ state: { lastCooldownTradeId: String(latestClosed._id), lastUpdateAt: new Date().toISOString() } });
    return { ok: true, posted: 'cooldown' };
  }

  const symbol = signal?.coin?.symbol || openTrade?.symbol || 'FANTOM';
  const digest = digestString([
    signal?.signal, signal?.score, signal?.confluenceLevel, signal?.riskReward,
    signal?.entry, signal?.stopLoss, signal?.takeProfit1, signal?.takeProfit2, signal?.takeProfit3,
    JSON.stringify(signal?.scoreBreakdown || {}),
    JSON.stringify(signal?.timeframes || {}),
    (Array.isArray(signal?.reasoning) ? signal.reasoning.join('||') : ''),
    (Array.isArray(signal?.counterReasons) ? signal.counterReasons.join('||') : ''),
    openTrade?._id || '', openTrade?.stopLoss || '', openTrade?.takeProfit1 || '', openTrade?.takeProfit2 || '', openTrade?.takeProfit3 || ''
  ]);

  const elapsed = cfg.state?.lastUpdateAt ? (Date.now() - new Date(cfg.state.lastUpdateAt).getTime()) : Infinity;
  const minIntervalMs = Number(cfg.updateIntervalMinutes || 15) * 60 * 1000;
  // Hard minimum cadence: never send periodic updates faster than configured interval.
  // (Trade open/close/badge events are still immediate and separate.)
  if (elapsed < minIntervalMs) {
    return { skipped: true, reason: 'interval_wait' };
  }

  if (openTrade) {
    if (cfg.includeActionBadges !== false) {
      const actionTradeId = String(openTrade._id || '');
      const actions = Array.isArray(openTrade.actions) ? openTrade.actions : [];
      const sameTrade = String(cfg.state?.lastActionTradeId || '') === actionTradeId;
      const postedCount = sameTrade ? Math.max(0, Number(cfg.state?.lastActionCount || 0)) : 0;
      const newActions = actions.slice(postedCount, postedCount + 10);
      for (const a of newActions) {
        await postToDiscord(cfg.webhookUrl, actionBadgePayload(openTrade, a || {}));
      }
      if (actions.length > postedCount) {
        await saveConfig({
          state: {
            lastActionTradeId: actionTradeId,
            lastActionCount: actions.length
          }
        });
      }
    }
    // Position-first: while an actual paper position is open, send lifecycle-centric updates.
    await postToDiscord(cfg.webhookUrl, openPositionUpdatePayload(signal || {}, openTrade, symbol));
  } else {
    // In position-first mode, if there was an actionable entry signal but opening was blocked,
    // post an explicit blocked notice instead of a normal directional update.
    if (cfg.positionFirstMode !== false && openAttempt && openAttempt.opened === false) {
      await postToDiscord(cfg.webhookUrl, entryBlockedPayload(symbol, openAttempt.reason, signal || {}));
      await saveConfig({
        state: {
          lastDigest: digest,
          lastSignalDigest: digest,
          lastUpdateAt: new Date().toISOString()
        }
      });
      return { ok: true, posted: 'entry_blocked' };
    }
    const shouldPostFlat = cfg.positionFirstMode ? (cfg.postWhenNoOpenTrade === true) : (cfg.postWhenNoOpenTrade !== false);
    if (!shouldPostFlat) return { skipped: true, reason: 'flat_waiting' };
    await postToDiscord(cfg.webhookUrl, periodicSignalPayload(signal || {}, symbol, false));
    await saveConfig({
      state: {
        lastActionTradeId: '',
        lastActionCount: 0
      }
    });
  }
  await saveConfig({
    state: {
      lastDigest: digest,
      lastSignalDigest: digest,
      lastUpdateAt: new Date().toISOString()
    }
  });
  return { ok: true, posted: 'periodic_update' };
}

async function lookupUserByEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  return User.findOne({ email: clean }).select('_id username email').lean();
}

module.exports = {
  getConfig,
  saveConfig,
  lookupUserByEmail,
  notifyTradeOpened,
  notifyTradeClosed,
  notifyActionBadge,
  runPeriodicFreeSignalUpdate
};
