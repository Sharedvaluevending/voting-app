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
const { buildSummary, breakdownByStrategy, breakdownByYear, evaluateBacktest, computeMaxDrawdown, computeMaxDrawdownPct } = require('./analytics');
const { COIN_META } = require('../crypto-api');

const SLIPPAGE_BPS = 5;
const TAKER_FEE = 0.001;
const COOLDOWN_DEFAULT_HOURS = 6; // Match paper/live default cooldown window
const SCORE_RECHECK_INTERVAL = 6;  // Every 6 bars (6h) — was 4, too frequent for crypto score noise
const STOP_GRACE_BARS = 1;
const INDICATOR_WARMUP_BARS = 50;   // RSI(14), MACD(26+9), BB(20), ATR(14) — no signals before warmup
const TP1_PCT = 0.4;
const TP2_PCT = 0.3;
const TP3_PCT = 0.3;
const MAX_DOLLAR_RISK_FRACTION = 0.10;

function getAdjustedExitPrice(direction, rawExit, slippageEnabled, slippageMultiplier) {
  const slipMul = slippageEnabled ? (1 + (SLIPPAGE_BPS * slippageMultiplier / 10000)) : 1;
  return direction === 'LONG' ? rawExit / slipMul : rawExit * slipMul;
}

function computeLegClosePnl(direction, entry, size, rawExit, opts) {
  const slippageEnabled = opts?.slippageEnabled !== false;
  const feesEnabled = opts?.feesEnabled !== false;
  const slippageMultiplier = opts?.slippageMultiplier ?? 1;
  const adjExit = getAdjustedExitPrice(direction, rawExit, slippageEnabled, slippageMultiplier);
  const exitFees = feesEnabled ? size * TAKER_FEE : 0;
  const pnl = direction === 'LONG'
    ? ((adjExit - entry) / entry) * size
    : ((entry - adjExit) / entry) * size;
  return { adjExit, pnl, exitFees, netPnl: pnl - exitFees };
}

function computeWeightedEntryPrice(currentEntry, currentSize, addPrice, addSize) {
  if (!(currentEntry > 0) || !(addPrice > 0) || !(currentSize > 0) || !(addSize > 0)) return currentEntry;
  const currentUnits = currentSize / currentEntry;
  const addUnits = addSize / addPrice;
  const totalUnits = currentUnits + addUnits;
  if (!(totalUnits > 0)) return currentEntry;
  return (currentSize + addSize) / totalUnits;
}

function computeMaxRemainingSizeForRiskCap(params) {
  const direction = params.direction;
  const entry = params.entry;
  const stopLoss = params.stopLoss;
  const riskCapDollars = params.riskCapDollars;
  if (!(riskCapDollars > 0) || !(entry > 0) || !(stopLoss > 0)) return Infinity;

  const adjStop = getAdjustedExitPrice(
    direction,
    stopLoss,
    params.slippageEnabled !== false,
    params.slippageMultiplier ?? 1
  );
  const stopLossPct = direction === 'LONG'
    ? Math.max(0, (entry - adjStop) / entry)
    : Math.max(0, (adjStop - entry) / entry);
  if (!(stopLossPct > 0)) return Infinity;

  const perDollarLoss = stopLossPct + ((params.feesEnabled !== false) ? TAKER_FEE : 0);
  if (!(perDollarLoss > 0)) return Infinity;

  const partialPnl = params.partialPnl || 0;
  const entryFees = params.entryFees || 0;
  const numerator = riskCapDollars + partialPnl - entryFees;
  if (!(numerator > 0)) return 0;
  return numerator / perDollarLoss;
}

/**
 * Run backtest for one coin using shared engines
 */
async function runBacktestForCoin(coinId, startMs, endMs, options) {
  options = options || {};
  const candles = options.candles;
  const btcCandles = options.btcCandles;
  const primaryTf = options.primaryTf || '1h';
  if (!candles || !candles[primaryTf]) {
    return { error: 'No candles provided', trades: [], equityCurve: [] };
  }
  // Engine requires 1h, 4h, 1d for analysis; allow graceful degradation when supporting TFs are sparse
  const has1h = Array.isArray(candles['1h']) && candles['1h'].length >= 20;
  const has4h = Array.isArray(candles['4h']) && candles['4h'].length >= 5;
  const has1d = Array.isArray(candles['1d']) && candles['1d'].length >= 5;
  if (!has1h && primaryTf !== '1d' && primaryTf !== '1w') {
    return { error: 'Engine requires 1h candles for multi-TF analysis (got ' + (candles['1h']?.length || 0) + ')', trades: [], equityCurve: [] };
  }
  if (!has4h || !has1d) {
    console.warn(`[Backtest] ${coinId}: sparse supporting TFs (4h=${candles['4h']?.length||0}, 1d=${candles['1d']?.length||0}) — running with available data`);
  }

  const minScore = options.minScore ?? 52;
  const leverage = options.leverage ?? 2;
  const initialBalance = options.initialBalance ?? 10000;
  const riskMode = options.riskMode || 'percent';
  const riskPerTrade = (options.riskPerTrade ?? 2) / 100;
  const requestedRiskDollarsPerTrade = options.riskDollarsPerTrade ?? 200;
  const maxRiskDollarsPerTrade = Math.max(1, initialBalance * MAX_DOLLAR_RISK_FRACTION);
  const riskDollarsPerTrade = riskMode === 'dollar'
    ? Math.min(requestedRiskDollarsPerTrade, maxRiskDollarsPerTrade)
    : requestedRiskDollarsPerTrade;
  const riskDollarWarning = (riskMode === 'dollar' && requestedRiskDollarsPerTrade > maxRiskDollarsPerTrade)
    ? `Risk per trade exceeds 10% of account — consider lowering. Auto-capped from $${requestedRiskDollarsPerTrade.toFixed(2)} to $${riskDollarsPerTrade.toFixed(2)}.`
    : null;

  const ft = options.features || {};
  const F_BTC_FILTER = ft.btcFilter !== false;
  const F_BTC_CORRELATION = ft.btcCorrelation !== false;
  const F_SESSION_FILTER = ft.sessionFilter === true;
  const F_PARTIAL_TP = ft.partialTP !== false;
  const F_FEES = ft.fees !== false;
  const F_SLIPPAGE = ft.slippage !== false;
  const F_CLOSE_STOPS = ft.closeBasedStops !== false;
  const F_DCA = ft.dca === true;
  const dcaMaxAdds = ft.dcaMaxAdds ?? 3;
  const dcaDipPct = ft.dcaDipPercent ?? 2;
  const dcaAddSizePct = ft.dcaAddSizePercent ?? 100;
  const dcaMinScore = ft.dcaMinScore ?? 52;
  const confidenceFilterEnabled = ft.confidenceFilterEnabled === true;
  const minConfidence = (ft.minConfidence != null && Number.isFinite(Number(ft.minConfidence)))
    ? Math.max(0, Math.min(100, Number(ft.minConfidence)))
    : 60;
  const F_MIN_RR = ft.minRiskRewardEnabled === true;
  const minRiskReward = (ft.minRiskReward != null && Number.isFinite(ft.minRiskReward)) ? Number(ft.minRiskReward) : 1.5;
  const maxDailyLossPct = (ft.maxDailyLossPercent != null && ft.maxDailyLossPercent > 0) ? Number(ft.maxDailyLossPercent) : null;
  const minVolume24hUsd = (ft.minVolume24hUsd != null && ft.minVolume24hUsd > 0) ? Number(ft.minVolume24hUsd) : 0;
  const slippageMultiplier = (ft.slippageMultiplier != null && ft.slippageMultiplier > 0) ? Number(ft.slippageMultiplier) : 1;
  const tfHours = ({ '15m': 0.25, '1h': 1, '4h': 4, '1d': 24, '1w': 168 }[primaryTf] || 1);
  const cooldownHours = (ft.cooldownHours != null && ft.cooldownHours >= 0)
    ? Number(ft.cooldownHours)
    : COOLDOWN_DEFAULT_HOURS;
  const cooldownBars = Math.max(1, Math.ceil(cooldownHours / tfHours));

  const c1h = candles[primaryTf];
  if (!c1h || c1h.length < 50) {
    return { error: `Not enough ${primaryTf} candles (got ${c1h ? c1h.length : 0}, need 50+)`, trades: [], equityCurve: [] };
  }
  const history = { prices: [], volumes: [], marketCaps: [] };
  const trades = [];
  let equity = initialBalance;
  let position = null;
  let lastClosedBar = -999;
  let lastClosedDirection = null;
  let streak = 0;

  let tradeStartBar = INDICATOR_WARMUP_BARS;
  for (let i = 0; i < c1h.length; i++) {
    if (c1h[i].openTime >= startMs) {
      tradeStartBar = Math.max(INDICATOR_WARMUP_BARS, i);
      break;
    }
  }

  let cachedBtcSignal = null;
  let cachedBtcDirection = null;
  let cachedBtcSlice = null;
  let lastBtcAnalysisBar = -999;
  let btcCursor = 0;

  const coinMeta = COIN_META[coinId] || { symbol: coinId.toUpperCase(), name: coinId };

  let portfolioMeta = { dailyStartEquity: initialBalance, lastDailyReset: c1h[50]?.openTime || 0, killSwitch: false };
  let peakEquity = initialBalance;
  const drawdownSizingEnabled = ft.drawdownSizingEnabled === true;
  const drawdownThresholdPercent = ft.drawdownThresholdPercent ?? 10;

  const barEquity = [{ t: 0, equity: initialBalance, date: c1h[0]?.openTime }];
  const YIELD_INTERVAL = c1h.length > 12000 ? 80 : c1h.length > 6000 ? 50 : 25; // Adaptive yield for long ranges
  const barsIn24h = { '15m': 96, '1h': 24, '4h': 6, '1d': 1, '1w': 1 }[primaryTf] || 24;
  let rollingVolume24h = 0;

  for (let t = INDICATOR_WARMUP_BARS; t < c1h.length - 1; t++) {
    if (t % YIELD_INTERVAL === 0) await new Promise(r => setImmediate(r));
    if (equity <= 0) break;
    if (equity > peakEquity) peakEquity = equity;

    const bar = c1h[t];
    const nextBar = c1h[t + 1];

    // Mark-to-market equity: cash + unrealized PnL on remaining position
    if (position) {
      const mtmPrice = bar.close;
      const unrealized = position.direction === 'LONG'
        ? ((mtmPrice - position.entry) / position.entry) * position.size
        : ((position.entry - mtmPrice) / position.entry) * position.size;
      barEquity.push({ t, equity: Math.max(0, equity + unrealized), date: bar.openTime });
    } else {
      barEquity.push({ t, equity, date: bar.openTime });
    }

    const slice = sliceCandlesAt(candles, t, primaryTf);
    if (!slice) continue;

    let volume24h = options.volume24hByCoin?.[coinId];
    if (volume24h == null && c1h[t].volume != null) {
      if (t === INDICATOR_WARMUP_BARS) {
        rollingVolume24h = 0;
        for (let j = Math.max(0, t - barsIn24h + 1); j <= t; j++) rollingVolume24h += (c1h[j].volume || 0);
      } else {
        rollingVolume24h += (c1h[t].volume || 0);
        const outgoingIdx = t - barsIn24h;
        if (outgoingIdx >= 0) rollingVolume24h -= (c1h[outgoingIdx].volume || 0);
      }
      volume24h = rollingVolume24h;
    }
    const coinData = {
      id: coinId,
      symbol: coinMeta.symbol,
      name: coinMeta.name,
      price: bar.close,
      change24h: t >= barsIn24h ? ((bar.close - c1h[t - barsIn24h].close) / c1h[t - barsIn24h].close) * 100 : 0,
      volume24h: volume24h ?? 0,
      marketCap: 0,
      lastUpdated: new Date(bar.openTime)
    };
    if (minVolume24hUsd > 0 && coinData.volume24h != null && coinData.volume24h > 0 && coinData.volume24h < minVolume24hUsd) continue;


    const options_bt = {
      strategyWeights: options.strategyWeights || [],
      strategyStats: options.strategyStats || {},
      disabledRegimesByCoin: options.disabledRegimesByCoin || {},
      btcSignal: F_BTC_FILTER ? cachedBtcSignal : null,
      btcDirection: F_BTC_CORRELATION ? cachedBtcDirection : null,
      btcCandles: F_BTC_CORRELATION && cachedBtcSlice ? cachedBtcSlice['1h'] : null,
      fundingRates: {},
      barTime: F_SESSION_FILTER ? bar.openTime : new Date('2026-01-01T15:00:00Z').getTime(),
      featurePriceActionConfluence: ft.priceActionConfluence === true,
      featureVolatilityFilter: ft.volatilityFilter === true,
      featureVolumeConfirmation: ft.volumeConfirmation === true,
      featureFundingRateFilter: ft.fundingRateFilter === true,
      featureThemeDetector: ft.themeDetector === true
    };

    // Re-evaluate BTC every ~4 hours regardless of primary TF
    const btcRecheckBars = Math.max(1, Math.round(4 / ({ '15m': 0.25, '1h': 1, '4h': 4, '1d': 24, '1w': 168 }[primaryTf] || 1)));
    const btcTf = btcCandles ? (btcCandles['1h'] ? '1h' : primaryTf) : '1h';
    if (btcCandles && btcCandles[btcTf] && (t - lastBtcAnalysisBar >= btcRecheckBars)) {
      const btc1h = btcCandles[btcTf];
      if (btcCursor >= btc1h.length) btcCursor = btc1h.length - 1;
      while (btcCursor + 1 < btc1h.length && btc1h[btcCursor + 1].openTime <= bar.openTime) btcCursor++;
      while (btcCursor > 0 && btc1h[btcCursor].openTime > bar.openTime) btcCursor--;
      const btcT = Math.min(Math.max(0, btcCursor), btc1h.length - 1);
      if (btcT >= 50) {
        const btcSlice = sliceCandlesAt(btcCandles, btcT, btcTf);
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
      closed: { [primaryTf]: true },
      closeBasedStops: F_CLOSE_STOPS,
      indicators: null
    };

    portfolioMeta = maybeResetDaily({ ...portfolioMeta, equity }, bar.openTime);
    if (portfolioMeta.dailyStartEquity == null) portfolioMeta.dailyStartEquity = equity;
    if (maxDailyLossPct != null && portfolioMeta.dailyStartEquity > 0) {
      const dailyLossPct = ((portfolioMeta.dailyStartEquity - equity) / portfolioMeta.dailyStartEquity) * 100;
      if (dailyLossPct >= maxDailyLossPct) portfolioMeta.killSwitch = true;
    }
    let portfolioState = { openTrades: position ? [position] : [], equity, killSwitch: portfolioMeta.killSwitch, dailyStartEquity: portfolioMeta.dailyStartEquity };

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
        entryTime: c1h[position.entryBar]?.openTime,
        breakevenRMult:  ft.breakevenRMult  ?? 0.75,
        trailingStartR:  ft.trailingStartR  ?? 1.5,
        trailingDistR:   ft.trailingDistR   ?? 1.5
      });

      let closed = false;
      for (const action of actions) {
        if (action.type === 'SL' || action.type === 'EXIT' || (action.type === 'TP1' && action.fullClose) || (action.type === 'TP2' && action.fullClose) || action.type === 'TP3') {
          const exitPrice = action.marketPrice || (action.type === 'SL' ? position.stopLoss : nextBar.close);
          const closeLeg = computeLegClosePnl(position.direction, position.entry, position.size, exitPrice, {
            feesEnabled: F_FEES,
            slippageEnabled: F_SLIPPAGE,
            slippageMultiplier
          });
          const totalPnl = (position.partialPnl || 0) + closeLeg.netPnl - (position.entryFees || 0);
          equity = Math.max(0, equity + closeLeg.netPnl);
          const exitReason = action.type === 'SL'
            ? (action.reason === 'TRAILING_TP_EXIT' ? 'TRAILING_TP_EXIT' : 'SL')
            : action.type === 'EXIT' ? 'SCORE_EXIT'
            : (action.type === 'TP1' && action.fullClose && !F_PARTIAL_TP) ? 'TP'
            : action.type;
          trades.push({
            direction: position.direction,
            entry: position.entry,
            exit: closeLeg.adjExit,
            initialEntry: position.initialEntry,
            entryBar: position.entryBar,
            entryTime: c1h[position.entryBar]?.openTime,
            exitBar: t + 1,
            exitTime: nextBar?.openTime,
            reason: exitReason,
            pnl: totalPnl,
            size: position.originalSize,
            lockedEntrySize: position.lockedEntrySize || position.originalSize,
            initialStopLoss: position.originalStopLoss,
            initialStopDistancePct: position.initialStopDistancePct,
            initialRiskAtStopDollars: position.initialRiskAtStopDollars,
            partials: position.partialPnl || 0,
            actions: [...(position.actions || [])],
            strategy: position.entryStrategy || position.strategy || 'Unknown',
            regime: position.regime
          });
          lastClosedBar = t + 1;
          lastClosedDirection = position.direction;
          streak = totalPnl > 0 ? Math.max(0, streak) + 1 : Math.min(0, streak) - 1;
          position = null;
          closed = true;
          break;
        }
        if (action.type === 'TP1' || action.type === 'TP2') {
          const portion = action.portion || 0;
          const exitPrice = action.marketPrice;
          const partialLeg = computeLegClosePnl(position.direction, position.entry, portion, exitPrice, {
            feesEnabled: F_FEES,
            slippageEnabled: F_SLIPPAGE,
            slippageMultiplier
          });
          equity = Math.max(0, equity + partialLeg.netPnl);
          position.partialPnl = (position.partialPnl || 0) + partialLeg.netPnl;
          position.size -= portion;
          position.actions.push({ type: action.type, bar: t + 1, portion, marketPrice: partialLeg.adjExit });
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
          const partialLeg = computeLegClosePnl(position.direction, position.entry, portion, action.marketPrice, {
            feesEnabled: F_FEES,
            slippageEnabled: F_SLIPPAGE,
            slippageMultiplier
          });
          equity = Math.max(0, equity + partialLeg.netPnl);
          position.partialPnl = (position.partialPnl || 0) + partialLeg.netPnl;
          position.size -= portion;
          position.actions.push({ type: action.type, bar: t + 1, portion, marketPrice: partialLeg.adjExit });
          if (action.type === 'RP') position.reducedByScore = true;
          if (action.type === 'PP') position.takenPartialByScore = true;
        }
      }
      if (closed) continue;

      // Preserve fields that action processing modified (primitives on the
      // position object are NOT shared with the shallow-copy updatedTrade).
      const sizeAfterPartials = position.size;
      const partialPnlAfterActions = position.partialPnl || 0;
      const entryFeesVal = position.entryFees || 0;
      const partialTP1 = position.partialTakenAtTP1;
      const partialTP2 = position.partialTakenAtTP2;
      const reducedScore = position.reducedByScore;
      const takenPartialScore = position.takenPartialByScore;

      position = updatedTrade;

      // Restore action-adjusted primitives so subsequent bars and the
      // final close use the correct remaining size and accumulated PnL.
      position.size = sizeAfterPartials;
      position.partialPnl = partialPnlAfterActions;
      position.entryFees = entryFeesVal;
      if (partialTP1) position.partialTakenAtTP1 = true;
      if (partialTP2) position.partialTakenAtTP2 = true;
      if (reducedScore) position.reducedByScore = true;
      if (takenPartialScore) position.takenPartialByScore = true;
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
            let addSize = position.originalSize * (dcaAddSizePct / 100);
            if (riskMode === 'dollar' && position.riskCapDollars > 0 && position.stopLoss > 0 && addSize > 0) {
              const isRiskSafe = (candidateAddSize) => {
                const projectedTotalSize = position.size + candidateAddSize;
                const projectedEntry = computeWeightedEntryPrice(position.entry, position.size, currentPrice, candidateAddSize);
                const maxAllowedSize = computeMaxRemainingSizeForRiskCap({
                  direction: position.direction,
                  entry: projectedEntry,
                  stopLoss: position.stopLoss,
                  riskCapDollars: position.riskCapDollars,
                  partialPnl: position.partialPnl || 0,
                  entryFees: position.entryFees || 0,
                  feesEnabled: F_FEES,
                  slippageEnabled: F_SLIPPAGE,
                  slippageMultiplier
                });
                return projectedTotalSize <= (maxAllowedSize + 1e-9);
              };
              if (!isRiskSafe(addSize)) {
                let lo = 0;
                let hi = addSize;
                for (let bi = 0; bi < 24; bi++) {
                  const mid = (lo + hi) / 2;
                  if (isRiskSafe(mid)) lo = mid;
                  else hi = mid;
                }
                addSize = lo;
              }
            }
            if (!(addSize > 0)) continue;
            const addFees = F_FEES ? addSize * TAKER_FEE : 0;
            const addMargin = addSize / leverage;
            if (equity >= addMargin + addFees) {
              const oldAvg = position.avgEntryPrice || position.entry;
              const newTotalSize = position.size + addSize;
              const newAvgEntry = computeWeightedEntryPrice(oldAvg, position.size, currentPrice, addSize);

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
    if (confidenceFilterEnabled && (Number(decision.confidence || 0) < minConfidence)) continue;
    if (F_BTC_FILTER && coinId !== 'bitcoin' && cachedBtcSignal) {
      if (decision.side === 'LONG' && cachedBtcSignal === 'STRONG_SELL') continue;
      if (decision.side === 'SHORT' && cachedBtcSignal === 'STRONG_BUY') continue;
    }
    if (!decision.stopLoss) continue;
    if (!ft.trailingTp && !decision.takeProfit1) continue;
    if (F_MIN_RR) {
      const rr = decision.riskReward ?? 0;
      if (rr < minRiskReward) continue;
    }

    if (ft.cooldown !== false && lastClosedDirection === decision.side && (t + 1 - lastClosedBar) < cooldownBars) continue;

    const canOpen = canOpenTrade(
      { openTrades: position ? [position] : [], equity, killSwitch: portfolioMeta.killSwitch, dailyStartEquity: portfolioMeta.dailyStartEquity },
      { maxConcurrentTrades: 1, dailyLossLimit: maxDailyLossPct, initialBalance }
    );
    if (!canOpen.ok) continue;

    const context = {
      balance: equity,
      peakEquity: drawdownSizingEnabled ? peakEquity : undefined,
      openTrades: position ? [position] : [],
      streak,
      strategyStats: options.strategyStats || {},
      featureFlags: ft,
      userSettings: {
        drawdownSizingEnabled,
        drawdownThresholdPercent,
        riskPerTrade: riskPerTrade * 100,
        riskMode,
        riskDollarsPerTrade,
        defaultLeverage: leverage,
        useFixedLeverage: true,
        maxBalancePercentPerTrade: 25,
        tpMode: ft.trailingTp ? 'trailing' : 'fixed',
        trailingTpDistanceMode: ft.trailingTpDistanceMode || 'atr',
        trailingTpAtrMultiplier: ft.trailingTpAtrMultiplier ?? 1.5,
        trailingTpFixedPercent: ft.trailingTpFixedPercent ?? 2
      }
    };

    const orders = plan(decision, snapshot, context);
    if (!orders) continue;

    // Fixed-$ risk mode: cap position size so estimated stop-out loss (including fees/slippage)
    // does not exceed the configured dollar risk.
    if (riskMode === 'dollar' && riskDollarsPerTrade > 0 && orders.entry > 0 && orders.stopLoss > 0) {
      const stopDistancePct = Math.abs(orders.entry - orders.stopLoss) / orders.entry;
      const estFeePct = F_FEES ? (TAKER_FEE * 2) : 0; // entry + exit
      const estSlipPct = F_SLIPPAGE ? ((SLIPPAGE_BPS * slippageMultiplier) / 10000) : 0; // adverse exit buffer
      const estTotalLossPct = stopDistancePct + estFeePct + estSlipPct;
      if (Number.isFinite(estTotalLossPct) && estTotalLossPct > 0) {
        const maxSizeForFixedRisk = riskDollarsPerTrade / estTotalLossPct;
        if (Number.isFinite(maxSizeForFixedRisk) && maxSizeForFixedRisk > 0) {
          orders.size = Math.min(orders.size, maxSizeForFixedRisk);
        }
      }
    }

    const execSnapshot = {
      currentPrice: nextBar.open,
      coinData: { ...coinData, price: nextBar.open },
      indicators: decision.indicators
    };
    const fillResult = execute(
      { direction: orders.direction, size: orders.size, entry: orders.entry, orderType: 'market' },
      execSnapshot,
      { takerFee: F_FEES ? TAKER_FEE : 0, minSlipBps: F_SLIPPAGE ? SLIPPAGE_BPS : 0, slippageMultiplier }
    );
    if (!fillResult.filled) continue;

    const entryFees = F_FEES ? orders.size * TAKER_FEE : 0;
    if (entryFees + (orders.size / orders.leverage) > equity) continue;

    equity -= entryFees;

    const stopAdjAtEntry = getAdjustedExitPrice(
      orders.direction,
      orders.stopLoss,
      F_SLIPPAGE,
      slippageMultiplier
    );
    const initialStopDistancePct = orders.direction === 'LONG'
      ? Math.max(0, (fillResult.fillPrice - stopAdjAtEntry) / fillResult.fillPrice)
      : Math.max(0, (stopAdjAtEntry - fillResult.fillPrice) / fillResult.fillPrice);
    const initialPerDollarLossAtStop = initialStopDistancePct + (F_FEES ? (TAKER_FEE * 2) : 0);
    const initialRiskAtStopDollars = orders.size * initialPerDollarLossAtStop;

    position = {
      direction: orders.direction,
      entry: fillResult.fillPrice,
      entryPrice: fillResult.fillPrice,
      initialEntry: fillResult.fillPrice,
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
      lockedEntrySize: orders.size,
      originalPositionSize: orders.size,
      initialStopDistancePct,
      initialRiskAtStopDollars,
      tp1Hit: false,
      tp2Hit: false,
      breakevenHit: false,
      trailingActivated: orders.tpMode === 'trailing',
      reducedByScore: false,
      takenPartialByScore: false,
      maxPrice: fillResult.fillPrice,
      minPrice: fillResult.fillPrice,
      partialPnl: 0,
      entryFees,
      lastScoreCheckBar: t + 1,
      actions: [],
      tpMode: orders.tpMode || 'fixed',
      trailingTpDistance: orders.trailingTpDistance,
      regime: orders.regime,
      indicators: decision.indicators,
      leverage: orders.leverage || leverage,
      riskCapDollars: riskMode === 'dollar' ? riskDollarsPerTrade : null,
      dcaCount: 0,
      dcaEntries: []
    };
  }

  if (position) {
    const lastBar = c1h[c1h.length - 1];
    const closeLeg = computeLegClosePnl(position.direction, position.entry, position.size, lastBar.close, {
      feesEnabled: F_FEES,
      slippageEnabled: F_SLIPPAGE,
      slippageMultiplier
    });
    const totalPnl = (position.partialPnl || 0) + closeLeg.netPnl - (position.entryFees || 0);
    equity = Math.max(0, equity + closeLeg.netPnl);
    trades.push({
      direction: position.direction,
      entry: position.entry,
      exit: closeLeg.adjExit,
      initialEntry: position.initialEntry,
      entryBar: position.entryBar,
      entryTime: c1h[position.entryBar]?.openTime,
      exitBar: c1h.length - 1,
      exitTime: c1h[c1h.length - 1]?.openTime,
      reason: 'END',
      pnl: totalPnl,
      size: position.originalSize,
      lockedEntrySize: position.lockedEntrySize || position.originalSize,
      initialStopLoss: position.originalStopLoss,
      initialStopDistancePct: position.initialStopDistancePct,
      initialRiskAtStopDollars: position.initialRiskAtStopDollars,
      partials: position.partialPnl || 0,
      actions: position.actions || [],
      strategy: position.entryStrategy || position.strategy || 'Unknown',
      regime: position.regime
    });
  }

  // Final bar equity point
  barEquity.push({ t: c1h.length - 1, equity, date: c1h[c1h.length - 1]?.openTime });

  // Trade-based equity curve (for UI charts)
  // Mirror the simulation's Math.max(0, …) floor so DD never exceeds 100%
  const equityCurve = [{ t: 0, equity: initialBalance, date: c1h[0]?.openTime, pnl: 0 }];
  let runningEquity = initialBalance;
  trades.forEach((tr, i) => {
    runningEquity = Math.max(0, runningEquity + tr.pnl);
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

  const allActions = [];
  for (const tr of trades) {
    if (!tr.actions || tr.actions.length === 0) continue;
    for (const a of tr.actions) allActions.push(a.type);
  }
  const actionCounts = {
    BE: allActions.filter(a => a === 'BE').length,
    TS: allActions.filter(a => a === 'TS').length,
    PP: allActions.filter(a => a === 'PP').length,
    RP: allActions.filter(a => a === 'RP').length,
    EXIT: allActions.filter(a => a === 'EXIT').length,
    LOCK: allActions.filter(a => a === 'LOCK').length,
    DCA: allActions.filter(a => a === 'DCA').length
  };

  const exitReasons = {};
  trades.forEach(t => { exitReasons[t.reason] = (exitReasons[t.reason] || 0) + 1; });

  const strategyBreakdown = breakdownByStrategy(trades);
  const byYear = breakdownByYear(trades);
  // Two drawdown views:
  // - MTM (bar-by-bar): includes unrealized movement while a trade is open.
  // - Realized (trade-by-trade): based on closed-trade equity only (matches equityCurve chart).
  const maxDrawdownMtm = computeMaxDrawdown(barEquity);
  const maxDrawdownPctMtm = computeMaxDrawdownPct(barEquity);
  const maxDrawdownRealized = computeMaxDrawdown(equityCurve);
  const maxDrawdownPctRealized = computeMaxDrawdownPct(equityCurve);

  const summary = {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    totalPnl,
    returnPct: (totalPnl / initialBalance) * 100,
    profitFactor,
    maxDrawdownPct: maxDrawdownPctRealized,
    maxDrawdownPctMtm,
    maxDrawdownPctRealized,
    riskMode,
    requestedRiskDollarsPerTrade,
    appliedRiskDollarsPerTrade: riskDollarsPerTrade,
    riskWarning: riskDollarWarning
  };
  const evaluation = evaluateBacktest(summary, trades, { byYear });

  const firstBarTime = c1h[tradeStartBar]?.openTime || c1h[0]?.openTime || startMs;
  const lastBarTime  = c1h[c1h.length - 1]?.openTime || endMs;

  return {
    coinId,
    symbol: coinMeta.symbol,
    startMs,
    endMs,
    firstBarTime,
    lastBarTime,
    bars: c1h.length,
    trades,
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    totalPnl,
    profitFactor,
    finalEquity: equity,
    returnPct: (totalPnl / initialBalance) * 100,
    equityCurve,
    // Backward-compatible — now uses realized (matches equity curve chart)
    maxDrawdown: maxDrawdownRealized,
    maxDrawdownPct: maxDrawdownPctRealized,
    // Explicit fields so consumers can pick the intended definition
    maxDrawdownMtm,
    maxDrawdownPctMtm,
    maxDrawdownRealized,
    maxDrawdownPctRealized,
    sharpeRatio,
    strategyBreakdown,
    actionCounts,
    exitReasons,
    byYear,
    evaluation,
    riskWarning: riskDollarWarning
  };
}

module.exports = {
  runBacktestForCoin
};
