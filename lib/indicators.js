// lib/indicators.js
// ====================================================
// CONFIGURABLE INDICATOR MATH - For Strategy Builder
// Standalone, no dependency on trading-engine.
// ====================================================

function SMA(data, period) {
  if (!data || !data.length) return 0;
  const p = Math.min(period, data.length);
  const slice = data.slice(-p);
  return slice.reduce((s, v) => s + v, 0) / p;
}

function EMA(data, period) {
  if (!data || !data.length) return 0;
  if (data.length < period) return SMA(data, data.length);
  const k = 2 / (period + 1);
  let ema = SMA(data.slice(0, period), period);
  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * k + ema;
  }
  return ema;
}

/** Returns EMA series (last value = current). */
function EMASeries(data, period) {
  if (!data || data.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let ema = SMA(data.slice(0, period), period);
  for (let i = 0; i < period - 1; i++) out.push(null);
  out.push(ema);
  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * k + ema;
    out.push(ema);
  }
  return out;
}

function RSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const start = prices.length - period - 1;
  for (let i = start + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function MACD(prices, fast = 12, slow = 26, signal = 9) {
  if (!prices || prices.length < slow) return { macd: 0, signal: 0, histogram: 0 };
  const macdLine = [];
  for (let i = slow; i <= prices.length; i++) {
    const slice = prices.slice(0, i);
    const e12 = EMA(slice, fast);
    const e26 = EMA(slice, slow);
    macdLine.push(e12 - e26);
  }
  const macd = macdLine[macdLine.length - 1];
  const sigLine = macdLine.length >= signal ? EMA(macdLine, signal) : macd;
  return { macd, signal: sigLine, histogram: macd - sigLine };
}

/** Returns MACD line series for crossover detection. */
function MACDSeries(prices, fast = 12, slow = 26, signal = 9) {
  if (!prices || prices.length < slow) return { macd: [], signal: [] };
  const macdLine = [];
  const sigLine = [];
  for (let i = slow; i <= prices.length; i++) {
    const slice = prices.slice(0, i);
    const e12 = EMA(slice, fast);
    const e26 = EMA(slice, slow);
    macdLine.push(e12 - e26);
  }
  for (let i = signal; i <= macdLine.length; i++) {
    sigLine.push(EMA(macdLine.slice(0, i), signal));
  }
  return { macd: macdLine, signal: sigLine };
}

function BollingerBands(prices, period = 20, stdDev = 2) {
  if (!prices || prices.length < period) return { upper: 0, mid: 0, lower: 0 };
  const mid = SMA(prices, period);
  const slice = prices.slice(-period);
  const variance = slice.reduce((s, p) => s + Math.pow(p - mid, 2), 0) / slice.length;
  const sd = Math.sqrt(variance);
  return { upper: mid + sd * stdDev, mid, lower: mid - sd * stdDev };
}

function Stochastic(highs, lows, closes, period = 14) {
  if (!highs || !lows || !closes || closes.length < period) return { k: 50, d: 50 };
  const p = Math.min(period, closes.length);
  const recentH = highs.slice(-p);
  const recentL = lows.slice(-p);
  const high = Math.max(...recentH);
  const low = Math.min(...recentL);
  const current = closes[closes.length - 1];
  const k = high === low ? 50 : ((current - low) / (high - low)) * 100;
  const kVals = [];
  for (let i = Math.max(0, closes.length - 3); i < closes.length; i++) {
    const idx = Math.max(0, i - p + 1);
    const h = Math.max(...highs.slice(idx, i + 1));
    const l = Math.min(...lows.slice(idx, i + 1));
    kVals.push(h === l ? 50 : ((closes[i] - l) / (h - l)) * 100);
  }
  const d = kVals.reduce((s, v) => s + v, 0) / kVals.length;
  return { k, d };
}

function ATR(highs, lows, closes, period = 14) {
  if (!highs || highs.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - (closes[i - 1] || closes[i])),
      Math.abs(lows[i] - (closes[i - 1] || closes[i]))
    ));
  }
  const p = Math.min(period, trs.length);
  return trs.slice(-p).reduce((s, v) => s + v, 0) / p;
}

function ADX(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 1) return 0;
  const pDMs = [], nDMs = [], trs = [];
  for (let i = 1; i < highs.length; i++) {
    const pDM = highs[i] - highs[i - 1];
    const nDM = lows[i - 1] - lows[i];
    pDMs.push(pDM > nDM && pDM > 0 ? pDM : 0);
    nDMs.push(nDM > pDM && nDM > 0 ? nDM : 0);
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const p = Math.min(period, trs.length);
  const smoothPDM = SMA(pDMs.slice(-p), p);
  const smoothNDM = SMA(nDMs.slice(-p), p);
  const smoothTR = SMA(trs.slice(-p), p);
  if (smoothTR === 0) return 0;
  const pDI = (smoothPDM / smoothTR) * 100;
  const nDI = (smoothNDM / smoothTR) * 100;
  const diSum = pDI + nDI;
  if (diSum === 0) return 0;
  return (Math.abs(pDI - nDI) / diSum) * 100;
}

function VWAP(candles) {
  if (!candles || !candles.length) return 0;
  const recent = candles.slice(-20);
  let cumTPV = 0, cumVol = 0;
  for (const c of recent) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * (c.volume || 0);
    cumVol += c.volume || 0;
  }
  return cumVol > 0 ? cumTPV / cumVol : 0;
}

function KeltnerChannel(candles, period = 20, mult = 2) {
  if (!candles || candles.length < period) return { upper: 0, mid: 0, lower: 0 };
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const mid = EMA(closes, period);
  const atrVal = ATR(highs, lows, closes, period);
  return { upper: mid + atrVal * mult, mid, lower: mid - atrVal * mult };
}

function DonchianChannel(candles, period = 20) {
  if (!candles || candles.length < period) return { upper: 0, lower: 0 };
  const slice = candles.slice(-period);
  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);
  return { upper: Math.max(...highs), lower: Math.min(...lows) };
}

/** Check if fast crossed above slow on last bar. */
function crossedAbove(seriesFast, seriesSlow) {
  if (!seriesFast || !seriesSlow || seriesFast.length < 2 || seriesSlow.length < 2) return false;
  const f1 = seriesFast[seriesFast.length - 2];
  const f2 = seriesFast[seriesFast.length - 1];
  const s1 = seriesSlow[seriesSlow.length - 2];
  const s2 = seriesSlow[seriesSlow.length - 1];
  return f1 != null && f2 != null && s1 != null && s2 != null && f1 <= s1 && f2 > s2;
}

/** Check if fast crossed below slow on last bar. */
function crossedBelow(seriesFast, seriesSlow) {
  if (!seriesFast || !seriesSlow || seriesFast.length < 2 || seriesSlow.length < 2) return false;
  const f1 = seriesFast[seriesFast.length - 2];
  const f2 = seriesFast[seriesFast.length - 1];
  const s1 = seriesSlow[seriesSlow.length - 2];
  const s2 = seriesSlow[seriesSlow.length - 1];
  return f1 != null && f2 != null && s1 != null && s2 != null && f1 >= s1 && f2 < s2;
}

/** Average volume over last N bars. */
function avgVolume(candles, n = 20) {
  if (!candles || candles.length < n) return 0;
  const slice = candles.slice(-n);
  return slice.reduce((s, c) => s + (c.volume || 0), 0) / slice.length;
}

module.exports = {
  SMA,
  EMA,
  EMASeries,
  RSI,
  MACD,
  MACDSeries,
  BollingerBands,
  Stochastic,
  ATR,
  ADX,
  VWAP,
  KeltnerChannel,
  DonchianChannel,
  crossedAbove,
  crossedBelow,
  avgVolume
};
