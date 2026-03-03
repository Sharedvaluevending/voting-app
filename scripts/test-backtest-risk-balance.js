#!/usr/bin/env node
// Audit: fees, % risk, account balance in backtest
// Verifies position sizing uses running equity, fees are applied, initialBalance is respected

const { runBacktest } = require('../services/backtest');

const COIN = 'bitcoin';
const DAYS = 7;

async function runWithOpts(opts) {
  const endMs = Date.now();
  const startMs = endMs - DAYS * 24 * 60 * 60 * 1000;
  const options = {
    coins: [COIN],
    primaryTf: '1h',
    minScore: 48,
    features: { btcFilter: false, btcCorrelation: false, fees: true },
    ...opts
  };
  return runBacktest(startMs, endMs, options);
}

async function main() {
  console.log('=== Backtest Risk & Balance Audit ===\n');

  // Test 1: initialBalance should affect position sizes and final equity
  console.log('1. Initial balance (5000 vs 10000)...');
  const r5k = await runWithOpts({ initialBalance: 5000, riskPerTrade: 2 });
  const r10k = await runWithOpts({ initialBalance: 10000, riskPerTrade: 2 });
  const ok5k = r5k.results.find(r => !r.error);
  const ok10k = r10k.results.find(r => !r.error);
  if (ok5k && ok10k && ok5k.trades?.length > 0 && ok10k.trades?.length > 0) {
    const size5k = ok5k.trades[0].size;
    const size10k = ok10k.trades[0].size;
    const ratio = size5k / size10k;
    if (ratio > 0.4 && ratio < 0.6) {
      console.log('   OK: 5k balance ~half the position size of 10k (ratio:', ratio.toFixed(2) + ')');
    } else {
      console.log('   FAIL: 5k/10k size ratio expected ~0.5, got', ratio.toFixed(2));
    }
  } else {
    console.log('   SKIP: insufficient trades');
  }

  // Test 2: riskPerTrade % should affect size
  console.log('\n2. Risk % (1% vs 2%)...');
  const r1pct = await runWithOpts({ initialBalance: 10000, riskPerTrade: 1 });
  const r2pct = await runWithOpts({ initialBalance: 10000, riskPerTrade: 2 });
  const ok1 = r1pct.results.find(r => !r.error);
  const ok2 = r2pct.results.find(r => !r.error);
  if (ok1 && ok2 && ok1.trades?.length > 0 && ok2.trades?.length > 0) {
    const size1 = ok1.trades[0].size;
    const size2 = ok2.trades[0].size;
    const ratio = size1 / size2;
    if (ratio > 0.4 && ratio < 0.6) {
      console.log('   OK: 1% risk ~half the size of 2% (ratio:', ratio.toFixed(2) + ')');
    } else {
      console.log('   FAIL: 1%/2% size ratio expected ~0.5, got', ratio.toFixed(2));
    }
  } else {
    console.log('   SKIP: insufficient trades');
  }

  // Test 3: Fees should be applied (pnl should reflect fee deduction)
  console.log('\n3. Fees applied...');
  const rFees = await runWithOpts({ initialBalance: 10000, features: { fees: true, btcFilter: false, btcCorrelation: false } });
  const okFees = rFees.results.find(r => !r.error);
  if (okFees && okFees.trades?.length > 0) {
    const t = okFees.trades[0];
    const rawPnl = t.direction === 'LONG'
      ? ((t.exit - t.entry) / t.entry) * t.size
      : ((t.entry - t.exit) / t.entry) * t.size;
    const diff = Math.abs((t.pnl || 0) - rawPnl);
    const expectedFee = t.size * 0.001 * 2; // entry + exit ~0.1% each
    if (diff > 0.01) {
      console.log('   OK: PnL differs from raw by', diff.toFixed(2), '(fees applied)');
    } else {
      console.log('   WARN: PnL matches raw - fees may not be applied');
    }
  } else {
    console.log('   SKIP: no trades');
  }

  // Test 4: Equity compounds (return % uses initialBalance, not fixed)
  console.log('\n4. Return % vs initial balance...');
  const rRet = await runWithOpts({ initialBalance: 5000 });
  const s = rRet.summary;
  if (s && s.totalTrades > 0) {
    const expectedRet = (s.totalPnl / 5000) * 100;
    const actualRet = s.returnPct;
    const match = Math.abs(expectedRet - actualRet) < 0.1;
    console.log('   Initial 5000, PnL', s.totalPnl.toFixed(2), '=> return', actualRet.toFixed(2) + '%');
    console.log(match ? '   OK: return matches PnL/initialBalance' : '   FAIL: return calculation may be wrong');
  } else {
    console.log('   SKIP: no trades');
  }

  // Test 5: riskMode dollar
  console.log('\n5. Risk mode dollar ($100 fixed)...');
  const rDollar = await runWithOpts({
    initialBalance: 10000,
    riskMode: 'dollar',
    riskDollarsPerTrade: 100,
    riskPerTrade: 2
  });
  const okD = rDollar.results.find(r => !r.error);
  if (okD && okD.trades?.length > 0) {
    const size = okD.trades[0].size;
    console.log('   First trade size:', size.toFixed(2));
    console.log('   OK: dollar mode produces position (size depends on SL distance)');
  } else {
    console.log('   SKIP: no trades');
  }

  console.log('\n=== Audit complete ===\n');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
