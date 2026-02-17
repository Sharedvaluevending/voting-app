// services/backtest/intrabar-path.js
// ====================================================
// INTRABAR OHLC PATH - Deterministic candle path for fill simulation
// Bullish: O->L->H->C or O->H->L->C
// Bearish: O->H->L->C or O->L->H->C
// Policies: WORST_CASE, BEST_CASE, RANDOM_SEEDED
// ====================================================

const POLICY = {
  WORST_CASE: 'WORST_CASE',
  BEST_CASE: 'BEST_CASE',
  RANDOM_SEEDED: 'RANDOM_SEEDED'
};

/**
 * Seeded random for RANDOM_SEEDED policy (repeatable)
 */
function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/**
 * Get ordered price sequence for candle path
 * Returns [p0, p1, p2, p3] where p0=open, p3=close
 * WORST_CASE: path that harms (SL before TP). BEST_CASE: path that favors (TP before SL).
 */
function getPathSequence(bar, direction, policy, seed) {
  const { open, high, low, close } = bar;
  const isBullish = close > open;

  if (policy === POLICY.RANDOM_SEEDED) {
    const rng = seededRandom(seed || 12345);
    if (isBullish) {
      return rng() < 0.5 ? [open, low, high, close] : [open, high, low, close];
    }
    return rng() < 0.5 ? [open, high, low, close] : [open, low, high, close];
  }

  // Bullish: O->L->H->C (hit low first) or O->H->L->C (hit high first)
  // Bearish: O->H->L->C (hit high first) or O->L->H->C (hit low first)
  // LONG worst = hit low first (SL). LONG best = hit high first (TP)
  // SHORT worst = hit high first (SL). SHORT best = hit low first (TP)
  const hitLowFirst = isBullish ? [open, low, high, close] : [open, low, high, close];
  const hitHighFirst = isBullish ? [open, high, low, close] : [open, high, low, close];

  if (policy === POLICY.WORST_CASE) {
    return direction === 'LONG' ? hitLowFirst : hitHighFirst;
  }
  if (policy === POLICY.BEST_CASE) {
    return direction === 'LONG' ? hitHighFirst : hitLowFirst;
  }

  return isBullish ? [open, low, high, close] : [open, high, low, close];
}

/**
 * Determine which levels are hit and in what order given the path
 * Returns ordered list of events: [{ type: 'SL'|'TP1'|'TP2'|'TP3', price, hitAt }]
 */
function getLevelHits(bar, trade, policy, seed) {
  const seq = getPathSequence(bar, trade.direction, policy, seed);
  const levels = [];
  if (trade.stopLoss != null) levels.push({ type: 'SL', price: trade.stopLoss });
  if (trade.takeProfit1 != null) levels.push({ type: 'TP1', price: trade.takeProfit1 });
  if (trade.takeProfit2 != null) levels.push({ type: 'TP2', price: trade.takeProfit2 });
  if (trade.takeProfit3 != null) levels.push({ type: 'TP3', price: trade.takeProfit3 });

  const isLong = trade.direction === 'LONG';
  const hits = [];

  for (let i = 0; i < seq.length - 1; i++) {
    const p0 = seq[i];
    const p1 = seq[i + 1];
    const goingDown = p1 < p0;
    const goingUp = p1 > p0;

    for (const lev of levels) {
      if (hits.some(h => h.type === lev.type)) continue;
      const inRange = (lev.price >= Math.min(p0, p1) && lev.price <= Math.max(p0, p1));
      if (!inRange) continue;
      const wouldHit = isLong
        ? (lev.type === 'SL' && goingDown && p1 <= lev.price && lev.price <= p0)
          || (lev.type.startsWith('TP') && goingUp && p1 >= lev.price && lev.price >= p0)
        : (lev.type === 'SL' && goingUp && p1 >= lev.price && lev.price >= p0)
          || (lev.type.startsWith('TP') && goingDown && p1 <= lev.price && lev.price <= p0);
      if (wouldHit) {
        hits.push({ type: lev.type, price: lev.price, hitAt: i + 1 });
      }
    }
  }

  return hits;
}

/**
 * Resolve SL vs TP conflict when both could hit in same bar
 * Uses path to determine which hits first
 */
function resolveFirstHit(bar, trade, policy, seed) {
  const hits = getLevelHits(bar, trade, policy, seed);
  return hits[0] || null;
}

module.exports = {
  POLICY,
  getPathSequence,
  getLevelHits,
  resolveFirstHit,
  seededRandom
};
