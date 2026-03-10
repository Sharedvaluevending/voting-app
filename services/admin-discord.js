const fetch = require('node-fetch');
const SystemConfig = require('../models/SystemConfig');
const User = require('../models/User');

const CONFIG_KEY = 'admin_discord_channels';
const DEFAULTS = {
  backtest: {
    enabled: false,
    webhookUrl: ''
  },
  wins: {
    enabled: false,
    webhookUrl: '',
    minPnlUsd: 0,
    onlyUserId: '',
    onlyUserEmail: ''
  }
};

async function getAdminDiscordConfig() {
  const doc = await SystemConfig.findOne({ key: CONFIG_KEY }).lean();
  const value = (doc && doc.value && typeof doc.value === 'object') ? doc.value : {};
  return {
    backtest: { ...DEFAULTS.backtest, ...(value.backtest || {}) },
    wins: { ...DEFAULTS.wins, ...(value.wins || {}) }
  };
}

async function saveAdminDiscordConfig(input) {
  const current = await getAdminDiscordConfig();
  const next = {
    backtest: { ...current.backtest, ...(input?.backtest || {}) },
    wins: { ...current.wins, ...(input?.wins || {}) }
  };
  next.backtest.enabled = !!next.backtest.enabled;
  next.backtest.webhookUrl = String(next.backtest.webhookUrl || '').trim();
  next.wins.enabled = !!next.wins.enabled;
  next.wins.webhookUrl = String(next.wins.webhookUrl || '').trim();
  next.wins.minPnlUsd = Math.max(0, Number(next.wins.minPnlUsd || 0));
  next.wins.onlyUserId = String(next.wins.onlyUserId || '').trim();
  next.wins.onlyUserEmail = String(next.wins.onlyUserEmail || '').trim().toLowerCase();

  await SystemConfig.updateOne(
    { key: CONFIG_KEY },
    { $set: { value: next, updatedAt: new Date() } },
    { upsert: true }
  );
  return next;
}

async function postDiscord(webhookUrl, payload) {
  if (!webhookUrl) throw new Error('Webhook URL missing');
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Discord webhook failed (${res.status}): ${txt.slice(0, 180)}`);
  }
  return true;
}

function n(v, d = 2) {
  if (!Number.isFinite(v)) return '0.00';
  return Number(v).toFixed(d);
}

function backtestPayloadFromMassiveResult(result) {
  const top = (result?.top10 || []).slice(0, 10);
  const allCoins = Array.isArray(result?.allCoins) ? result.allCoins : [];
  const nameBySymbol = {};
  allCoins.forEach((c) => {
    if (c?.symbol) nameBySymbol[String(c.symbol)] = c?.name || c?.coinId || c?.symbol;
  });
  const topLines = top.map((r, idx) => {
    const pnl = Number(r?.totalPnl || 0);
    const sign = pnl >= 0 ? '+' : '';
    const sym = r.symbol || '—';
    const nm = nameBySymbol[sym] || sym;
    return `${idx + 1}. ${sym} (${nm}) | ${sign}$${n(pnl, 0)} | WR ${n(r.winRate || 0, 1)}% | PF ${n(r.profitFactor || 0, 2)} | DD ${n(r.maxDrawdownPct || 0, 1)}%`;
  }).join('\n');

  const totalPnl = allCoins.reduce((s, c) => s + Number(c?.totalPnl || 0), 0);
  const totalTrades = allCoins.reduce((s, c) => s + Number(c?.totalTrades || 0), 0);

  return {
    username: 'AlphaConfluence Admin',
    embeds: [{
      title: '📈 Massive Backtest Results',
      color: 0x3b82f6,
      fields: [
        { name: 'Timestamp', value: result?.timestamp ? new Date(result.timestamp).toLocaleString() : 'N/A', inline: true },
        { name: 'Months', value: String(result?.monthRanges || 0), inline: true },
        { name: 'Coins', value: String(allCoins.length), inline: true },
        { name: 'Total Trades', value: String(totalTrades), inline: true },
        { name: 'Total PnL', value: `${totalPnl >= 0 ? '+' : ''}$${n(totalPnl, 0)}`, inline: true },
        { name: 'Top 10 (Coin + Name)', value: topLines || 'No data', inline: false },
        {
          name: 'Regime / Actions / Exit Reasons',
          value: 'Massive result file does not include these aggregates. Use the live Backtest page "Post This Backtest to Discord" for full regime + actions + exits detail.',
          inline: false
        }
      ],
      footer: { text: 'Posted from admin backtest portal' },
      timestamp: new Date().toISOString()
    }]
  };
}

function backtestPayloadFromRun(run) {
  const summary = run?.summary || {};
  const results = Array.isArray(run?.results) ? run.results : [];
  const regimeBreakdown = run?.regimeBreakdown || {};

  const perCoinLines = results
    .filter((r) => !r?.error)
    .slice(0, 12)
    .map((r) => `${r?.symbol || r?.coinId || '—'} (${r?.coinId || 'n/a'}) | ${r?.totalTrades || 0} trades | WR ${n(r?.winRate || 0, 1)}% | PnL ${Number(r?.totalPnl || 0) >= 0 ? '+' : ''}$${n(r?.totalPnl || 0, 2)}`)
    .join('\n');

  const regimeLines = Object.keys(regimeBreakdown)
    .slice(0, 12)
    .map((k) => {
      const v = regimeBreakdown[k] || {};
      const wr = v?.trades ? ((Number(v.wins || 0) / Number(v.trades || 1)) * 100) : 0;
      return `${k}: ${v?.trades || 0} trades | WR ${n(wr, 1)}% | PnL ${Number(v?.pnl || 0) >= 0 ? '+' : ''}$${n(v?.pnl || 0, 2)}`;
    })
    .join('\n');

  const actionCounts = {};
  const exitReasonCounts = {};
  results.forEach((r) => {
    const ac = r?.actionCounts || {};
    Object.keys(ac).forEach((k) => { actionCounts[k] = (actionCounts[k] || 0) + Number(ac[k] || 0); });
    const ex = r?.exitReasons || {};
    Object.keys(ex).forEach((k) => { exitReasonCounts[k] = (exitReasonCounts[k] || 0) + Number(ex[k] || 0); });
  });
  const actionLines = Object.keys(actionCounts)
    .sort((a, b) => (actionCounts[b] || 0) - (actionCounts[a] || 0))
    .map((k) => `${k}: ${actionCounts[k]}`)
    .join(' | ');
  const exitLines = Object.keys(exitReasonCounts)
    .sort((a, b) => (exitReasonCounts[b] || 0) - (exitReasonCounts[a] || 0))
    .map((k) => `${k}: ${exitReasonCounts[k]}`)
    .join(' | ');

  return {
    username: 'AlphaConfluence Admin',
    embeds: [{
      title: '🧪 Backtest Run Snapshot',
      color: 0x8b5cf6,
      fields: [
        { name: 'Trades', value: String(summary.totalTrades || 0), inline: true },
        { name: 'Win Rate', value: `${n(summary.winRate || 0, 1)}%`, inline: true },
        { name: 'Total PnL', value: `${Number(summary.totalPnl || 0) >= 0 ? '+' : ''}$${n(summary.totalPnl || 0, 2)}`, inline: true },
        { name: 'Return %', value: `${Number(summary.returnPct || 0) >= 0 ? '+' : ''}${n(summary.returnPct || 0, 2)}%`, inline: true },
        { name: 'Profit Factor', value: n(summary.profitFactor || 0, 2), inline: true },
        { name: 'Coins Processed', value: `${summary.coinsProcessed || 0} (failed ${summary.coinsFailed || 0})`, inline: true },
        { name: 'Coin Results (Coin + Name/Symbol)', value: perCoinLines || 'No per-coin results.', inline: false },
        { name: 'Regime Breakdown', value: regimeLines || 'No regime breakdown.', inline: false },
        { name: 'Actions Taken', value: actionLines || 'No action badge data.', inline: false },
        { name: 'Exit Reasons', value: exitLines || 'No exit reason data.', inline: false }
      ],
      footer: { text: 'Posted from live backtest screen' },
      timestamp: new Date().toISOString()
    }]
  };
}

async function postMassiveBacktestToDiscord(result) {
  const cfg = await getAdminDiscordConfig();
  if (!cfg.backtest.enabled || !cfg.backtest.webhookUrl) {
    return { skipped: true, reason: 'backtest_webhook_disabled' };
  }
  const payload = backtestPayloadFromMassiveResult(result);
  await postDiscord(cfg.backtest.webhookUrl, payload);
  return { ok: true };
}

async function postBacktestRunToDiscord(runData) {
  const cfg = await getAdminDiscordConfig();
  if (!cfg.backtest.enabled || !cfg.backtest.webhookUrl) {
    return { skipped: true, reason: 'backtest_webhook_disabled' };
  }
  const payload = backtestPayloadFromRun(runData);
  await postDiscord(cfg.backtest.webhookUrl, payload);
  return { ok: true };
}

function winningTradePayload(trade) {
  const pnl = Number(trade?.pnl || 0);
  return {
    username: 'AlphaConfluence Wins',
    embeds: [{
      title: `🏆 WIN ${trade?.symbol || ''} ${trade?.direction || ''}`,
      color: 0x10b981,
      fields: [
        { name: 'PnL', value: `+$${n(pnl, 2)} (+${n(trade?.pnlPercent || 0, 2)}%)`, inline: true },
        { name: 'Entry → Exit', value: `$${n(trade?.entryPrice || 0, 4)} → $${n(trade?.exitPrice || 0, 4)}`, inline: true },
        { name: 'Reason', value: String(trade?.closeReason || trade?.status || 'CLOSED'), inline: true }
      ],
      footer: { text: 'Paper trade win notification' },
      timestamp: new Date().toISOString()
    }]
  };
}

async function notifyWinningTrade(trade) {
  try {
    const pnl = Number(trade?.pnl || 0);
    if (!(pnl > 0)) return { skipped: true, reason: 'not_win' };
    const cfg = await getAdminDiscordConfig();
    if (!cfg.wins.enabled || !cfg.wins.webhookUrl) return { skipped: true, reason: 'wins_webhook_disabled' };
    if (cfg.wins.onlyUserId && String(trade.userId) !== String(cfg.wins.onlyUserId)) {
      return { skipped: true, reason: 'user_filter_mismatch' };
    }
    if (pnl < Number(cfg.wins.minPnlUsd || 0)) return { skipped: true, reason: 'below_min_pnl' };
    await postDiscord(cfg.wins.webhookUrl, winningTradePayload(trade));
    return { ok: true };
  } catch (e) {
    console.warn('[AdminDiscord] notifyWinningTrade:', e.message);
    return { skipped: true, reason: 'error' };
  }
}

async function resolveUserByEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  return User.findOne({ email: clean }).select('_id username email').lean();
}

module.exports = {
  getAdminDiscordConfig,
  saveAdminDiscordConfig,
  postMassiveBacktestToDiscord,
  postBacktestRunToDiscord,
  notifyWinningTrade,
  resolveUserByEmail
};
