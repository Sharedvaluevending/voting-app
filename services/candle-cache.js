const mongoose = require('mongoose');
const CandleCache = require('../models/CandleCache');
const { fetchHistoricalCandlesForCoin, TRACKED_COINS, COIN_META } = require('./crypto-api');

const CACHE_TIMEFRAMES = ['15m', '1h', '4h', '1d', '1w'];
const MS_PER_TIMEFRAME = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000
};
const THREE_YEARS_MS = 3 * 365 * 24 * 60 * 60 * 1000;

function normalizeTimeframe(tf) {
  const v = String(tf || '').toLowerCase();
  if (v === '1h') return '1h';
  if (v === '4h') return '4h';
  if (v === '1d') return '1d';
  if (v === '15m') return '15m';
  if (v === '1w') return '1w';
  return null;
}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function toCacheDocs(coinId, timeframe, candles) {
  return (candles || []).map((c) => ({
    coinId,
    timeframe,
    timestamp: Number(c.openTime),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume || 0),
    updatedAt: new Date()
  })).filter((c) => Number.isFinite(c.timestamp) && c.timestamp > 0);
}

function toEngineCandles(rows, timeframe) {
  const tfMs = MS_PER_TIMEFRAME[timeframe] || 3600000;
  return (rows || []).map((r) => ({
    openTime: r.timestamp,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume || 0,
    closeTime: r.timestamp + tfMs,
    quoteVolume: 0,
    trades: 0,
    takerBuyVolume: 0,
    takerBuyQuoteVolume: 0
  }));
}

async function bulkUpsertCandles(coinId, timeframe, candles) {
  if (!isDbReady()) return { insertedOrUpdated: 0 };
  const docs = toCacheDocs(coinId, timeframe, candles);
  if (docs.length === 0) return { insertedOrUpdated: 0 };

  const ops = docs.map((d) => ({
    updateOne: {
      filter: { coinId: d.coinId, timeframe: d.timeframe, timestamp: d.timestamp },
      update: {
        $set: {
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: d.volume,
          updatedAt: d.updatedAt
        },
        $setOnInsert: {
          coinId: d.coinId,
          timeframe: d.timeframe,
          timestamp: d.timestamp
        }
      },
      upsert: true
    }
  }));

  const out = await CandleCache.bulkWrite(ops, { ordered: false });
  const inserted = Number(out.upsertedCount || 0);
  const modified = Number(out.modifiedCount || 0);
  return { insertedOrUpdated: inserted + modified };
}

async function readCachedCandles(coinId, timeframe, startMs, endMs) {
  if (!isDbReady()) return [];
  const rows = await CandleCache.find({
    coinId,
    timeframe,
    timestamp: { $gte: startMs, $lte: endMs }
  }).sort({ timestamp: 1 }).lean();
  return toEngineCandles(rows, timeframe);
}

async function fetchAndCacheCandles(coinId, timeframe, startMs, endMs) {
  const candles = await fetchHistoricalCandlesForCoin(coinId, timeframe, startMs, endMs);
  await bulkUpsertCandles(coinId, timeframe, candles);
  return candles || [];
}

async function getCandles(coinId, timeframe, startMs, endMs) {
  const tf = normalizeTimeframe(timeframe);
  if (!tf) throw new Error(`Unsupported timeframe: ${timeframe}`);

  const cached = await readCachedCandles(coinId, tf, startMs, endMs);
  if (cached.length > 0) {
    return { candles: cached, source: 'cache' };
  }

  const live = await fetchAndCacheCandles(coinId, tf, startMs, endMs);
  return { candles: live, source: 'live' };
}

async function getLatestTimestamp(coinId, timeframe) {
  if (!isDbReady()) return null;
  const tf = normalizeTimeframe(timeframe);
  if (!tf) return null;
  const row = await CandleCache.findOne({ coinId, timeframe: tf }).sort({ timestamp: -1 }).lean();
  return row ? Number(row.timestamp) : null;
}

async function syncCoinTimeframe(coinId, timeframe, options = {}) {
  const tf = normalizeTimeframe(timeframe);
  if (!tf) return { added: 0, source: 'invalid-tf' };
  const now = Date.now();
  const tfMs = MS_PER_TIMEFRAME[tf];
  const latest = await getLatestTimestamp(coinId, tf);
  const startMs = latest != null
    ? latest + tfMs
    : (now - (options.lookbackMs || THREE_YEARS_MS));
  const endMs = now;

  if (startMs >= endMs) return { added: 0, source: 'up-to-date' };
  const candles = await fetchHistoricalCandlesForCoin(coinId, tf, startMs, endMs);
  if (!candles || candles.length === 0) return { added: 0, source: 'empty' };
  const up = await bulkUpsertCandles(coinId, tf, candles);
  return { added: up.insertedOrUpdated, source: 'synced' };
}

async function populateAllCandles(options = {}) {
  const coins = Array.isArray(options.coins) && options.coins.length > 0 ? options.coins : TRACKED_COINS;
  const timeframes = Array.isArray(options.timeframes) && options.timeframes.length > 0 ? options.timeframes : CACHE_TIMEFRAMES;
  const totalPairs = coins.length * timeframes.length;

  let pairDone = 0;
  let totalStored = 0;
  const failures = [];
  const startedAt = Date.now();

  for (const coinId of coins) {
    for (const tf of timeframes) {
      pairDone += 1;
      const pairStart = Date.now();
      const pct = ((pairDone / Math.max(1, totalPairs)) * 100).toFixed(1);
      console.log(`[Cache Populate] ${coinId} ${tf}: fetching... (${pairDone}/${totalPairs}, ${pct}%)`);
      try {
        const startMs = Date.now() - (options.lookbackMs || THREE_YEARS_MS);
        const endMs = Date.now();
        const candles = await fetchHistoricalCandlesForCoin(coinId, tf, startMs, endMs);
        const up = await bulkUpsertCandles(coinId, tf, candles);
        totalStored += up.insertedOrUpdated;
        const tookMs = Date.now() - pairStart;
        const elapsed = Date.now() - startedAt;
        const avg = elapsed / pairDone;
        const etaMs = Math.max(0, (totalPairs - pairDone) * avg);
        console.log(`[Cache Populate] ${coinId} ${tf}: ${up.insertedOrUpdated.toLocaleString()} candles stored OK (took ${(tookMs / 1000).toFixed(1)}s, ETA ${(etaMs / 60000).toFixed(1)}m)`);
      } catch (err) {
        failures.push({ coinId, timeframe: tf, error: err.message });
        console.warn(`[Cache Populate] ${coinId} ${tf}: FAILED - ${err.message}`);
      }
    }
  }

  return {
    totalPairs,
    totalStored,
    failed: failures
  };
}

async function syncAllCandles(options = {}) {
  const coins = Array.isArray(options.coins) && options.coins.length > 0 ? options.coins : TRACKED_COINS;
  const timeframes = Array.isArray(options.timeframes) && options.timeframes.length > 0 ? options.timeframes : CACHE_TIMEFRAMES;
  let newCandles = 0;
  const failed = [];
  for (const coinId of coins) {
    for (const tf of timeframes) {
      try {
        const out = await syncCoinTimeframe(coinId, tf, options);
        newCandles += out.added || 0;
      } catch (err) {
        failed.push({ coinId, timeframe: tf, error: err.message });
      }
    }
  }
  return { newCandles, failed };
}

async function populateMissingCandles(options = {}) {
  const coins = Array.isArray(options.coins) && options.coins.length > 0 ? options.coins : TRACKED_COINS;
  const timeframes = Array.isArray(options.timeframes) && options.timeframes.length > 0 ? options.timeframes : CACHE_TIMEFRAMES;
  let totalStored = 0;
  const failed = [];
  let populatedPairs = 0;
  for (const coinId of coins) {
    for (const tf of timeframes) {
      try {
        const latest = await getLatestTimestamp(coinId, tf);
        if (latest != null) continue;
        populatedPairs += 1;
        const startMs = Date.now() - (options.lookbackMs || THREE_YEARS_MS);
        const endMs = Date.now();
        const candles = await fetchHistoricalCandlesForCoin(coinId, tf, startMs, endMs);
        const up = await bulkUpsertCandles(coinId, tf, candles);
        totalStored += up.insertedOrUpdated;
      } catch (err) {
        failed.push({ coinId, timeframe: tf, error: err.message });
      }
    }
  }
  return { totalStored, populatedPairs, failed };
}

async function getCacheStorageStats() {
  if (!isDbReady()) return { totalCandles: 0, storageBytes: 0 };
  const totalCandles = await CandleCache.estimatedDocumentCount();
  let storageBytes = 0;
  try {
    const collName = CandleCache.collection.collectionName;
    const stats = await mongoose.connection.db.command({ collStats: collName });
    storageBytes = Number(stats.storageSize || stats.size || 0);
  } catch (err) {
    storageBytes = 0;
  }
  return { totalCandles, storageBytes };
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

let _cacheStatusRowsResult = null;
let _cacheStatusRowsAt = 0;
const CACHE_STATUS_TTL = 5 * 60 * 1000;
async function getCacheStatusRows() {
  if (!isDbReady()) return [];
  if (_cacheStatusRowsResult && (Date.now() - _cacheStatusRowsAt) < CACHE_STATUS_TTL) {
    return _cacheStatusRowsResult;
  }
  const agg = await CandleCache.aggregate([
    {
      $group: {
        _id: { coinId: '$coinId', timeframe: '$timeframe' },
        oldest: { $min: '$timestamp' },
        newest: { $max: '$timestamp' },
        totalCandles: { $sum: 1 },
        lastUpdated: { $max: '$updatedAt' }
      }
    },
    {
      $project: {
        _id: 0,
        coinId: '$_id.coinId',
        timeframe: '$_id.timeframe',
        oldest: 1,
        newest: 1,
        totalCandles: 1,
        lastUpdated: 1
      }
    }
  ]);
  _cacheStatusRowsResult = agg;
  _cacheStatusRowsAt = Date.now();
  return agg;
}

async function buildCacheStatusMatrix() {
  const rows = await getCacheStatusRows();
  const byKey = new Map(rows.map((r) => [`${r.coinId}::${r.timeframe}`, r]));
  const out = [];
  for (const coinId of TRACKED_COINS) {
    for (const timeframe of CACHE_TIMEFRAMES) {
      const row = byKey.get(`${coinId}::${timeframe}`) || null;
      const ageMs = row?.lastUpdated ? (Date.now() - new Date(row.lastUpdated).getTime()) : Infinity;
      const freshness = ageMs <= 60 * 60 * 1000
        ? 'green'
        : ageMs <= 4 * 60 * 60 * 1000
        ? 'yellow'
        : 'red';
      out.push({
        coinId,
        symbol: COIN_META[coinId]?.symbol || coinId.toUpperCase(),
        timeframe,
        oldest: row?.oldest || null,
        newest: row?.newest || null,
        totalCandles: row?.totalCandles || 0,
        lastUpdated: row?.lastUpdated || null,
        freshness
      });
    }
  }
  return out;
}

async function cleanupOldCandles() {
  if (!isDbReady()) return { deletedCount: 0 };
  const cutoff = Date.now() - THREE_YEARS_MS;
  const out = await CandleCache.deleteMany({ timestamp: { $lt: cutoff } });
  return { deletedCount: Number(out.deletedCount || 0) };
}

async function logStartupStats() {
  if (!isDbReady()) return;
  const stats = await getCacheStorageStats();
  const matrix = await buildCacheStatusMatrix();
  const readyCoins = new Set(matrix.filter((r) => r.totalCandles > 0).map((r) => r.coinId)).size;
  console.log(`[Cache] Candle cache: ${stats.totalCandles.toLocaleString()} candles, ${formatBytes(stats.storageBytes)}, ${readyCoins}/${TRACKED_COINS.length} coins ready`);
}

module.exports = {
  CACHE_TIMEFRAMES,
  MS_PER_TIMEFRAME,
  THREE_YEARS_MS,
  normalizeTimeframe,
  getCandles,
  syncAllCandles,
  populateMissingCandles,
  syncCoinTimeframe,
  populateAllCandles,
  getLatestTimestamp,
  getCacheStorageStats,
  buildCacheStatusMatrix,
  cleanupOldCandles,
  logStartupStats,
  formatBytes
};
