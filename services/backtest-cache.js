// services/backtest-cache.js
// Candle cache for backtesting - avoids API rate limits by fetching once, reusing.
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '../data/backtest-cache');
const BYBIT_DELAY_MS = 600;  // Slower than default to avoid rate limits

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function roundToDay(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function cacheKey(coinId, startMs, endMs) {
  return `${coinId}_${roundToDay(startMs)}_${roundToDay(endMs)}.json`;
}

function getCachePath(coinId, startMs, endMs) {
  ensureDir(CACHE_DIR);
  return path.join(CACHE_DIR, cacheKey(coinId, startMs, endMs));
}

function loadCachedCandles(coinId, startMs, endMs) {
  const p = getCachePath(coinId, startMs, endMs);
  if (!fs.existsSync(p)) return null;
  try {
    const stat = fs.statSync(p);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
    if (ageHours > 24) {
      fs.unlinkSync(p);
      return null;
    }
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    const tfKeys = Object.keys(data || {});
    if (data && tfKeys.length > 0 && tfKeys.some(k => Array.isArray(data[k]) && data[k].length >= 50)) return data;
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
