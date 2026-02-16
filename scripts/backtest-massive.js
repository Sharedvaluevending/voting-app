#!/usr/bin/env node
// scripts/backtest-massive.js – MASSIVE 2-YEAR BACKTEST
// Runs one coin at a time, one month at a time, with:
//   - Risk SL cap: ON
//   - 4h Cooldown: ON
//   - BTC Signal Filter: OFF
//
// Usage: node scripts/backtest-massive.js [--quick] [--no-cache]
//   --quick = 2 coins × 3 months (for testing)
//   --no-cache = fetch fresh data (slower, more API calls). Default: use cache.
// Full run: 14 coins × 24 months. Uses Bybit-only + cache to avoid rate limits.

const fs = require('fs');
const path = require('path');
const { runBacktestForCoin } = require('../services/backtest');
const { TRACKED_COINS, COIN_META } = require('../services/crypto-api');

const INITIAL_BALANCE = 10000;
const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;
const DELAY_BETWEEN_RUNS = 1500;  // ms - conservative to avoid API rate limits

const QUICK_MODE = process.argv.includes('--quick');
const NO_CACHE = process.argv.includes('--no-cache');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Generate 24 month ranges for the last 2 years
 */
function getMonthRanges() {
  const endMs = Date.now();
  const startMs = endMs - 2 * 365 * 24 * 60 * 60 * 1000;
  const ranges = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const monthEnd = Math.min(cursor + MS_PER_MONTH, endMs);
    ranges.push({ startMs: cursor, endMs: monthEnd });
    cursor = monthEnd;
  }
  return ranges;
}

/**
 * Aggregate per-coin results from monthly runs
 */
function aggregateCoinResults(monthlyResults) {
  const valid = monthlyResults.filter(r => !r.error && r.trades);
  if (valid.length === 0) return null;

  const allTrades = valid.flatMap(r => r.trades || []);
  const wins = allTrades.filter(t => t.pnl > 0).length;
  const losses = allTrades.filter(t => t.pnl <= 0).length;
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const winRate = allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0;
  const returnPct = (totalPnl / INITIAL_BALANCE) * 100;

  // Max drawdown: use worst monthly drawdown as proxy (conservative)
  const drawdowns = valid.map(r => r.maxDrawdownPct || 0).filter(d => d > 0);
  const maxDrawdownPct = drawdowns.length > 0 ? Math.max(...drawdowns) : 0;
  const avgDrawdownPct = drawdowns.length > 0 ? drawdowns.reduce((a, b) => a + b, 0) / drawdowns.length : 0;

  // Months with data
  const monthsWithTrades = valid.filter(r => (r.trades || []).length > 0).length;

  // Strategy breakdown (aggregate from monthly)
  const strategyBreakdown = {};
  allTrades.forEach(t => {
    const s = t.strategy || 'Unknown';
    if (!strategyBreakdown[s]) strategyBreakdown[s] = { trades: 0, pnl: 0, wins: 0 };
    strategyBreakdown[s].trades++;
    strategyBreakdown[s].pnl += t.pnl;
    if (t.pnl > 0) strategyBreakdown[s].wins++;
  });

  // Sharpe (weighted avg of monthly Sharpes, or compute from combined returns)
  const sharpes = valid.map(r => r.sharpeRatio).filter(s => Number.isFinite(s) && s > 0);
  const avgSharpe = sharpes.length > 0 ? sharpes.reduce((a, b) => a + b, 0) / sharpes.length : 0;

  return {
    totalTrades: allTrades.length,
    wins,
    losses,
    winRate,
    totalPnl,
    returnPct,
    profitFactor,
    maxDrawdownPct,
    avgDrawdownPct,
    monthsWithData: valid.length,
    monthsWithTrades,
    grossProfit,
    grossLoss,
    strategyBreakdown,
    sharpeRatio: avgSharpe
  };
}

/**
 * Composite score for ranking (higher = better)
 * Favors: high return, high profit factor, high win rate, lower drawdown
 */
function compositeScore(agg) {
  if (!agg || agg.totalTrades < 5) return -Infinity;
  const returnScore = Math.min(agg.returnPct, 500) / 50;  // cap return impact
  const pfScore = Math.min(agg.profitFactor, 5) * 10;
  const wrScore = agg.winRate / 10;
  const ddPenalty = agg.maxDrawdownPct / 5;
  return returnScore + pfScore + wrScore - ddPenalty;
}

async function main() {
  const features = {
    btcFilter: false,   // BTC signal filter OFF
    slCap: true,       // Risk SL cap ON
    cooldown: true,    // 4h cooldown ON
    btcCorrelation: false  // Also off when btcFilter is off (consistent)
  };

  const options = {
    features,
    useBybitOnly: true,   // Skip Kraken to avoid rate limits
    useCache: !NO_CACHE,  // Cache candles (huge speedup, avoids re-fetching)
    delay: 600
  };

  let monthRanges = getMonthRanges();
  let coinsToRun = TRACKED_COINS;

  if (QUICK_MODE) {
    coinsToRun = TRACKED_COINS.slice(0, 2);
    monthRanges = monthRanges.slice(-3);  // last 3 months
    console.log('\n[QUICK MODE: 2 coins × 3 months]\n');
  }

  const totalRuns = coinsToRun.length * monthRanges.length;

  console.log('\n========================================');
  console.log('  MASSIVE 2-YEAR BACKTEST');
  console.log('========================================');
  console.log('Config: SL cap ON | 4h cooldown ON | BTC filter OFF');
  console.log(`Mode: Bybit-only, Cache ${NO_CACHE ? 'OFF' : 'ON'}, Delay ${DELAY_BETWEEN_RUNS}ms`);
  console.log(`Coins: ${coinsToRun.length} | Months: ${monthRanges.length} | Total runs: ${totalRuns}`);
  console.log(`Range: ${new Date(monthRanges[0].startMs).toISOString().slice(0, 10)} to ${new Date(monthRanges[monthRanges.length - 1].endMs).toISOString().slice(0, 10)}`);
  console.log('========================================\n');

  const coinResults = {};  // coinId -> array of monthly results

  for (const coinId of coinsToRun) {
    coinResults[coinId] = [];
  }

  let runCount = 0;
  const startTime = Date.now();

  for (const coinId of coinsToRun) {
    console.log(`\n--- ${COIN_META[coinId]?.symbol || coinId} ---`);
    for (let m = 0; m < monthRanges.length; m++) {
      const { startMs, endMs } = monthRanges[m];
      runCount++;
      try {
        const result = await runBacktestForCoin(coinId, startMs, endMs, options);
        coinResults[coinId].push(result);
        const status = result.error ? `FAIL: ${result.error}` : `${result.totalTrades} trades, $${(result.totalPnl || 0).toFixed(0)}`;
        process.stdout.write(`  ${new Date(startMs).toISOString().slice(0, 7)} ${status}  `);
      } catch (err) {
        coinResults[coinId].push({ error: err.message, trades: [] });
        process.stdout.write(`  ${new Date(startMs).toISOString().slice(0, 7)} ERR: ${err.message.slice(0, 30)}  `);
      }
      await sleep(DELAY_BETWEEN_RUNS);
    }
    console.log('');
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n========================================`);
  console.log(`Completed ${runCount} runs in ${elapsed} minutes`);
  console.log('========================================\n');

  // Aggregate and rank
  const aggregated = [];
  for (const coinId of coinsToRun) {
    const agg = aggregateCoinResults(coinResults[coinId]);
    if (agg) {
      aggregated.push({
        coinId,
        symbol: COIN_META[coinId]?.symbol || coinId,
        name: COIN_META[coinId]?.name || coinId,
        ...agg,
        score: compositeScore(agg)
      });
    }
  }

  aggregated.sort((a, b) => b.score - a.score);

  // Top 10
  console.log('TOP 10 COINS (by composite score)\n');
  console.log('Rank | Symbol | Trades | Win% | PnL ($) | Return% | PF | MaxDD% | Sharpe | Score');
  console.log('-'.repeat(85));

  const top10 = aggregated.slice(0, 10);
  top10.forEach((r, i) => {
    console.log(
      `${(i + 1).toString().padStart(4)} | ${r.symbol.padEnd(6)} | ${r.totalTrades.toString().padStart(6)} | ${r.winRate.toFixed(1).padStart(5)}% | ` +
      `$${r.totalPnl.toFixed(0).padStart(6)} | ${r.returnPct.toFixed(1).padStart(6)}% | ${r.profitFactor.toFixed(2).padStart(5)} | ` +
      `${r.maxDrawdownPct.toFixed(1).padStart(5)}% | ${(r.sharpeRatio || 0).toFixed(2).padStart(6)} | ${r.score.toFixed(1)}`
    );
  });

  // Full metrics table
  console.log('\n\nDETAILED METRICS (Top 10)\n');
  top10.forEach((r, i) => {
    console.log(`${i + 1}. ${r.symbol} (${r.name})`);
    console.log(`   Trades: ${r.totalTrades} | Wins: ${r.wins} | Losses: ${r.losses}`);
    console.log(`   Win Rate: ${r.winRate.toFixed(1)}%`);
    console.log(`   Total PnL: $${r.totalPnl.toFixed(2)} | Return: ${r.returnPct.toFixed(2)}%`);
    console.log(`   Profit Factor: ${r.profitFactor.toFixed(2)}`);
    console.log(`   Max Drawdown: ${r.maxDrawdownPct.toFixed(1)}% | Avg DD: ${r.avgDrawdownPct.toFixed(1)}%`);
    console.log(`   Months with trades: ${r.monthsWithTrades}/${r.monthsWithData}`);
    console.log('');
  });

  // Insights
  console.log('========================================');
  console.log('INSIGHTS & RECOMMENDATIONS');
  console.log('========================================\n');

  const allAgg = aggregated;
  const avgWinRate = allAgg.length ? allAgg.reduce((s, r) => s + r.winRate, 0) / allAgg.length : 0;
  const avgPf = allAgg.length ? allAgg.reduce((s, r) => s + r.profitFactor, 0) / allAgg.length : 0;
  const profitableCoins = allAgg.filter(r => r.totalPnl > 0).length;
  const bestCoin = top10[0];
  const worstCoin = allAgg[allAgg.length - 1];

  console.log('1. PORTFOLIO FOCUS');
  console.log(`   - ${profitableCoins}/${allAgg.length} coins were profitable over 2 years`);
  console.log(`   - Best performer: ${bestCoin?.symbol} ($${bestCoin?.totalPnl?.toFixed(0)} return)`);
  console.log(`   - Consider concentrating capital on top 3-5 coins rather than all 14`);
  console.log('');

  console.log('2. BTC FILTER IMPACT');
  console.log('   - With BTC filter OFF, altcoins traded independently of BTC signal');
  console.log('   - If top coins are highly correlated with BTC, consider testing WITH filter for comparison');
  console.log('   - Run: features.btcFilter=true to compare results');
  console.log('');

  console.log('3. RISK PARAMETERS');
  console.log(`   - Average max drawdown across coins: ${(allAgg.reduce((s,r)=>s+r.maxDrawdownPct,0)/allAgg.length).toFixed(1)}%`);
  console.log('   - SL cap (15%) is protecting; consider testing tighter (10%) for lower DD');
  console.log('   - 4h cooldown reduces overtrading; test 2h/6h for sensitivity');
  console.log('');

  console.log('4. STRATEGY IMPROVEMENTS');
  console.log('   - Session filter: test turning OFF during low-volatility months');
  console.log('   - Min score: try 54-56 instead of 52 for fewer but higher-quality signals');
  console.log('   - Add coin-specific score thresholds based on this backtest (e.g. stricter for volatile coins)');
  console.log('');

  // Strategy breakdown (from first coin with data)
  const coinWithStrategies = aggregated.find(a => a.strategyBreakdown && Object.keys(a.strategyBreakdown).length > 0);
  if (coinWithStrategies?.strategyBreakdown) {
    console.log('6. STRATEGY BREAKDOWN (sample from top coin)');
    Object.entries(coinWithStrategies.strategyBreakdown).forEach(([name, s]) => {
      const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0';
      console.log(`   - ${name}: ${s.trades} trades, $${s.pnl.toFixed(0)} PnL, ${wr}% win rate`);
    });
    console.log('');
  }

  console.log('7. DATA & EXECUTION');
  console.log('   - Bybit-only + cache: avoids Kraken rate limits, reuses candle data');
  console.log('   - Run with --no-cache to force fresh fetches (slower)');
  console.log('');

  // Save results to file
  const resultsDir = path.join(__dirname, '../data/backtest-results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const resultsPath = path.join(resultsDir, `massive-${Date.now()}.json`);
  fs.writeFileSync(resultsPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    config: { features, useBybitOnly: true, useCache: !NO_CACHE },
    top10: top10.map(r => ({ symbol: r.symbol, totalPnl: r.totalPnl, winRate: r.winRate, profitFactor: r.profitFactor, maxDrawdownPct: r.maxDrawdownPct, sharpeRatio: r.sharpeRatio })),
    allCoins: aggregated,
    monthRanges: monthRanges.length
  }, null, 2), 'utf8');
  console.log(`Results saved to ${resultsPath}\n`);
  console.log('========================================');
  console.log('Done.\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
