// services/backtest/market-data.js
// ====================================================
// MARKET DATA MODEL - Time-aligned snapshots for backtesting
// Higher TF candles only update when they CLOSE (realistic).
// ====================================================

const TF_ORDER = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const MS_PER_TF = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 3600000,
  '4h': 4 * 3600000,
  '1d': 24 * 3600000,
  '1w': 7 * 24 * 3600000
};

// Bars of base TF per higher TF (for slice logic)
const BARS_PER_TF = {
  '1m': { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 },
  '5m': { '15m': 3, '1h': 12, '4h': 48, '1d': 288, '1w': 2016 },
  '15m': { '1h': 4, '4h': 16, '1d': 96, '1w': 672 },
  '1h': { '4h': 4, '1d': 24, '1w': 168 },
  '4h': { '1d': 6, '1w': 42 },
  '1d': { '1w': 7 }
};

/**
 * Slice candles at bar index t for base timeframe.
 * Higher TFs only include CLOSED bars (realistic time alignment).
 * @param {Object} candles - { '1h': [...], '4h': [...], '1d': [...] }
 * @param {number} t - Bar index in base TF
 * @param {string} baseTf - '1m'|'5m'|'15m'|'1h'
 * @returns {Object|null} Slice of candles for analysis
 */
function sliceCandlesAt(candles, t, baseTf) {
  baseTf = baseTf || '1h';
  const baseCandles = candles[baseTf];
  if (!candles || !baseCandles || t >= baseCandles.length) return null;

  const slice = { [baseTf]: baseCandles.slice(0, t + 1) };
  const ratios = BARS_PER_TF[baseTf];
  if (!ratios) {
    slice['4h'] = candles['4h'] || null;
    slice['1d'] = candles['1d'] || null;
    slice['15m'] = candles['15m'] || null;
    slice['1w'] = candles['1w'] || null;
  } else {
    for (const [htf, barsPer] of Object.entries(ratios)) {
      const arr = candles[htf];
      if (!arr || arr.length === 0) {
        slice[htf] = null;
        continue;
      }
      // Only include closed bars: at bar t we have floor((t+1)/barsPer) complete htf bars
      const closedCount = Math.floor((t + 1) / barsPer);
      slice[htf] = closedCount > 0 ? arr.slice(0, closedCount) : null;
    }
  }

  // Engine needs at least 20 bars for 1h
  const minBars = baseTf === '1h' ? 20 : 5;
  if (slice[baseTf].length < minBars) return null;
  return slice;
}

/**
 * Build snapshot for a given bar.
 * @param {Object} candles - Multi-TF candles
 * @param {number} t - Bar index
 * @param {string} baseTf - Base timeframe
 * @param {string} coinId - Coin identifier
 * @param {Object} coinMeta - { symbol, name }
 * @param {Object} nextBar - Next bar (for OHLC in snapshot; used for execution)
 * @returns {Object} snapshot
 */
function buildSnapshot(candles, t, baseTf, coinId, coinMeta, nextBar) {
  baseTf = baseTf || '1h';
  const baseCandles = candles[baseTf];
  if (!baseCandles || t >= baseCandles.length) return null;

  const bar = baseCandles[t];
  const slice = sliceCandlesAt(candles, t, baseTf);
  if (!slice) return null;

  const price = bar.close;
  const prev24Idx = baseTf === '1h' ? 24 : baseTf === '15m' ? 96 : baseTf === '5m' ? 288 : 60;
  const prev24 = t >= prev24Idx && baseCandles[t - prev24Idx] ? baseCandles[t - prev24Idx].close : 0;
  const change24h = prev24 > 0 ? ((price - prev24) / prev24) * 100 : 0;

  const coinData = {
    id: coinId,
    symbol: coinMeta?.symbol || coinId.toUpperCase(),
    name: coinMeta?.name || coinId,
    price,
    change24h,
    volume24h: 0,
    marketCap: 0,
    lastUpdated: new Date(bar.openTime)
  };

  // Which TFs closed this bar? (bar just closed)
  const closed = {};
  const ratios = BARS_PER_TF[baseTf];
  if (ratios) {
    for (const [htf, barsPer] of Object.entries(ratios)) {
      closed[htf] = (t + 1) % barsPer === 0;
    }
  }
  closed[baseTf] = true; // Current bar is the one we're evaluating

  const snapshot = {
    timestamp: bar.openTime,
    baseTf,
    candles: slice,
    coinData,
    history: { prices: [], volumes: [], marketCaps: [] },
    closed,
    bar,
    nextBar: nextBar || baseCandles[t + 1] || bar
  };

  return snapshot;
}

/**
 * Aggregate 1m candles to higher timeframes (for 2-year 1m runs).
 * @param {Array} candles1m - 1m candles
 * @returns {Object} { '1m': [...], '5m': [...], '15m': [...], '1h': [...], '4h': [...], '1d': [...] }
 */
function aggregateFrom1m(candles1m) {
  if (!candles1m || candles1m.length === 0) return null;

  const result = { '1m': candles1m };
  const tfConfigs = [
    { tf: '5m', n: 5 },
    { tf: '15m', n: 15 },
    { tf: '1h', n: 60 },
    { tf: '4h', n: 240 },
    { tf: '1d', n: 1440 }
  ];

  for (const { tf, n } of tfConfigs) {
    const agg = [];
    for (let i = n - 1; i < candles1m.length; i += n) {
      const chunk = candles1m.slice(i - n + 1, i + 1);
      const open = chunk[0].open;
      const close = chunk[chunk.length - 1].close;
      const high = Math.max(...chunk.map(c => c.high));
      const low = Math.min(...chunk.map(c => c.low));
      const volume = chunk.reduce((s, c) => s + (c.volume || 0), 0);
      agg.push({
        openTime: chunk[0].openTime,
        open,
        high,
        low,
        close,
        volume,
        closeTime: chunk[chunk.length - 1].closeTime || chunk[chunk.length - 1].openTime + MS_PER_TF[tf]
      });
    }
    result[tf] = agg;
  }
  return result;
}

/**
 * SnapshotAggregator - iterates over bars, yields time-aligned snapshots
 */
class SnapshotAggregator {
  constructor(candles, baseTf, coinId, coinMeta) {
    this.candles = candles;
    this.baseTf = baseTf || '1h';
    this.coinId = coinId;
    this.coinMeta = coinMeta || {};
    this.baseCandles = candles[this.baseTf];
    this.length = this.baseCandles ? this.baseCandles.length : 0;
  }

  getSnapshot(t) {
    if (t < 0 || t >= this.length - 1) return null;
    const nextBar = this.baseCandles[t + 1];
    return buildSnapshot(this.candles, t, this.baseTf, this.coinId, this.coinMeta, nextBar);
  }

  *[Symbol.iterator]() {
    for (let t = 0; t < this.length - 1; t++) {
      const snap = this.getSnapshot(t);
      if (snap) yield { t, snapshot: snap, nextBar: this.baseCandles[t + 1] };
    }
  }
}

module.exports = {
  sliceCandlesAt,
  buildSnapshot,
  aggregateFrom1m,
  SnapshotAggregator,
  MS_PER_TF,
  BARS_PER_TF,
  TF_ORDER
};
