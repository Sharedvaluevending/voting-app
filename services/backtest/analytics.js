// services/backtest/analytics.js
// ====================================================
// OUTPUT & ANALYTICS
// Logs, summary metrics, per-regime/strategy/symbol, reconciliation
// ====================================================

/**
 * Compute max drawdown from equity curve
 */
function computeMaxDrawdown(equityCurve) {
  let peak = equityCurve[0]?.equity || 0;
  let maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/**
 * Compute max drawdown %
 */
function computeMaxDrawdownPct(equityCurve) {
  let peak = equityCurve[0]?.equity || 0;
  let maxDdPct = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const ddPct = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  }
  return maxDdPct;
}

/**
 * Compute Sharpe-like ratio (annualized, simplified)
 */
function computeSharpeRatio(equityCurve, riskFreeRate = 0) {
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    const curr = equityCurve[i].equity;
    if (prev > 0) returns.push((curr - prev) / prev);
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  const std = Math.sqrt(variance) || 0.0001;
  return std > 0 ? (mean - riskFreeRate / 252) / std * Math.sqrt(252) : 0;
}

/**
 * Build summary metrics from trades and equity curve
 */
function buildSummary(trades, equityCurve, initialBalance) {
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const returnPct = initialBalance > 0 ? (totalPnl / initialBalance) * 100 : 0;
  const maxDrawdown = computeMaxDrawdown(equityCurve);
  const maxDrawdownPct = computeMaxDrawdownPct(equityCurve);
  const sharpeRatio = computeSharpeRatio(equityCurve);

  const avgR = trades.length > 0
    ? trades.reduce((s, t) => s + (t.avgR || 0), 0) / trades.length
    : 0;
  const expectancy = trades.length > 0 ? totalPnl / trades.length : 0;

  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate,
    totalPnl,
    returnPct,
    profitFactor,
    maxDrawdown,
    maxDrawdownPct,
    sharpeRatio,
    avgR,
    expectancy,
    grossProfit,
    grossLoss,
    finalEquity: equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialBalance
  };
}

/**
 * Per-regime breakdown
 */
function breakdownByRegime(trades) {
  const byRegime = {};
  for (const t of trades) {
    const r = t.regime || 'unknown';
    if (!byRegime[r]) byRegime[r] = { trades: 0, pnl: 0, wins: 0 };
    byRegime[r].trades++;
    byRegime[r].pnl += t.pnl || 0;
    if (t.pnl > 0) byRegime[r].wins++;
  }
  return byRegime;
}

/**
 * Per-strategy breakdown
 */
function breakdownByStrategy(trades) {
  const byStrategy = {};
  for (const t of trades) {
    const s = t.strategy || t.entryStrategy || 'unknown';
    if (!byStrategy[s]) byStrategy[s] = { trades: 0, pnl: 0, wins: 0 };
    byStrategy[s].trades++;
    byStrategy[s].pnl += t.pnl || 0;
    if (t.pnl > 0) byStrategy[s].wins++;
  }
  return byStrategy;
}

/**
 * Per-symbol breakdown
 */
function breakdownBySymbol(trades) {
  const bySymbol = {};
  for (const t of trades) {
    const s = t.coinId || t.symbol || 'unknown';
    if (!bySymbol[s]) bySymbol[s] = { trades: 0, pnl: 0, wins: 0 };
    bySymbol[s].trades++;
    bySymbol[s].pnl += t.pnl || 0;
    if (t.pnl > 0) bySymbol[s].wins++;
  }
  return bySymbol;
}

/**
 * Reconciliation: compare backtest vs paper/live for same window
 */
function reconcile(backtestTrades, paperTrades, startMs, endMs) {
  const mismatches = [];
  const btByTime = new Map();
  const ptByTime = new Map();
  for (const t of backtestTrades) {
    const key = `${t.entryBar ?? t.entryTime}-${t.coinId ?? t.symbol}-${t.direction}`;
    btByTime.set(key, t);
  }
  for (const t of paperTrades) {
    const et = new Date(t.entryTime || t.createdAt).getTime();
    if (et < startMs || et > endMs) continue;
    const key = `${et}-${t.coinId ?? t.symbol}-${t.direction}`;
    ptByTime.set(key, t);
  }

  for (const [key, bt] of btByTime) {
    const pt = ptByTime.get(key);
    if (!pt) {
      mismatches.push({ type: 'missing_in_paper', key, backtest: bt });
    } else if (Math.abs((bt.pnl || 0) - (pt.pnl || 0)) > 0.01) {
      mismatches.push({
        type: 'pnl_mismatch',
        key,
        backtestPnl: bt.pnl,
        paperPnl: pt.pnl,
        hint: 'Check fees, slippage, or fill price'
      });
    }
  }
  for (const [key, pt] of ptByTime) {
    if (!btByTime.has(key)) {
      mismatches.push({ type: 'missing_in_backtest', key, paper: pt });
    }
  }

  return {
    mismatches,
    backtestCount: backtestTrades.length,
    paperCount: paperTrades.length,
    matchCount: backtestTrades.length - mismatches.filter(m => m.type === 'missing_in_paper').length
  };
}

/**
 * Create log entry for signal decision
 */
function logSignalDecision(barIndex, decision, timestamp) {
  return {
    type: 'signal',
    barIndex,
    timestamp,
    side: decision.side,
    strategy: decision.strategy,
    score: decision.score,
    reasons: decision.reasons,
    entry: decision.entry,
    stopLoss: decision.stopLoss
  };
}

/**
 * Create log entry for order/fill
 */
function logOrderFill(barIndex, order, result, timestamp) {
  return {
    type: 'fill',
    barIndex,
    timestamp,
    orderType: order.orderType || 'market',
    direction: order.direction,
    size: order.size,
    fillPrice: result.fillPrice,
    fees: result.fees,
    filled: result.filled
  };
}

/**
 * Create log entry for management action
 */
function logManagementAction(barIndex, action, tradeId, timestamp) {
  return {
    type: 'action',
    barIndex,
    timestamp,
    actionType: action.type,
    tradeId,
    newStop: action.newStop ?? action.newValue,
    marketPrice: action.marketPrice
  };
}

module.exports = {
  computeMaxDrawdown,
  computeMaxDrawdownPct,
  computeSharpeRatio,
  buildSummary,
  breakdownByRegime,
  breakdownByStrategy,
  breakdownBySymbol,
  reconcile,
  logSignalDecision,
  logOrderFill,
  logManagementAction
};
