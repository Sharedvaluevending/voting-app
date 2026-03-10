#!/usr/bin/env node
// scripts/audit-backtest-feature-matrix.js
// Matrix audit across multiple coins/windows for all backtest feature toggles.
//
// Usage:
//   node scripts/audit-backtest-feature-matrix.js [coinsCsv] [daysCsv] [timeframe]
// Example:
//   node scripts/audit-backtest-feature-matrix.js bitcoin,ethereum,solana 30,90,180 4h

const { runBacktestForCoin } = require('../services/backtest');

function approxEqual(a, b, eps = 1e-8) {
  return Math.abs((a || 0) - (b || 0)) <= eps;
}

function recomputeSharpeFromTrades(trades, initialBalance) {
  const tradeReturns = trades.map(t => (t.pnl || 0) / initialBalance).filter(Number.isFinite);
  if (tradeReturns.length === 0) return 0;
  const mean = tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length;
  const variance = tradeReturns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / tradeReturns.length;
  const std = Math.sqrt(variance) || 0.0001;
  return std > 0 ? (mean / std) * Math.sqrt(tradeReturns.length) : 0;
}

function recomputeBreakdown(trades, keyFn) {
  const out = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (!out[k]) out[k] = { trades: 0, pnl: 0, wins: 0 };
    out[k].trades++;
    out[k].pnl += t.pnl || 0;
    if ((t.pnl || 0) > 0) out[k].wins++;
  }
  return out;
}

function deepBreakdownEqual(a, b, eps = 1e-8) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  if (JSON.stringify(ka) !== JSON.stringify(kb)) return false;
  for (const k of ka) {
    if ((a[k].trades || 0) !== (b[k].trades || 0)) return false;
    if ((a[k].wins || 0) !== (b[k].wins || 0)) return false;
    if (Math.abs((a[k].pnl || 0) - (b[k].pnl || 0)) > eps) return false;
  }
  return true;
}

function summarizeResult(r, initialBalance) {
  const trades = r.trades || [];
  const wins = trades.filter(t => (t.pnl || 0) > 0).length;
  const losses = trades.length - wins;
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossProfit = trades.filter(t => (t.pnl || 0) > 0).reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(trades.filter(t => (t.pnl || 0) < 0).reduce((s, t) => s + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const returnPct = (totalPnl / initialBalance) * 100;
  const sharpeRatio = recomputeSharpeFromTrades(trades, initialBalance);

  const byYearExpected = recomputeBreakdown(trades, (t) => {
    const ts = t.exitTime || t.entryTime || t.exitBar;
    const d = ts ? new Date(typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : ts) : null;
    return d ? d.getFullYear() : 'unknown';
  });
  const byStrategyExpected = recomputeBreakdown(trades, (t) => t.strategy || t.entryStrategy || 'unknown');

  const actionCounts = {};
  for (const t of trades) {
    for (const a of (t.actions || [])) actionCounts[a.type] = (actionCounts[a.type] || 0) + 1;
  }
  const canonicalActions = ['BE', 'TS', 'PP', 'RP', 'EXIT', 'LOCK', 'DCA'];
  const actionCountsOk = canonicalActions.every(k => (r.actionCounts?.[k] || 0) === (actionCounts[k] || 0));

  const exitReasonsExpected = {};
  for (const t of trades) exitReasonsExpected[t.reason] = (exitReasonsExpected[t.reason] || 0) + 1;
  const exitKeysA = Object.keys(exitReasonsExpected).sort();
  const exitKeysB = Object.keys(r.exitReasons || {}).sort();
  const exitReasonsOk = JSON.stringify(exitKeysA) === JSON.stringify(exitKeysB)
    && exitKeysA.every(k => exitReasonsExpected[k] === (r.exitReasons[k] || 0));

  const checks = {
    winsLosses: wins === r.wins && losses === r.losses,
    winRate: approxEqual(winRate, r.winRate),
    totalPnl: approxEqual(totalPnl, r.totalPnl),
    profitFactor: approxEqual(profitFactor, r.profitFactor),
    returnPct: approxEqual(returnPct, r.returnPct),
    sharpeRatio: approxEqual(sharpeRatio, r.sharpeRatio, 1e-6),
    finalEquity: approxEqual(initialBalance + totalPnl, r.finalEquity),
    strategyBreakdown: deepBreakdownEqual(byStrategyExpected, r.strategyBreakdown || {}),
    byYear: deepBreakdownEqual(byYearExpected, r.byYear || {}),
    actionCounts: actionCountsOk,
    exitReasons: exitReasonsOk,
    drawdownFieldConsistency: approxEqual(r.maxDrawdownPctMtm ?? r.maxDrawdownPct, r.maxDrawdownPct)
  };

  return {
    checks,
    metrics: {
      totalTrades: r.totalTrades || 0,
      wins: r.wins || 0,
      losses: r.losses || 0,
      winRate: r.winRate || 0,
      totalPnl: r.totalPnl || 0,
      returnPct: r.returnPct || 0,
      profitFactor: r.profitFactor || 0,
      sharpeRatio: r.sharpeRatio || 0,
      maxDrawdownPctRealized: r.maxDrawdownPctRealized ?? null,
      maxDrawdownPctMtm: r.maxDrawdownPctMtm ?? r.maxDrawdownPct ?? null
    }
  };
}

function allChecksPass(checks) {
  return Object.values(checks).every(Boolean);
}

function baselineFeatures() {
  return {
    btcFilter: true,
    btcCorrelation: true,
    sessionFilter: false,
    partialTP: true,
    breakeven: true,
    breakevenRMult: 0.75,
    trailingStop: true,
    trailingStartR: 1.5,
    trailingDistR: 2.0,
    lockIn: true,
    scoreRecheck: true,
    slCap: true,
    cooldown: true,
    confidenceSizing: true,
    kellySizing: true,
    priceActionConfluence: true,
    volatilityFilter: true,
    volumeConfirmation: true,
    fundingRateFilter: true,
    themeDetector: false,
    minRiskRewardEnabled: true,
    minRiskReward: 1.5,
    maxDailyLossPercent: 5,
    minVolume24hUsd: 0,
    drawdownSizingEnabled: true,
    drawdownThresholdPercent: 10,
    fees: true,
    slippage: true,
    slippageMultiplier: 1,
    closeBasedStops: true,
    minSlDistance: true,
    trailingTp: false,
    dca: false
  };
}

function toggleScenarios(base) {
  const cases = [];
  const boolKeys = [
    'btcFilter',
    'btcCorrelation',
    'sessionFilter',
    'partialTP',
    'breakeven',
    'trailingStop',
    'lockIn',
    'scoreRecheck',
    'slCap',
    'cooldown',
    'confidenceSizing',
    'kellySizing',
    'priceActionConfluence',
    'volatilityFilter',
    'volumeConfirmation',
    'fundingRateFilter',
    'themeDetector',
    'minRiskRewardEnabled',
    'drawdownSizingEnabled',
    'fees',
    'slippage',
    'closeBasedStops',
    'minSlDistance',
    'trailingTp',
    'dca'
  ];
  for (const key of boolKeys) {
    const next = { ...base, [key]: !base[key] };
    if (key === 'trailingTp' && next.trailingTp) {
      next.trailingTpDistanceMode = 'atr';
      next.trailingTpAtrMultiplier = 1.5;
      next.trailingTpFixedPercent = 2;
    }
    if (key === 'dca' && next.dca) {
      next.dcaMaxAdds = 3;
      next.dcaDipPercent = 2;
      next.dcaAddSizePercent = 100;
      next.dcaMinScore = 52;
    }
    cases.push({ id: `toggle_${key}`, features: next });
  }
  cases.push({ id: 'toggle_slippageStress', features: { ...base, slippageMultiplier: 1.5 } });
  cases.push({ id: 'toggle_minVolumeEnabled', features: { ...base, minVolume24hUsd: 50000000 } });
  return cases;
}

function metricChanged(baseMetrics, testMetrics) {
  const keys = ['totalTrades', 'wins', 'losses', 'winRate', 'totalPnl', 'returnPct', 'profitFactor', 'sharpeRatio', 'maxDrawdownPctRealized', 'maxDrawdownPctMtm'];
  for (const k of keys) {
    const a = baseMetrics[k];
    const b = testMetrics[k];
    const bothFinite = Number.isFinite(a) && Number.isFinite(b);
    if (bothFinite && Math.abs(b - a) > 1e-10) return true;
    if (!bothFinite && a !== b) return true;
  }
  return false;
}

async function runAuditForPair(coinId, days, primaryTf) {
  const initialBalance = 10000;
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const common = {
    useCache: true,
    primaryTf,
    minScore: 70,
    initialBalance
  };

  const baseFeatures = baselineFeatures();
  const baseRun = await runBacktestForCoin(coinId, startMs, endMs, { ...common, features: baseFeatures });
  if (baseRun.error) {
    return { coinId, days, primaryTf, error: baseRun.error };
  }
  const baseline = summarizeResult(baseRun, initialBalance);
  const scenarios = toggleScenarios(baseFeatures);

  const scenarioResults = [];
  for (const s of scenarios) {
    const run = await runBacktestForCoin(coinId, startMs, endMs, { ...common, features: s.features });
    if (run.error) {
      scenarioResults.push({ id: s.id, error: run.error });
      continue;
    }
    const summary = summarizeResult(run, initialBalance);
    scenarioResults.push({
      id: s.id,
      checksPass: allChecksPass(summary.checks),
      changedOutcome: metricChanged(baseline.metrics, summary.metrics)
    });
  }

  const mathFailures = scenarioResults.filter(r => !r.error && !r.checksPass).map(r => r.id);
  const runtimeErrors = scenarioResults.filter(r => r.error);
  const noEffectScenarios = scenarioResults.filter(r => !r.error && r.checksPass && !r.changedOutcome).map(r => r.id);
  const changedScenarios = scenarioResults.filter(r => !r.error && r.changedOutcome).map(r => r.id);

  return {
    coinId,
    days,
    primaryTf,
    baselineMetrics: baseline.metrics,
    overview: {
      scenarios: scenarioResults.length,
      mathFailures: mathFailures.length,
      runtimeErrors: runtimeErrors.length,
      noEffectScenarios: noEffectScenarios.length,
      changedScenarios: changedScenarios.length
    },
    mathFailures,
    runtimeErrors,
    noEffectScenarios,
    changedScenarios
  };
}

async function main() {
  const coins = (process.argv[2] || 'bitcoin,ethereum,solana').split(',').map(s => s.trim()).filter(Boolean);
  const daysList = (process.argv[3] || '30,90,180').split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
  const primaryTf = process.argv[4] || '4h';

  const startedAt = new Date().toISOString();
  const matrix = [];
  let completed = 0;
  const total = coins.length * daysList.length;

  for (const coinId of coins) {
    for (const days of daysList) {
      const t0 = Date.now();
      const result = await runAuditForPair(coinId, days, primaryTf);
      const elapsedSec = Math.round((Date.now() - t0) / 1000);
      completed++;
      console.log(`[MatrixAudit] ${completed}/${total} ${coinId} ${days}d done in ${elapsedSec}s`);
      matrix.push(result);
    }
  }

  const summary = {
    totalRuns: matrix.length,
    runsWithErrors: matrix.filter(r => r.error || (r.overview && r.overview.runtimeErrors > 0)).length,
    totalMathFailures: matrix.reduce((s, r) => s + (r.overview?.mathFailures || 0), 0),
    totalRuntimeErrors: matrix.reduce((s, r) => s + (r.overview?.runtimeErrors || 0), 0)
  };

  const byToggle = {};
  for (const run of matrix) {
    if (!run.changedScenarios || !run.noEffectScenarios) continue;
    for (const id of run.changedScenarios) {
      if (!byToggle[id]) byToggle[id] = { changed: 0, noEffect: 0, mathFailures: 0, runtimeErrors: 0 };
      byToggle[id].changed++;
    }
    for (const id of run.noEffectScenarios) {
      if (!byToggle[id]) byToggle[id] = { changed: 0, noEffect: 0, mathFailures: 0, runtimeErrors: 0 };
      byToggle[id].noEffect++;
    }
    for (const id of (run.mathFailures || [])) {
      if (!byToggle[id]) byToggle[id] = { changed: 0, noEffect: 0, mathFailures: 0, runtimeErrors: 0 };
      byToggle[id].mathFailures++;
    }
    for (const e of (run.runtimeErrors || [])) {
      const id = e.id || 'unknown';
      if (!byToggle[id]) byToggle[id] = { changed: 0, noEffect: 0, mathFailures: 0, runtimeErrors: 0 };
      byToggle[id].runtimeErrors++;
    }
  }

  const payload = {
    runConfig: {
      coins,
      daysList,
      primaryTf,
      startedAt,
      endedAt: new Date().toISOString()
    },
    summary,
    byToggle,
    matrix
  };

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
