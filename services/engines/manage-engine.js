// services/engines/manage-engine.js
// ====================================================
// MANAGE ENGINE - Single source of truth for trade management actions
// Extracted from paper-trading._checkStopsAndTPsInner. Pure function: no DB.
// Returns suggested actions; caller executes them (closeTrade, closeTradePartial, update SL).
// ====================================================

const LOCK_IN_LEVELS = [
  { progress: 0.5, lockR: 0.5 },
  { progress: 0.75, lockR: 0.75 },
  { progress: 0.9, lockR: 1 }
];

const TP1_PCT = 0.4;
const TP2_PCT = 0.3;
const TP3_PCT = 0.3;

const BE_R_MULT = 0.75;  // Breakeven at 0.75R (matches paper-trading)
const TRAILING_START_R = 1.5;
const TRAILING_DIST_R = 1.5;  // Must match paper-trading: trail 1.5R behind max price
const BE_BUFFER = 0.003;

function getProgressTowardTP(trade, currentPrice) {
  const tp = trade.takeProfit2 || trade.takeProfit1 || trade.takeProfit3;
  if (!tp || !trade.entryPrice || tp === trade.entryPrice) return 0;
  const isLong = trade.direction === 'LONG';
  if (isLong && tp > trade.entryPrice) {
    return Math.min(1, (currentPrice - trade.entryPrice) / (tp - trade.entryPrice));
  }
  if (!isLong && tp < trade.entryPrice) {
    return Math.min(1, (trade.entryPrice - currentPrice) / (trade.entryPrice - tp));
  }
  return 0;
}

function getLockInStopPrice(trade, lockR, risk) {
  if (!risk || risk <= 0) return null;
  const r2 = (v) => Math.round(v * 1000000) / 1000000;
  const isLong = trade.direction === 'LONG';
  return isLong
    ? r2(trade.entryPrice + risk * lockR)
    : r2(trade.entryPrice - risk * lockR);
}

function getCurrentLockR(trade, risk) {
  if (!trade.stopLoss || !risk || risk <= 0) return 0;
  const isLong = trade.direction === 'LONG';
  const dist = isLong
    ? (trade.stopLoss || 0) - trade.entryPrice
    : trade.entryPrice - (trade.stopLoss || 0);
  if (dist <= 0) return 0;
  return dist / risk;
}

/**
 * Compute suggested management actions for an open trade.
 * Pure function: does NOT execute closes or DB updates.
 * @param {Object} openTrade - Trade state (plain object): entryPrice, stopLoss, direction, positionSize, etc.
 * @param {Object} snapshot - { currentPrice, high?, low?, open?, recheckSignal?, timestamp?, barIndex? }
 * @param {Object} opts - { featureFlags, stopGraceMinutes, entryTime }
 * @returns {Object} { actions: [...], updatedTrade?: {...} }
 */
function update(openTrade, snapshot, opts) {
  opts = opts || {};
  const ff = opts.featureFlags || {};
  const stopGraceMinutes = opts.stopGraceMinutes ?? 2;
  const entryTime = opts.entryTime || openTrade.createdAt || openTrade.entryTime;

  const actions = [];
  const trade = { ...openTrade };

  const currentPrice = snapshot.currentPrice;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { actions: [], updatedTrade: trade };
  }

  // Update max/min from bar if provided
  const high = snapshot.high ?? currentPrice;
  const low = snapshot.low ?? currentPrice;
  if (high > (trade.maxPrice || 0)) trade.maxPrice = high;
  if (low < (trade.minPrice || Infinity)) trade.minPrice = low;

  const isLong = trade.direction === 'LONG';
  const origSl = trade.originalStopLoss ?? trade.stopLoss;
  let risk = isLong
    ? trade.entryPrice - (origSl ?? trade.entryPrice * 0.98)
    : (origSl ?? trade.entryPrice * 1.02) - trade.entryPrice;
  if (risk <= 0) {
    const tp = trade.takeProfit2 || trade.takeProfit1 || trade.takeProfit3;
    if (tp) risk = Math.abs(trade.entryPrice - tp) / (tp === trade.takeProfit2 ? 2 : 1);
    else risk = trade.entryPrice * 0.02;
  }

  const ageMs = (snapshot.timestamp ? snapshot.timestamp : Date.now()) - new Date(entryTime).getTime();
  const pastStopGrace = ageMs >= stopGraceMinutes * 60 * 1000;

  // --- Breakeven ---
  if (pastStopGrace && ff.breakeven !== false && risk > 0 && trade.stopLoss != null &&
      !trade.breakevenHit && !trade.trailingActivated) {
    const atBE = isLong
      ? currentPrice >= trade.entryPrice + risk * BE_R_MULT
      : currentPrice <= trade.entryPrice - risk * BE_R_MULT;
    if (atBE) {
      const newStop = isLong
        ? trade.entryPrice * (1 + BE_BUFFER)
        : trade.entryPrice * (1 - BE_BUFFER);
      const validMove = isLong ? newStop > trade.stopLoss : newStop < trade.stopLoss;
      if (validMove) {
        actions.push({ type: 'BE', newStop, oldStop: trade.stopLoss, marketPrice: currentPrice });
        trade.stopLoss = newStop;
        trade.breakevenHit = true;
      }
    }
  }

  // --- Trailing TP mode ---
  if (trade.tpMode === 'trailing' && trade.trailingTpDistance > 0) {
    trade.trailingActivated = true;
    const trailDist = trade.trailingTpDistance;
    const bestP = isLong ? trade.maxPrice : trade.minPrice;
    const trailSL = isLong ? bestP - trailDist : bestP + trailDist;
    const r2 = (v) => Math.round(v * 1000000) / 1000000;
    const newStop = r2(trailSL);
    const validMove = isLong ? newStop > trade.stopLoss && newStop < currentPrice : newStop < trade.stopLoss && newStop > currentPrice;
    if (validMove) {
      actions.push({ type: 'TS', newStop, oldStop: trade.stopLoss, marketPrice: currentPrice });
      trade.stopLoss = newStop;
    }
  } else if (trade.tpMode !== 'trailing') {
    // --- Standard trailing stop at 1.5R+ ---
    const stopPastEntry = isLong ? trade.stopLoss >= trade.entryPrice : trade.stopLoss <= trade.entryPrice;
    if (pastStopGrace && ff.trailingStop !== false && (stopPastEntry || trade.trailingActivated) && risk > 0) {
      const at1_5R = isLong
        ? currentPrice >= trade.entryPrice + risk * TRAILING_START_R
        : currentPrice <= trade.entryPrice - risk * TRAILING_START_R;
      if (at1_5R) {
        trade.trailingActivated = true;
        const bestP = isLong ? trade.maxPrice : trade.minPrice;
        const trailSL = isLong
          ? bestP - (TRAILING_DIST_R * risk)
          : bestP + (TRAILING_DIST_R * risk);
        const r2 = (v) => Math.round(v * 1000000) / 1000000;
        const newStop = r2(trailSL);
        const validMove = isLong ? newStop > trade.stopLoss && newStop < currentPrice : newStop < trade.stopLoss && newStop > currentPrice;
        if (validMove) {
          actions.push({ type: 'TS', newStop, oldStop: trade.stopLoss, marketPrice: currentPrice });
          trade.stopLoss = newStop;
        }
      }
    }
  }

  // --- Stepped profit lock-in ---
  if (pastStopGrace && ff.lockIn !== false && risk > 0 && trade.stopLoss != null) {
    const progress = getProgressTowardTP(trade, currentPrice);
    let effectiveProgress = progress;
    if (progress <= 0 && trade.entryPrice > 0) {
      const lev = trade.leverage || 1;
      const pnlPct = (isLong
        ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100
        : (trade.entryPrice - currentPrice) / trade.entryPrice * 100) * lev;
      if (pnlPct >= 5) effectiveProgress = 0.9;
      else if (pnlPct >= 2) effectiveProgress = 0.5;
    }
    const currentLockR = getCurrentLockR(trade, risk);
    for (const level of LOCK_IN_LEVELS) {
      if (effectiveProgress >= level.progress && currentLockR < level.lockR) {
        const newStop = getLockInStopPrice(trade, level.lockR, risk);
        if (newStop) {
          const validMove = isLong ? newStop > trade.stopLoss && newStop < currentPrice : newStop < trade.stopLoss && newStop > currentPrice;
          if (validMove) {
            actions.push({ type: 'LOCK', lockR: level.lockR, newStop, oldStop: trade.stopLoss, marketPrice: currentPrice });
            trade.stopLoss = newStop;
          }
        }
        break;
      }
    }
  }

  // --- Score re-check (EXIT, RP, PP) ---
  const recheckSignal = snapshot.recheckSignal;
  if (ff.scoreRecheck !== false && recheckSignal) {
    const entryScore = trade.entryScore ?? trade.score ?? 50;
    const currentScore = recheckSignal.score ?? 0;
    const scoreDiff = currentScore - entryScore;
    const signalFlipped = isLong
      ? (recheckSignal.signal === 'SELL' || recheckSignal.signal === 'STRONG_SELL')
      : (recheckSignal.signal === 'BUY' || recheckSignal.signal === 'STRONG_BUY');
    let effectiveDiff = scoreDiff;
    if (signalFlipped) effectiveDiff = Math.min(effectiveDiff, -15);
    else if (recheckSignal.signal === 'HOLD') effectiveDiff -= 4;

    const pnlPct = (isLong
      ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100
      : (trade.entryPrice - currentPrice) / trade.entryPrice * 100) * (trade.leverage || 1);

    // EXIT: score collapsed, signal flipped, in loss
    const wouldExit = effectiveDiff <= -45 || (signalFlipped && effectiveDiff <= -40);
    const blockExit = pnlPct >= 0 || (pnlPct > -5);
    if (wouldExit && !blockExit && pnlPct <= -8) {
      actions.push({ type: 'EXIT', marketPrice: currentPrice, reason: 'SCORE_CHECK_EXIT' });
      return { actions, updatedTrade: trade };
    }

    // RP: reduce position 30% (matches paper-trading: less destructive per trigger)
    const wouldReduce = effectiveDiff <= -25 || (signalFlipped && effectiveDiff <= -20);
    if (wouldReduce && pnlPct < 0 && !trade.reducedByScore) {
      const portion = Math.round((trade.positionSize * 0.3) * 100) / 100;
      if (portion > 1) {
        actions.push({ type: 'RP', portion, marketPrice: currentPrice, reason: 'SCORE_CHECK_REDUCE' });
        trade.reducedByScore = true;
        trade.positionSize -= portion;
      }
    }

    // PP: take partial 1/3 near TP1
    const wouldTakePartial = effectiveDiff < 0 && effectiveDiff > -25 && pnlPct < 0 && !trade.takenPartialByScore;
    const tp1 = trade.takeProfit1;
    const nearTP1 = tp1 && (isLong ? currentPrice >= tp1 * 0.98 : currentPrice <= tp1 * 1.02);
    if (wouldTakePartial && nearTP1) {
      const portion = Math.round((trade.originalPositionSize / 3) * 100) / 100;
      if (portion > 1 && portion < trade.positionSize) {
        actions.push({ type: 'PP', portion, marketPrice: currentPrice, reason: 'SCORE_CHECK_PARTIAL' });
        trade.takenPartialByScore = true;
        trade.positionSize -= portion;
      }
    }
  }

  // --- Stop loss hit ---
  if (trade.stopLoss != null) {
    const slCheckPrice = snapshot.closeBasedStops !== false ? currentPrice : (isLong ? low : high);
    const stopped = isLong ? slCheckPrice <= trade.stopLoss : slCheckPrice >= trade.stopLoss;
    if (stopped) {
      const isTrailingTpExit = trade.tpMode === 'trailing' && trade.trailingActivated;
      actions.push({ type: 'SL', marketPrice: trade.stopLoss, reason: isTrailingTpExit ? 'TRAILING_TP_EXIT' : 'STOPPED_OUT' });
      return { actions, updatedTrade: trade };
    }
  }

  // --- Take profit hits (only if not trailing TP mode) ---
  // Use bar high/low when provided (backtest OHLC); else currentPrice (live polling)
  if (trade.tpMode !== 'trailing') {
    const orig = trade.originalPositionSize || trade.positionSize;
    const tpHigh = snapshot.high != null ? high : currentPrice;
    const tpLow = snapshot.low != null ? low : currentPrice;
    const hitTP1 = isLong ? tpHigh >= (trade.takeProfit1 || 0) : tpLow <= (trade.takeProfit1 || Infinity);
    const hitTP2 = isLong ? tpHigh >= (trade.takeProfit2 || 0) : tpLow <= (trade.takeProfit2 || Infinity);
    const hitTP3 = isLong ? tpHigh >= (trade.takeProfit3 || 0) : tpLow <= (trade.takeProfit3 || Infinity);

    if (hitTP1 && !trade.partialTakenAtTP1 && trade.takeProfit1) {
      const portion = ff.partialTP !== false && (trade.takeProfit2 || trade.takeProfit3)
        ? Math.round((orig * TP1_PCT) * 100) / 100
        : trade.positionSize;
      const fullClose = !ff.partialTP || (!trade.takeProfit2 && !trade.takeProfit3);
      actions.push({ type: 'TP1', portion, fullClose, marketPrice: trade.takeProfit1 });
      trade.partialTakenAtTP1 = true;
      if (fullClose) return { actions, updatedTrade: trade };
      trade.positionSize -= portion;
    }
    if (hitTP2 && !trade.partialTakenAtTP2 && trade.takeProfit2) {
      const portion = trade.takeProfit3
        ? Math.round((orig * TP2_PCT) * 100) / 100
        : trade.positionSize;
      const fullClose = !trade.takeProfit3;
      actions.push({ type: 'TP2', portion, fullClose, marketPrice: trade.takeProfit2 });
      trade.partialTakenAtTP2 = true;
      if (fullClose) return { actions, updatedTrade: trade };
      trade.positionSize -= portion;
    }
    if (hitTP3 && trade.takeProfit3) {
      actions.push({ type: 'TP3', portion: trade.positionSize, fullClose: true, marketPrice: trade.takeProfit3 });
      return { actions, updatedTrade: trade };
    }
  }

  return { actions, updatedTrade: trade };
}

module.exports = {
  update,
  LOCK_IN_LEVELS,
  TP1_PCT,
  TP2_PCT,
  TP3_PCT,
  getProgressTowardTP,
  getLockInStopPrice,
  getCurrentLockR
};
