// services/backtest/run-backtest.js
// ====================================================
// REALISM-FIRST BACKTEST - Uses SignalEngine, RiskEngine, ManageEngine
// Single source of truth; no duplicated strategy logic
// ====================================================

const { evaluate } = require('../engines/signal-engine');
const { plan } = require('../engines/risk-engine');
const { update: manageUpdate } = require('../engines/manage-engine');
const { sliceCandlesAt, buildSnapshot } = require('./market-data');
const { execute } = require('./execution-simulator');
const { createTrade, applyAction, updatePriceRange } = require('./trade-state');
const { canOpenTrade, maybeResetDaily } = require('./portfolio-controls');
const { buildSummary, breakdownByStrategy, computeMaxDrawdown, computeMaxDrawdownPct } = require('./analytics');
const { COIN_META } = require('../crypto-api');

const SLIPPAGE_BPS = 5;
const TAKER_FEE = 0.001;
const COOLDOWN_BARS = 4;
const SCORE_RECHECK_INTERVAL = 4;
const STOP_GRACE_BARS = 1;
const TP1_PCT = 0.4;
const TP2_PCT = 0.3;
const TP3_PCT = 0.3;

/**
 * Run backtest for one coin using shared engines
 */
async function runBacktestForCoin(coinId, startMs, endMs, options) {
  options = options || {};
  const candles = options.candles;
  const btcCandles = options.btcCandles;
  if (!candles || !candles['1h']) {
    return { error: 'No candles provided', trades: [], equityCurve: [] };
  }

  const minScore = options.minScore ?? 52;
  const leverage = options.leverage ?? 2;
  const initialBalance = options.initialBalance ?? 10000;
  const riskMode = options.riskMode || 'percent';
  const riskPerTrade = (options.riskPerTrade ?? 2) / 100;
  const riskDollarsPerTrade = options.riskDollarsPerTrade ?? 200;

  const ft = options.features || {};
  const F_BTC_FILTER = ft.btcFilter !== false;
  const F_BTC_CORRELATION = ft.btcCorrelation !== false;
  const F_SESSION_FILTER = ft.sessionFilter !== false;
  const F_PARTIAL_TP = ft.partialTP !== false;
  const F_FEES = ft.fees !== false;
  const F_SLIPPAGE = ft.slippage !== false;
  const F_CLOSE_STOPS = ft.closeBasedStops !== false;
  const F_DCA = ft.dca === true;
  const dcaMaxAdds = ft.dcaMaxAdds ?? 3;
  const dcaDipPct = ft.dcaDipPercent ?? 2;
  const dcaAddSizePct = ft.dcaAddSizePercent ?? 100;
  const dcaMinScore = ft.dcaMinScore ?? 52;

  const c1h = candles['1h'];
  const history = { prices: [], volumes: [], marketCaps: [] };
  const trades = [];
  let equity = initialBalance;
  let position = null;
  let lastClosedBar = -999;
  let lastClosedDirection = null;

  let tradeStartBar = 50;
  for (let i = 0; i < c1h.length; i++) {
    if (c1h[i].openTime >= startMs) {
      tradeStartBar = Math.max(50, i);
      break;
    }
  }

  let cachedBtcSignal = null;
  let cachedBtcDirection = null;
  let cachedBtcSlice = null;
  let lastBtcAnalysisBar = -999;

  const coinMeta = COIN_META[coinId] || { symbol: coinId.toUpperCase(), name: coinId };

  for (let t = 50; t < c1h.length - 1; t++) {
    if (equity <= 0) break;

    const bar = c1h[t];
    const nextBar = c1h[t + 1];
    const slice = sliceCandlesAt(candles, t, '1h');
    if (!slice) continue;

    const coinData = {
      id: coinId,
      symbol: coinMeta.symbol,
      name: coinMeta.name,
      price: bar.close,
      change24h: t >= 24 ? ((bar.close - c1h[t - 24].close) / c1h[t - 24].close) * 100 : 0,
      volume24h: 0,
      marketCap: 0,
      lastUpdated: new Date(bar.openTime)
    };

    const options_bt = {
      strategyWeights: options.strategyWeights || [],
      strategyStats: options.strategyStats || {},
      btcSignal: F_BTC_FILTER ? cachedBtcSignal : null,
      btcDirection: F_BTC_CORRELATION ? cachedBtcDirection : null,
      btcCandles: F_BTC_CORRELATION && cachedBtcSlice ? cachedBtcSlice['1h'] : null,
      fundingRates: {},
      barTime: F_SESSION_FILTER ? bar.openTime : new Date('2026-01-01T15:00:00Z').getTime(),
      featurePriceActionConfluence: ft.priceActionConfluence === true,
      featureVolatilityFilter: ft.volatilityFilter === true,
      featureVolumeConfirmation: ft.volumeConfirmation === true
    };

    if (btcCandles && btcCandles['1h'] && (t - lastBtcAnalysisBar >= 4)) {
      const btc1h = btcCandles['1h'];
      const btcIdx = btc1h.findIndex(b => b.openTime >= bar.openTime);
      const btcT = btcIdx >= 0 ? Math.min(btcIdx, btc1h.length - 1) : btc1h.length - 1;
      if (btcT >= 50) {
        const btcSlice = sliceCandlesAt(btcCandles, btcT, '1h');
        if (btcSlice) {
          const btcData = { id: 'bitcoin', symbol: 'BTC', price: btc1h[btcT].close, change24h: 0 };
          const btcDecision = evaluate({ coinData: btcData, candles: btcSlice, history, options: {} });
          cachedBtcSignal = btcDecision.signal === 'STRONG_BUY' || btcDecision.signal === 'BUY' ? 'STRONG_BUY' : btcDecision.signal === 'STRONG_SELL' || btcDecision.signal === 'SELL' ? 'STRONG_SELL' : null;
          cachedBtcDirection = cachedBtcSignal === 'STRONG_BUY' ? 'BULL' : cachedBtcSignal === 'STRONG_SELL' ? 'BEAR' : null;
          cachedBtcSlice = btcSlice;
          lastBtcAnalysisBar = t;
        }
      }
    }

    const snapshot = {
      coinData,
      candles: slice,
      history,
      options: options_bt,
      currentPrice: bar.close,
      high: nextBar.high,
      low: nextBar.low,
      open: nextBar.open,
      nextBar,
      bar,
      closed: { '1h': true },
      closeBasedStops: F_CLOSE_STOPS,
      indicators: null
    };

    let portfolioState = { openTrades: position ? [position] : [], equity, killSwitch: false };
    portfolioState = maybeResetDaily(portfolioState, bar.openTime);

    if (position) {
      position = updatePriceRange(position, nextBar.high, nextBar.low);
      position.entryPrice = position.entryPrice ?? position.entry;
      position.positionSize = position.positionSize ?? position.size;
      position.originalPositionSize = position.originalPositionSize ?? position.originalSize;
      snapshot.currentPrice = nextBar.close;
      snapshot.indicators = position.indicators;

      const recheckDue = (t - (position.lastScoreCheckBar ?? position.entryBar)) >= SCORE_RECHECK_INTERVAL;
      if (recheckDue && ft.scoreRecheck !== false) {
        const recheckDecision = evaluate({ coinData, candles: slice, history, options: options_bt });
        snapshot.recheckSignal = recheckDecision;
        position.lastScoreCheckBar = t;
        position.indicators = recheckDecision.indicators;
      }

      const manageSnapshot = {
        currentPrice: nextBar.close,
        high: nextBar.high,
        low: nextBar.low,
        close: nextBar.close,
        recheckSignal: snapshot.recheckSignal,
        timestamp: nextBar.openTime,
        closeBasedStops: F_CLOSE_STOPS
      };

      const ff = {
        breakeven: ft.breakeven !== false,
        trailingStop: ft.trailingStop !== false,
        lockIn: ft.lockIn !== false,
        scoreRecheck: ft.scoreRecheck !== false,
        partialTP: F_PARTIAL_TP
      };

      const pastGrace = (t - position.entryBar) >= STOP_GRACE_BARS;
      const { actions, updatedTrade } = manageUpdate(position, manageSnapshot, {
        featureFlags: ff,
        stopGraceMinutes: 2,
        entryTime: c1h[position.entryBar]?.openTime
      });

      let closed = false;
      for (const action of actions) {
        if (action.type === 'SL' || action.type === 'EXIT' || (action.type === 'TP1' && action.fullClose) || (action.type === 'TP2' && action.fullClose) || action.type === 'TP3') {
          const exitPrice = action.marketPrice || (action.type === 'SL' ? position.stopLoss : nextBar.close);
          const slipMul = 1 + (SLIPPAGE_BPS / 10000);
          const adjExit = position.direction === 'LONG' ? exitPrice / slipMul : exitPrice * slipMul;
          const exitFees = F_FEES ? position.size * TAKER_FEE : 0;
          const pnl = position.direction === 'LONG'
            ? ((adjExit - position.entry) / position.entry) * position.size
            : ((position.entry - adjExit) / position.entry) * position.size;
          const totalPnl = (position.partialPnl || 0) + pnl - exitFees;
          equity = Math.max(0, equity + totalPnl);
          trades.push({
            direction: position.direction,
            entry: position.entry,
            exit: adjExit,
            entryBar: position.entryBar,
            exitBar: t + 1,
            reason: action.type === 'SL' ? 'SL' : action.type === 'EXIT' ? 'SCORE_EXIT' : action.type,
            pnl: totalPnl,
            size: position.originalSize,
            partials: position.partialPnl || 0,
            actions: [...(position.actions || [])],
            strategy: position.entryStrategy || position.strategy || 'Unknown',
            regime: position.regime
          });
          lastClosedBar = t + 1;
          lastClosedDirection = position.direction;
          position = null;
          closed = true;
          break;
        }
        if (action.type === 'TP1' || action.type === 'TP2') {
          const portion = action.portion || 0;
          const exitPrice = action.marketPrice;
          const slipMul = 1 + (SLIPPAGE_BPS / 10000);
          const adjExit = position.direction === 'LONG' ? exitPrice / slipMul : exitPrice * slipMul;
          const exitFees = F_FEES ? portion * TAKER_FEE : 0;
          const pnl = position.direction === 'LONG'
            ? ((adjExit - position.entry) / position.entry) * portion
            : ((position.entry - adjExit) / position.entry) * portion;
          equity = Math.max(0, equity + pnl - exitFees);
          position.partialPnl = (position.partialPnl || 0) + pnl - exitFees;
          position.size -= portion;
          position.actions.push({ type: action.type, bar: t + 1, portion, marketPrice: adjExit });
          if (action.type === 'TP1') position.partialTakenAtTP1 = true;
          if (action.type === 'TP2') position.partialTakenAtTP2 = true;
        }
        if (action.type === 'BE' || action.type === 'TS' || action.type === 'LOCK') {
          position.stopLoss = action.newStop ?? action.newValue;
          position.actions.push({ type: action.type, bar: t + 1, newValue: action.newStop ?? action.newValue, marketPrice: action.marketPrice });
          if (action.type === 'BE') position.breakevenHit = true;
          if (action.type === 'TS') position.trailingActivated = true;
        }
        if (action.type === 'RP' || action.type === 'PP') {
          const portion = action.portion || 0;
          const exitPrice = action.marketPrice;
          const exitFees = F_FEES ? portion * TAKER_FEE : 0;
          const pnl = position.direction === 'LONG'
            ? ((exitPrice - position.entry) / position.entry) * portion
            : ((position.entry - exitPrice) / position.entry) * portion;
          equity = Math.max(0, equity + pnl - exitFees);
          position.partialPnl = (position.partialPnl || 0) + pnl - exitFees;
          position.size -= portion;
          position.actions.push({ type: action.type, bar: t + 1, marketPrice: exitPrice });
          if (action.type === 'RP') position.reducedByScore = true;
          if (action.type === 'PP') position.takenPartialByScore = true;
        }
      }
      if (closed) continue;
      position = updatedTrade;
      position.size = position.positionSize ?? position.size;
      position.entry = position.entryPrice ?? position.entry;

      // DCA: add to losing positions when signal re-confirms (mirrors live)
      if (F_DCA && position && (position.dcaCount || 0) < dcaMaxAdds) {
        const avgEntry = position.avgEntryPrice || position.entry;
        const currentPrice = nextBar.close;
        const isLong = position.direction === 'LONG';
        const dipPctNow = isLong
          ? ((avgEntry - currentPrice) / avgEntry) * 100
          : ((currentPrice - avgEntry) / avgEntry) * 100;
        const dipLevel = dcaDipPct * ((position.dcaCount || 0) + 1);
        if (dipPctNow >= dipLevel) {
          const dcaDecision = evaluate({ coinData, candles: slice, history, options: options_bt });
          const dcaDir = dcaDecision.side === 'LONG' ? 'LONG' : dcaDecision.side === 'SHORT' ? 'SHORT' : null;
          if (dcaDir === position.direction && (dcaDecision.score || 0) >= dcaMinScore) {
            const addSize = position.originalSize * (dcaAddSizePct / 100);
            const addFees = F_FEES ? addSize * TAKER_FEE : 0;
            const addMargin = addSize / leverage;
            if (equity >= addMargin + addFees) {
              const oldAvg = position.avgEntryPrice || position.entry;
              const oldTotalCost = oldAvg * position.size;
              const newTotalCost = oldTotalCost + (currentPrice * addSize);
              const newTotalSize = position.size + addSize;
              const newAvgEntry = newTotalCost / newTotalSize;

              position.size = newTotalSize;
              position.positionSize = newTotalSize;
              position.avgEntryPrice = newAvgEntry;
              position.entry = newAvgEntry;
              position.entryPrice = newAvgEntry;
              position.dcaCount = (position.dcaCount || 0) + 1;
              if (!position.dcaEntries) position.dcaEntries = [];
              position.dcaEntries.push({ price: currentPrice, size: addSize, bar: t + 1 });
              equity -= (addMargin + addFees);
              position.actions.push({ type: 'DCA', bar: t + 1, addSize, addPrice: currentPrice, avgEntry: newAvgEntry, dip: dipPctNow });
            }
          }
        }
      }
      continue;
    }

    if (t < tradeStartBar) continue;

    const decision = evaluate({ coinData, candles: slice, history, options: options_bt });
    if (!decision.side) continue;
    if (decision.score < minScore) continue;
    if (F_BTC_FILTER && coinId !== 'bitcoin' && cachedBtcSignal) {
      if (decision.side === 'LONG' && cachedBtcSignal === 'STRONG_SELL') continue;
      if (decision.side === 'SHORT' && cachedBtcSignal === 'STRONG_BUY') continue;
    }
    if (!decision.stopLoss) continue;
    if (!ft.trailingTp && !decision.takeProfit1) continue;

    if (ft.cooldown !== false && lastClosedDirection === decision.side && (t + 1 - lastClosedBar) < COOLDOWN_BARS) continue;

    const canOpen = canOpenTrade({ openTrades: position ? [position] : [], equity }, { maxConcurrentTrades: 1 });
    if (!canOpen.ok) continue;

    const context = {
      balance: equity,
      openTrades: position ? [position] : [],
      streak: 0,
      strategyStats: options.strategyStats || {},
      featureFlags: ft,
      userSettings: {
        riskPerTrade: riskPerTrade * 100,
        riskMode,
        riskDollarsPerTrade,
        defaultLeverage: leverage,
        maxBalancePercentPerTrade: 25,
        tpMode: ft.trailingTp ? 'trailing' : 'fixed',
        trailingTpDistanceMode: ft.trailingTpDistanceMode || 'atr',
        trailingTpAtrMultiplier: ft.trailingTpAtrMultiplier ?? 1.5,
        trailingTpFixedPercent: ft.trailingTpFixedPercent ?? 2
      }
    };

    const orders = plan(decision, snapshot, context);
    if (!orders) continue;

    const execSnapshot = {
      currentPrice: nextBar.open,
      coinData: { ...coinData, price: nextBar.open },
      indicators: decision.indicators
    };
    const fillResult = execute(
      { direction: orders.direction, size: orders.size, entry: orders.entry, orderType: 'market' },
      execSnapshot,
      { takerFee: TAKER_FEE, minSlipBps: SLIPPAGE_BPS }
    );
    if (!fillResult.filled) continue;

    const entryFees = F_FEES ? orders.size * TAKER_FEE : 0;
    if (entryFees + (orders.size / orders.leverage) > equity) continue;

    equity -= entryFees;

    position = {
      direction: orders.direction,
      entry: fillResult.fillPrice,
      entryPrice: fillResult.fillPrice,
      entryBar: t + 1,
      entryScore: decision.score,
      entryStrategy: decision.strategy,
      stopLoss: orders.stopLoss,
      originalStopLoss: orders.stopLoss,
      originalSL: orders.originalStopLoss,
      takeProfit1: orders.takeProfit1,
      takeProfit2: orders.takeProfit2,
      takeProfit3: orders.takeProfit3,
      size: orders.size,
      positionSize: orders.size,
      originalSize: orders.size,
      originalPositionSize: orders.size,
      tp1Hit: false,
      tp2Hit: false,
      breakevenHit: false,
      trailingActivated: orders.tpMode === 'trailing',
      reducedByScore: false,
      takenPartialByScore: false,
      maxPrice: fillResult.fillPrice,
      minPrice: fillResult.fillPrice,
      partialPnl: 0,
      lastScoreCheckBar: t + 1,
      actions: [],
      tpMode: orders.tpMode || 'fixed',
      trailingTpDistance: orders.trailingTpDistance,
      regime: orders.regime,
      indicators: decision.indicators,
      leverage: orders.leverage || leverage,
      dcaCount: 0,
      dcaEntries: []
    };
  }

  if (position) {
    const lastBar = c1h[c1h.length - 1];
    const exitPrice = lastBar.close;
    const slipMul = 1 + (SLIPPAGE_BPS / 10000);
    const adjExit = position.direction === 'LONG' ? exitPrice / slipMul : exitPrice * slipMul;
    const exitFees = F_FEES ? position.size * TAKER_FEE : 0;
    const pnl = position.direction === 'LONG'
      ? ((adjExit - position.entry) / position.entry) * position.size
      : ((position.entry - adjExit) / position.entry) * position.size;
    const totalPnl = (position.partialPnl || 0) + pnl - exitFees;
    equity = Math.max(0, equity + totalPnl);
    trades.push({
      direction: position.direction,
      entry: position.entry,
      exit: adjExit,
      entryBar: position.entryBar,
      exitBar: c1h.length - 1,
      reason: 'END',
      pnl: totalPnl,
      size: position.originalSize,
      partials: position.partialPnl || 0,
      actions: position.actions || [],
      strategy: position.entryStrategy || position.strategy || 'Unknown',
      regime: position.regime
    });
  }

  const equityCurve = [{ t: 0, equity: initialBalance, date: c1h[0]?.openTime }];
  let runningEquity = initialBalance;
  trades.forEach((tr, i) => {
    runningEquity += tr.pnl;
    equityCurve.push({ t: tr.exitBar, equity: runningEquity, date: c1h[tr.exitBar]?.openTime, trade: i + 1 });
  });

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

  const tradeReturns = trades.map(t => t.pnl / initialBalance).filter(r => Number.isFinite(r));
  const meanRet = tradeReturns.length > 0 ? tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length : 0;
  const variance = tradeReturns.length > 0 ? tradeReturns.reduce((s, r) => s + Math.pow(r - meanRet, 2), 0) / tradeReturns.length : 0;
  const stdRet = Math.sqrt(variance) || 0.0001;
  const sharpeRatio = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(tradeReturns.length) : 0;

  const allActions = trades.flatMap(t => (t.actions || []).map(a => a.type));
  const actionCounts = {
    BE: allActions.filter(a => a === 'BE').length,
    TS: allActions.filter(a => a === 'TS').length,
    PP: allActions.filter(a => a === 'PP').length,
    RP: allActions.filter(a => a === 'RP').length,
    EXIT: allActions.filter(a => a === 'EXIT').length,
    LOCK: allActions.filter(a => a === 'LOCK').length
  };

  const exitReasons = {};
  trades.forEach(t => { exitReasons[t.reason] = (exitReasons[t.reason] || 0) + 1; });

  const strategyBreakdown = breakdownByStrategy(trades);

  return {
    coinId,
    symbol: coinMeta.symbol,
    startMs,
    endMs,
    bars: c1h.length,
    trades,
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    totalPnl,
    profitFactor,
    finalEquity: initialBalance + totalPnl,
    returnPct: (totalPnl / initialBalance) * 100,
    equityCurve,
    maxDrawdown: computeMaxDrawdown(equityCurve),
    maxDrawdownPct: computeMaxDrawdownPct(equityCurve),
    sharpeRatio,
    strategyBreakdown,
    actionCounts,
    exitReasons
  };
}

module.exports = {
  runBacktestForCoin
};
