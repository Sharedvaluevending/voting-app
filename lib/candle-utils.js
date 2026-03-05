// lib/candle-utils.js
// ====================================================
// Shared candle validation utilities
// Ensures OHLCV data is valid before processing
// ====================================================

/**
 * Validate a single candle. All OHLC must be present, finite, positive.
 * Volume must be present (or 0), finite, and >= 0.
 * @param {Object} c - Candle { open, high, low, close, volume?, openTime?, closeTime? }
 * @returns {boolean} - true if valid
 */
function validateCandle(c) {
  if (!c || typeof c !== 'object') return false;
  const o = c.open;
  const h = c.high;
  const l = c.low;
  const cl = c.close;
  const v = c.volume;
  if (o == null || h == null || l == null || cl == null) return false;
  if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) return false;
  if (o <= 0 || h <= 0 || l <= 0 || cl <= 0) return false;
  if (h < l) return false;
  if (v != null && (!Number.isFinite(v) || v < 0)) return false;
  return true;
}

/**
 * Filter an array of candles to only valid ones.
 * @param {Array} candles - Array of candle objects
 * @returns {Array} - Filtered array of valid candles
 */
function filterValidCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles.filter(validateCandle);
}

module.exports = {
  validateCandle,
  filterValidCandles
};
