// services/backtest-cache.js
// Candle cache for backtesting - avoids API rate limits by fetching once, reusing.
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '../data/backtest-cache');
const BYBIT_DELAY_MS = 600;  // Slower than default to avoid rate limits

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cacheKey(coinId, startMs, endMs) {
  return `${coinId}_${startMs}_${endMs}.json`;
}

function getCachePath(coinId, startMs, endMs) {
  ensureDir(CACHE_DIR);
  return path.join(CACHE_DIR, cacheKey(coinId, startMs, endMs));
}

function loadCachedCandles(coinId, startMs, endMs) {
  const p = getCachePath(coinId, startMs, endMs);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (data && data['1h'] && data['1h'].length >= 50) return data;
  } catch (e) { /* ignore */ }
  return null;
}

function saveCachedCandles(coinId, startMs, endMs, candles) {
  if (!candles || candles.error) return;
  const p = getCachePath(coinId, startMs, endMs);
  try {
    fs.writeFileSync(p, JSON.stringify(candles), 'utf8');
  } catch (e) {
    console.warn(`[Cache] Failed to save ${coinId}:`, e.message);
  }
}

module.exports = {
  CACHE_DIR,
  BYBIT_DELAY_MS,
  loadCachedCandles,
  saveCachedCandles,
  getCachePath
};
