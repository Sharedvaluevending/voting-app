// services/smc-scanner.js
// ====================================================
// SMC SETUP MARKET SCANNER
// Scans coins for active SMC trade scenarios
// ====================================================

const { analyzeOHLCV } = require('./trading-engine');
const { scoreScenariosForCoin } = require('./smc-scenarios/scenario-checks');
const { getScenario } = require('./smc-scenarios/scenario-definitions');
const { TRACKED_COINS } = require('./crypto-api');

/**
 * Scan a single coin for SMC setups.
 * @param {string} coinId - e.g. 'bitcoin'
 * @param {Object} candles - { '1h': [...], '4h': [...] }
 * @param {number} currentPrice - current price
 * @param {string[]} setupIds - optional filter: only these setup IDs
 * @returns {{ coinId, price, scenarios: Array }}
 */
function scanCoinForSetups(coinId, candles, currentPrice, setupIds = null) {
  const c1h = candles?.['1h'] || candles;
  if (!c1h || !Array.isArray(c1h) || c1h.length < 50) {
    return { coinId, price: currentPrice, scenarios: [] };
  }

  const analysis = analyzeOHLCV(c1h, currentPrice);
  let scenarios = scoreScenariosForCoin(c1h, analysis);

  if (setupIds && setupIds.length > 0) {
    scenarios = scenarios.filter(s => setupIds.includes(s.scenarioId));
  }

  return {
    coinId,
    price: currentPrice,
    scenarios
  };
}

/**
 * Scan multiple coins for SMC setups.
 * @param {Object} candlesByCoin - { coinId: { '1h': [...] } }
 * @param {Object} pricesByCoin - { coinId: number } or array of { id, price }
 * @param {string[]} setupIds - optional filter
 * @returns {Array} [{ coinId, price, scenarios }]
 */
function scanMarketForSetups(candlesByCoin, pricesByCoin, setupIds = null) {
  const results = [];
  const coinIds = Object.keys(candlesByCoin || {});

  for (const coinId of coinIds) {
    const candles = candlesByCoin[coinId];
    let price = 0;
    if (typeof pricesByCoin === 'object' && !Array.isArray(pricesByCoin)) {
      price = pricesByCoin[coinId] || 0;
    } else if (Array.isArray(pricesByCoin)) {
      const p = pricesByCoin.find(x => x.id === coinId || x.coinId === coinId);
      price = p?.price || p?.current_price || 0;
    }
    if (!price && candles?.['1h']?.length > 0) {
      price = candles['1h'][candles['1h'].length - 1].close;
    }

    const result = scanCoinForSetups(coinId, candles, price, setupIds);
    if (result.scenarios.length > 0) {
      results.push(result);
    }
  }

  return results.sort((a, b) => Math.max(...(b.scenarios.map(s => s.score) || [0])) - Math.max(...(a.scenarios.map(s => s.score) || [0])));
}

/**
 * Get setups that are "ready" (all short-version phases passed) for a coin.
 */
function getReadySetupsForCoin(coinId, candles, currentPrice) {
  const result = scanCoinForSetups(coinId, candles, currentPrice);
  return result.scenarios.filter(s => s.ready);
}

const { ATR_OHLC } = require('./trading-engine');

const SL_ATR_MULT = 2;
const TP_ATR_MULT = 2.5;

/**
 * Evaluate setups for auto-trade. Returns signals in same format as evaluateStrategyForAutoTrade.
 * @param {string[]} setupIds - enabled setup IDs to evaluate
 * @param {Object} allCandles - { coinId: { '1h': [...] } }
 * @param {string[]} coinIds - coins to evaluate
 * @param {Array} prices - price data [{ id, price }]
 * @returns {Array} signals in format { coin, _coinId, _direction, _overallScore, _bestStrat }
 */
function evaluateSetupsForAutoTrade(setupIds, allCandles, coinIds, prices = []) {
  const signals = [];
  if (!setupIds || setupIds.length === 0) return signals;

  for (const coinId of coinIds || []) {
    const candles = allCandles?.[coinId]?.['1h'];
    if (!candles || candles.length < 50) continue;

    const currentPrice = candles[candles.length - 1].close;
    const result = scanCoinForSetups(coinId, { '1h': candles }, currentPrice, setupIds);

    const ready = result.scenarios.filter(s => s.ready);
    if (ready.length === 0) continue;

    const best = ready.sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    const direction = best.direction === 'LONG' ? 'LONG' : 'SHORT';

    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const atr = ATR_OHLC(highs, lows, closes, 14);
    const entryPrice = currentPrice;
    const riskDist = Math.max(atr * SL_ATR_MULT, entryPrice * 0.005);
    const rewardDist = atr * TP_ATR_MULT;

    let stopLoss, takeProfit1, takeProfit2, takeProfit3;
    if (direction === 'LONG') {
      stopLoss = entryPrice - riskDist;
      takeProfit1 = entryPrice + rewardDist;
      takeProfit2 = entryPrice + rewardDist * 1.2;
      takeProfit3 = entryPrice + rewardDist * 1.5;
    } else {
      stopLoss = entryPrice + riskDist;
      takeProfit1 = entryPrice - rewardDist;
      takeProfit2 = entryPrice - rewardDist * 1.2;
      takeProfit3 = entryPrice - rewardDist * 1.5;
    }

    const coinData = Array.isArray(prices) ? prices.find(p => p.id === coinId) : null;
    signals.push({
      coin: coinData || { id: coinId },
      _coinId: coinId,
      _direction: direction,
      _overallScore: 60 + (best.score || 0),
      _bestStrat: {
        stopLoss,
        takeProfit1,
        takeProfit2,
        takeProfit3,
        entry: entryPrice,
        riskReward: rewardDist / riskDist,
        id: 'smc-' + best.scenarioId
      }
    });
  }

  return signals;
}

module.exports = {
  scanCoinForSetups,
  scanMarketForSetups,
  getReadySetupsForCoin,
  evaluateSetupsForAutoTrade
};
