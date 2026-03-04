// services/trench-auto-trading.js
// ====================================================
// TRENCH SCALPING - Memecoin pump-and-dump vs scalping
// Memecoin: detect pump START, 1-3% TP, 2% SL, 3-5min hold
// Scalping: 5m signals, 45s momentum, 8-12% TP, 8% SL
// ====================================================

const User = require('../models/User');
const ScalpTrade = require('../models/ScalpTrade');
const mobula = require('./mobula-api');
const dexscreener = require('./dexscreener-api');
const crypto = require('crypto');

const ENCRYPT_KEY = process.env.TRENCH_SECRET || process.env.SESSION_SECRET || 'trench-default-key-change-me';
const ALGO = 'aes-256-gcm';

const MAX_LOG_ENTRIES = 50;
const PAPER_SLIPPAGE = 0.008; // 0.8% simulated slippage each way (~1.6% round trip)
const MAX_BUYS_PER_SCAN = 2;  // stagger entries across scans

// Memecoin: pump-start detection, micro scalps (1-3% TP)
const MEMECOIN_EXIT_INTERVAL = 3 * 1000;   // 3s - check exits very fast
const MEMECOIN_ENTRY_INTERVAL = 25 * 1000; // 25s - scan often
const MEMECOIN_CACHE_TTL = 25 * 1000;      // 25s
const MEMECOIN_MOMENTUM_MS = 20 * 1000;    // 20s - quick confirm
const MEMECOIN_MOMENTUM_MIN_PCT = 0.3;    // require slight positive momentum (was 0)
const MEMECOIN_MIN_SCORE = 25;   // filter weak candidates (target 20%+ win rate)
const MEMECOIN_FRESH_DROP_SKIP = 1.0;      // skip if dropped >1% since confirm

// Scalping: traditional (current behavior)
const SCALP_EXIT_INTERVAL = 5 * 1000;
const SCALP_ENTRY_INTERVAL = 45 * 1000;
const SCALP_CACHE_TTL = 45 * 1000;
const SCALP_MOMENTUM_MS = 45 * 1000;
const SCALP_MOMENTUM_MIN_PCT = 0.5;
const SCALP_MIN_SCORE = 75;
const SCALP_FRESH_DROP_SKIP = 1.0;

// ====================================================
// In-memory state (cache per strategy - memecoin vs scalping)
// ====================================================
const activeBots = new Map();
const trendingCacheByStrategy = { memecoin: { data: [], fetchedAt: 0 }, scalping: { data: [], fetchedAt: 0 } };
const tickLocks = new Map();

// Momentum tracking: tokenAddress -> { price, seenAt }
const momentumCache = new Map();

function isMemecoinMode(settings) {
  return (settings?.strategy ?? 'memecoin') === 'memecoin';  // memecoin default
}

function getIntervals(settings) {
  const memecoin = isMemecoinMode(settings);
  return {
    exitInterval: memecoin ? MEMECOIN_EXIT_INTERVAL : SCALP_EXIT_INTERVAL,
    entryInterval: memecoin ? MEMECOIN_ENTRY_INTERVAL : SCALP_ENTRY_INTERVAL,
    cacheTtl: memecoin ? MEMECOIN_CACHE_TTL : SCALP_CACHE_TTL,
    momentumMs: memecoin ? MEMECOIN_MOMENTUM_MS : SCALP_MOMENTUM_MS,
    momentumMinPct: memecoin ? MEMECOIN_MOMENTUM_MIN_PCT : SCALP_MOMENTUM_MIN_PCT,
    minScore: memecoin ? MEMECOIN_MIN_SCORE : SCALP_MIN_SCORE,
    freshDropSkip: memecoin ? MEMECOIN_FRESH_DROP_SKIP : SCALP_FRESH_DROP_SKIP
  };
}

// ====================================================
// Crypto helpers
// ====================================================
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(ENCRYPT_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + enc;
}

function decrypt(encrypted) {
  const [ivHex, tagHex, enc] = (encrypted || '').split(':');
  if (!ivHex || !tagHex || !enc) return null;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const key = crypto.scryptSync(ENCRYPT_KEY, 'salt', 32);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(enc, 'hex', 'utf8') + decipher.final('utf8');
}

function getBotKeypair(user) {
  const enc = user.trenchBot?.privateKeyEncrypted;
  if (!enc) return null;
  const pk = decrypt(enc);
  if (!pk) return null;
  try {
    const bs58 = require('bs58');
    const secretKey = bs58.decode(pk);
    const { Keypair } = require('@solana/web3.js');
    return Keypair.fromSecretKey(secretKey);
  } catch (e) {
    console.error('[TrenchBot] Invalid bot key:', e.message);
    return null;
  }
}

function botLog(userId, msg) {
  const bot = activeBots.get(userId.toString());
  if (!bot) return;
  const entry = { time: new Date().toISOString(), msg };
  bot.log.push(entry);
  if (bot.log.length > MAX_LOG_ENTRIES) bot.log.shift();
  bot.lastAction = entry;
  console.log(`[TrenchBot:${userId.toString().slice(-6)}] ${msg}`);
}

// ====================================================
// Quality scoring for candidate tokens
// ====================================================
function scoreCandidate(t, opts = {}) {
  const change = t.priceChange24h || 0;
  const change5m = t.priceChange5m;
  const change1h = t.priceChange1h || 0;
  const vol = t.volume24h || 0;
  const liq = t.liquidity || 0;
  const minBuyPressure = opts.minBuyPressure ?? 0.5;
  const buyPressure = t.buyPressure ?? 0.5;
  const organicScore = t.organicScore ?? 0;
  const numBuyers1h = t.numBuyers1h || 0;
  const numBuyers5m = t.numBuyers5m || 0;
  const holderCount = t.holderCount || 0;
  const volLiqRatio = liq > 0 ? vol / liq : 0;
  const sourceCount = t._sourceCount || 1;

  // SCALPING: Prefer 5m when available, fallback to 1h, then 24h/6 as last resort
  const changeShort = (typeof change5m === 'number') ? change5m
    : (typeof change1h === 'number') ? change1h
    : (change && change > 0) ? change / 6 : 0;
  const minChangeShort = 1.0; // +1% min - avoid weak pumps that reverse

  // Hard rejects -- safety filters (tighter to reduce losers)
  if (change > 500) return -1;
  if (change < -25) return -1;
  if (vol < 25000) return -1;  // was 15k - require more volume
  if (liq < 50000) return -1;  // was 25k - avoid thin liquidity dumps
  if (holderCount > 0 && holderCount < 500) return -1;
  // Allow Jupiter tokens with holderCount 0 (API sometimes returns 0 when unknown)
  if (volLiqRatio > 25) return -1;

  // Must be actively pumping (scalping: 5m or 1h or 24h proxy)
  if (changeShort < minChangeShort) return -1;
  if (buyPressure < minBuyPressure) return -1;

  const buyVol5m = t.buyVolume5m || 0;
  const sellVol5m = t.sellVolume5m || 0;
  const buyVol1h = t.buyVolume1h || 0;
  const sellVol1h = t.sellVolume1h || 0;
  const vol1h = buyVol1h + sellVol1h;
  const vol5m = buyVol5m + sellVol5m;
  // SCALPING: Use 5m volume when available for velocity (faster signal)
  const volShort = vol5m > 0 ? vol5m : vol1h;
  const buyVolShort = vol5m > 0 ? buyVol5m : buyVol1h;
  const sellVolShort = vol5m > 0 ? sellVol5m : sellVol1h;
  const volVelocity = liq > 0 ? volShort / liq : 0;
  const buyDominance = volShort > 0 ? buyVolShort / volShort : (vol1h > 0 ? buyVol1h / vol1h : buyPressure);

  // --- OVERBOUGHT / PARABOLIC REJECTION (reduce losers) ---
  const changeHigh = changeShort;
  if (changeHigh > 80 && change > 300) return -1;
  if (changeHigh > 50 && change > 150) return -1;  // parabolic + extended 24h = often dumps
  if (changeHigh > 60) return -1;  // too parabolic - avoid buying the top

  // --- VOLUME DIVERGENCE REJECTION ---
  if (changeHigh > 5 && buyDominance < 0.45 && volShort > 0) return -1;  // was 0.40 - require volume backing

  let score = 0;

  // SCALPING: Short-term momentum dominant (5m or 1h)
  // Sweet spot is 10-40%; parabolic rejection kills >60% above
  if (changeShort >= 10 && changeShort <= 40) score += 40;
  else if (changeShort >= 5 && changeShort < 10) score += 35;
  else if (changeShort > 40 && changeShort <= 60) score += 25;
  else if (changeShort >= 2 && changeShort < 5) score += 20;
  else if (changeShort >= minChangeShort && changeShort < 2) score += 12;

  // BREAKOUT: volume velocity (max 20 pts)
  if (volVelocity >= 2) score += 20;
  else if (volVelocity >= 1) score += 15;
  else if (volVelocity >= 0.5) score += 10;
  else if (volVelocity >= 0.2) score += 5;

  // --- VOLUME SURGE BONUS (max 15 pts) ---
  // 1h volume vs 24h average hourly volume
  // If 1h vol is way above the 24h avg, activity is spiking RIGHT NOW
  const avgHourlyVol = vol / 24;
  const volSurge = avgHourlyVol > 0 ? vol1h / avgHourlyVol : 0;
  if (volSurge >= 3) score += 15;       // 3x normal hourly volume = massive surge
  else if (volSurge >= 2) score += 10;   // 2x normal = strong surge
  else if (volSurge >= 1.5) score += 5;  // 1.5x normal = above average

  // Buy pressure + buy dominance (max 25 pts)
  const effectiveBP = Math.max(buyPressure, buyDominance);
  if (effectiveBP >= 0.65) score += 25;
  else if (effectiveBP >= 0.60) score += 20;
  else if (effectiveBP >= 0.55) score += 15;
  else if (effectiveBP >= 0.50) score += 8;

  // --- BUY/SELL VOLUME CONFIRMATION (max 10 pts) ---
  // Buy volume should dominate sell volume for a healthy pump
  // This is an OBV-inspired check: confirms volume backs the price move
  if (buyDominance >= 0.65) score += 10;
  else if (buyDominance >= 0.55) score += 6;
  else if (buyDominance >= 0.50) score += 3;

  // Buyer surge -- scalping: prefer 5m buyers when available (max 15 pts)
  const numBuyers = numBuyers5m > 0 ? numBuyers5m : numBuyers1h;
  if (numBuyers >= 50) score += 15;
  else if (numBuyers >= 20) score += 10;
  else if (numBuyers >= 5) score += 5;

  // 24h volume tiers (max 10 pts) - min vol is 25k now
  if (vol >= 200000) score += 10;
  else if (vol >= 100000) score += 8;
  else if (vol >= 50000) score += 6;
  else if (vol >= 25000) score += 4;

  // Liquidity (max 8 pts) - min liq is 50k now
  if (liq >= 100000) score += 8;
  else if (liq >= 75000) score += 6;
  else if (liq >= 50000) score += 4;

  // 24h context -- moderate pumps are better entries (max 8 pts)
  if (change >= 5 && change <= 50) score += 8;
  else if (change > 50 && change <= 150) score += 5;
  else if (change > 150 && change <= 300) score += 2;
  else if (change >= 0 && change < 5) score += 4;

  // Organic score (max 6 pts)
  if (organicScore >= 80) score += 6;
  else if (organicScore >= 50) score += 4;
  else if (organicScore >= 20) score += 2;

  // Safety bonuses (max 13 pts)
  if (holderCount >= 1000) score += 5;
  else if (holderCount >= 500) score += 2;
  if (t.isVerified) score += 3;
  if (sourceCount >= 3) score += 5;
  else if (sourceCount >= 2) score += 3;

  return score;
}

// ====================================================
// MEMECOIN: LOOSE scoring - let pumps through, filter by exits
// Minimal bars: some vol, some liq, not dumping. Score everything else.
// ====================================================
function scoreCandidatePumpStart(t, opts = {}) {
  const change5m = t.priceChange5m;
  const change1h = t.priceChange1h || 0;
  const change24 = t.priceChange24h || 0;
  const vol = t.volume24h || 0;
  const liq = t.liquidity || 0;
  const minBuyPressure = opts.minBuyPressure ?? 0.5;
  const buyPressure = t.buyPressure ?? 0.5;
  const buyVol5m = t.buyVolume5m || 0;
  const sellVol5m = t.sellVolume5m || 0;
  const buyVol1h = t.buyVolume1h || 0;
  const sellVol1h = t.sellVolume1h || 0;
  const vol5m = buyVol5m + sellVol5m;
  const vol1h = buyVol1h + sellVol1h;
  const volShort = vol5m > 0 ? vol5m : vol1h;
  const buyDominance = volShort > 0 ? (vol5m > 0 ? buyVol5m : buyVol1h) / volShort : buyPressure;
  const volVelocity = liq > 0 ? volShort / liq : 0;
  const avgHourlyVol = vol / 24;
  const volSurge = avgHourlyVol > 0 ? vol1h / avgHourlyVol : 0;
  const source = t.source || '';
  const numBuyers5m = t.numBuyers5m || 0;
  const numBuyers1h = t.numBuyers1h || 0;

  // Bare minimum - only reject obvious rugs (want 100s of candidates)
  if (vol < 1000) return -1;
  if (liq < 10000) return -1;  // was 3k - rugs often have thin liquidity
  if (liq > 0 && vol / liq > 150) return -1;
  if (volShort > 0 && buyDominance < 0.25) return -1;  // only reject extreme dumps

  // Approximate 5m change from 1h: /4 is more realistic than /12 for memecoin pumps
  const changeShort = (typeof change5m === 'number') ? change5m
    : (typeof change1h === 'number') ? change1h / 4 : 0;
  if (changeShort > 150) return -1;
  if (changeShort < -40) return -1;

  // Already pumped: 5m is most of 1h move = we're late (bought the top)
  if (typeof change5m === 'number' && typeof change1h === 'number' && change1h > 5) {
    const ratio = change5m / change1h;
    if (ratio > 0.85 && change5m > 10) return -1;  // 85%+ of 1h pump in 5m = late
  }
  if (changeShort > 15) return -1;  // memecoin: hard reject >15% 5m (already pumped)
  if (changeShort < 0.5) return -1;  // memecoin: require positive pump signal (reject flat/down)
  if (changeShort > 0 && buyDominance < minBuyPressure) return -1;  // require buy pressure when pumping
  if (avgHourlyVol > 0 && vol1h > 0 && volSurge < 1.0) return -1;  // require volume surge when we have data
  const numBuyers = numBuyers5m > 0 ? numBuyers5m : numBuyers1h;
  if (numBuyers > 0 && numBuyers < 8) return -1;         // require 8+ buyers (organic activity)

  const isNewOrRecent = source === 'geckoterminal' || (t._sourceCount || 1) <= 1;

  let score = 25;  // base - almost everything passes

  // Price move bonus (only reachable ranges: changeShort >= 0.5 due to hard reject above)
  if (changeShort >= 0.5 && changeShort <= 10) score += 30;
  else if (changeShort > 10 && changeShort <= 15) score += 20;

  // Volume surge (loose thresholds)
  if (volSurge >= 1.5) score += 15;
  else if (volSurge >= 1) score += 10;
  else if (volSurge >= 0.5) score += 5;

  // Buy dominance (loose)
  if (buyDominance >= 0.55) score += 15;
  else if (buyDominance >= 0.48) score += 10;
  else if (buyDominance >= 0.40) score += 5;

  // Volume velocity
  if (volVelocity >= 0.5) score += 10;
  else if (volVelocity >= 0.2) score += 5;

  if (isNewOrRecent) score += 5;
  if (numBuyers >= 15) score += 10;
  else if (numBuyers >= 8) score += 5;
  if ((t.organicScore || 0) >= 50) score += 10;         // Jupiter: prefer organic pumps
  if (liq >= 50000) score += 5;

  return score;
}

// ====================================================
// Trending data fetcher with cache
// ====================================================
async function fetchTrendingsCached(settings = {}) {
  const memecoin = isMemecoinMode(settings);
  const cacheKey = memecoin ? 'memecoin' : 'scalping';
  const cache = trendingCacheByStrategy[cacheKey] || { data: [], fetchedAt: 0 };
  const intervals = getIntervals(settings);
  if (Date.now() - cache.fetchedAt < intervals.cacheTtl && cache.data.length > 0) {
    return cache.data;
  }
  let trendings = [];
  try {
    trendings = await dexscreener.fetchSolanaTrendings(800);
  } catch (e) {
    console.warn('[TrenchBot] DexScreener failed:', e.message);
  }
  let mobulaTokens = [];
  try {
    mobulaTokens = await (mobula.fetchMetaTrendingsMulti || mobula.fetchMetaTrendings)('solana');
  } catch (e) {
    console.warn('[TrenchBot] Mobula fetch failed:', e.message);
  }
  const seen = new Map();
  for (const t of trendings) {
    if (t.tokenAddress && t.price > 0) seen.set(t.tokenAddress, t);
  }
  for (const t of mobulaTokens) {
    if (t.tokenAddress && t.price > 0 && !seen.has(t.tokenAddress)) {
      seen.set(t.tokenAddress, t);
    }
  }

  // Enrich non-Jupiter tokens missing buyVolume1h with Mobula (helps them score)
  const toEnrich = Array.from(seen.values()).filter(t =>
    t.source !== 'jupiter' && !t.buyVolume1h && !t.sellVolume1h &&
    t.tokenAddress && ((t.priceChange1h != null) || (t.priceChange24h != null && (t.priceChange24h || 0) > 0)) && (t.volume24h || 0) >= 15000
  ).slice(0, 50);
  if (toEnrich.length > 0) {
    const chunkSize = 5;
    for (let i = 0; i < toEnrich.length; i += chunkSize) {
      const chunk = toEnrich.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async (t) => {
        try {
          const mk = await mobula.getTokenMarkets('solana', t.tokenAddress);
          if (mk && (mk.volumeBuy1hUSD || mk.volumeSell1hUSD)) {
            t.buyVolume1h = mk.volumeBuy1hUSD || 0;
            t.sellVolume1h = mk.volumeSell1hUSD || 0;
            if (t.priceChange1h == null && typeof mk.priceChange1hPercentage === 'number') {
              t.priceChange1h = mk.priceChange1hPercentage;
            }
          }
        } catch (e) { /* skip */ }
      }));
      if (i + chunkSize < toEnrich.length) await new Promise(r => setTimeout(r, 150));
    }
  }

  const minScore = intervals.minScore;
  const minBuyPressure = (settings.minBuyPressure ?? 0.5);
  const scoreFn = memecoin ? scoreCandidatePumpStart : scoreCandidate;
  const scored = Array.from(seen.values()).map(t => {
    t._qualityScore = scoreFn(t, { minBuyPressure });
    return t;
  }).filter(t => t._qualityScore >= minScore);

  scored.sort((a, b) => b._qualityScore - a._qualityScore);

  const all = Array.from(seen.values());
  const softPass = all.filter(t => (t._qualityScore || 0) > 0).length;
  const modeLabel = memecoin ? 'memecoin pump-start' : 'scalping';
  console.log(`[TrenchBot] ${all.length} total tokens, ${scored.length} pass ${modeLabel} (score>=${minScore})`);

  trendingCacheByStrategy[cacheKey] = { data: scored, fetchedAt: Date.now() };
  return scored;
}

// ====================================================
// Settings sanitizer - clamps wild DB values to sane ranges
// Memecoin mode: 1-3% TP, 2% SL, 2-5min hold
// ====================================================
function sanitizeSettings(raw) {
  const s = { ...raw };
  const memecoin = (s.strategy ?? 'memecoin') === 'memecoin';
  const defTp = memecoin ? 2 : 10;
  const defSl = memecoin ? 2 : 8;
  const defHold = memecoin ? 4 : 10;
  const minTp = memecoin ? 1 : 5;
  const maxTp = memecoin ? 5 : 50;
  const minHold = memecoin ? 2 : 5;
  const maxHold = memecoin ? 5 : 15;

  // Force strategy-appropriate TP/SL: if user has scalping values saved but is in
  // memecoin mode (or vice versa), override to the correct defaults for the mode.
  // Without this, switching strategy leaves the old TP/SL in the DB.
  if (memecoin && s.tpPercent != null && s.tpPercent > maxTp) s.tpPercent = defTp;
  if (memecoin && s.slPercent != null && s.slPercent > 5) s.slPercent = defSl;
  if (!memecoin && s.tpPercent != null && s.tpPercent < minTp) s.tpPercent = defTp;

  s.slPercent = Math.min(Math.max(s.slPercent ?? defSl, 1), 30);
  s.tpPercent = Math.min(Math.max(s.tpPercent ?? defTp, minTp), maxTp);
  s.maxHoldMinutes = Math.min(Math.max(s.maxHoldMinutes ?? defHold, minHold), maxHold);
  s.maxOpenPositions = Math.min(Math.max(s.maxOpenPositions ?? 3, 1), 15);
  s.consecutiveLossesToPause = Math.min(Math.max(s.consecutiveLossesToPause ?? 3, 2), 10);
  s.cooldownHours = Math.min(Math.max(s.cooldownHours ?? 1, 0.25), 4);
  s.bigLossPauseMinutes = Math.min(Math.max(s.bigLossPauseMinutes ?? 20, 5), 60);
  s.maxPriceChange24hPercent = Math.min(Math.max(s.maxPriceChange24hPercent ?? 500, 100), 1000);
  s.minLiquidityUsd = Math.min(Math.max(s.minLiquidityUsd ?? 25000, 25000), 100000);
  s.maxTop10HoldersPercent = Math.min(Math.max(s.maxTop10HoldersPercent ?? 80, 50), 100);
  s.maxDailyLossPercent = Math.min(Math.max(s.maxDailyLossPercent ?? 15, 5), 50);
  s.trailingStopPercent = Math.min(Math.max(s.trailingStopPercent ?? (memecoin ? 2 : 5), 1), 20);
  s.breakevenAtPercent = Math.min(Math.max(s.breakevenAtPercent ?? (memecoin ? 1 : 3), 1), 15);
  s.amountPerTradeUsd = Math.min(Math.max(s.amountPerTradeUsd ?? (memecoin ? 25 : 50), 5), 500);
  s.amountPerTradeSol = Math.min(Math.max(s.amountPerTradeSol ?? 0.05, 0.01), 1);
  s.minTrendingScore = 1;
  s.useTrailingTP = s.useTrailingTP === true;
  s.volumeFilterEnabled = s.volumeFilterEnabled === true;
  s.volatilityFilterEnabled = s.volatilityFilterEnabled === true;
  s.minVolume24hUsd = Math.min(Math.max(s.minVolume24hUsd ?? 25000, 5000), 500000);
  s.maxVolatility24hPercent = Math.min(Math.max(s.maxVolatility24hPercent ?? 400, 100), 1000);
  s.minVolatility24hPercent = Math.min(Math.max(s.minVolatility24hPercent ?? -30, -80), 50);
  s.minOrganicScore = Math.min(Math.max(s.minOrganicScore ?? 0, 0), 100);
  s.minPoolAgeMinutes = Math.min(Math.max(s.minPoolAgeMinutes ?? 0, 0), 60);
  s.tradingHoursStartUTC = Math.min(Math.max(s.tradingHoursStartUTC ?? 0, 0), 23);
  s.tradingHoursEndUTC = Math.min(Math.max(s.tradingHoursEndUTC ?? 24, 0), 24);
  s.minProfitToActivateTrail = Math.min(Math.max(s.minProfitToActivateTrail ?? 0, 0), 10);
  s.minBuyPressure = Math.min(Math.max(s.minBuyPressure ?? 0.5, 0.45), 0.65);
  s.usePartialTP = s.usePartialTP !== false;  // 40/30/30 partial exits, default on
  return s;
}

/** Kelly-based position size multiplier when useKellySizing is enabled. Uses trenchStats win rate. */
function getKellyMultiplier(user, rawSettings) {
  if (!rawSettings?.useKellySizing) return 1;
  const stats = user.trenchStats || {};
  const wins = stats.wins || 0;
  const losses = stats.losses || 0;
  const total = wins + losses;
  if (total < 10) return 1;
  const w = wins / total;
  const r = 1.2; // assume avg R:R ~1.2 (TP/SL typical)
  const kellyFull = w - (1 - w) / r;
  if (kellyFull > 0) {
    const kellyFraction = Math.min(0.25, kellyFull * 0.25);
    return 1 + kellyFraction * 0.5; // cap at 1.125x
  }
  if (kellyFull < -0.1) return 0.75;
  return 1;
}

// ====================================================
// Risk checks
// ====================================================
function shouldPauseForRisk(user, settings) {
  const stats = user.trenchStats || {};
  const maxDaily = settings.maxDailyLossPercent ?? 15;
  if (maxDaily > 0 && stats.dailyPnlStartAt) {
    const now = new Date();
    const start = new Date(stats.dailyPnlStartAt);
    if (now.getDate() === start.getDate() && now.getMonth() === start.getMonth() && now.getFullYear() === start.getFullYear()) {
      const startBal = stats.dailyPnlStart ?? (user.trenchPaperBalance ?? 1000);
      const currentBal = user.trenchPaperBalance ?? 1000;
      const lossPct = ((startBal - currentBal) / startBal) * 100;
      if (lossPct >= maxDaily) return { pause: true, reason: `Daily loss limit (${lossPct.toFixed(1)}%)` };
    }
  }
  const consecLoss = settings.consecutiveLossesToPause ?? 3;
  if (consecLoss > 0 && (stats.consecutiveLosses || 0) >= consecLoss) {
    return { pause: true, reason: `${consecLoss} consecutive losses` };
  }
  // Big loss cooldown: pause 20 min after a -$25+ loss
  const bigLossPauseMin = settings.bigLossPauseMinutes ?? 20;
  const lastBigLoss = user.trenchAuto?.lastBigLossAt;
  if (bigLossPauseMin > 0 && lastBigLoss) {
    const elapsed = Date.now() - new Date(lastBigLoss).getTime();
    if (elapsed < bigLossPauseMin * 60 * 1000) {
      const amt = Math.abs(user.trenchAuto?.lastBigLossAmount || 0).toFixed(0);
      return { pause: true, reason: `Big loss cooldown ($${amt} lost, ${Math.ceil((bigLossPauseMin * 60 - elapsed / 1000) / 60)}m left)` };
    }
  }
  return { pause: false };
}

function resetDailyPnlIfNewDay(user) {
  const stats = user.trenchStats || {};
  const startAt = stats.dailyPnlStartAt;
  const now = new Date();
  if (!startAt || new Date(startAt).toDateString() !== now.toDateString()) {
    user.trenchStats = user.trenchStats || {};
    user.trenchStats.dailyPnlStart = user.trenchPaperBalance ?? 1000;
    user.trenchStats.dailyPnlStartAt = now;
  }
}

// ====================================================
// Entry filters & cooldown
// ====================================================
async function passesEntryFilters(t, settings, blacklist) {
  if (!settings.useEntryFilters && !settings.volumeFilterEnabled && !settings.volatilityFilterEnabled) return true;
  if (blacklist && blacklist.includes(t.tokenAddress)) return false;

  // Volume filter: require min 24h volume (when enabled or useEntryFilters)
  if ((settings.useEntryFilters || settings.volumeFilterEnabled) && settings.minVolume24hUsd > 0) {
    const vol = t.volume24h || 0;
    if (vol < settings.minVolume24hUsd) return false;
  }

  // Volatility filter: skip tokens outside 24h change range (too flat or too parabolic)
  if (settings.volatilityFilterEnabled) {
    const ch24 = t.priceChange24h ?? 0;
    const maxVol = settings.maxVolatility24hPercent ?? 400;
    const minVol = settings.minVolatility24hPercent ?? -30;
    if (ch24 > maxVol) return false;  // too parabolic
    if (ch24 < minVol) return false;  // dumping
  }

  // Organic score filter (Jupiter): prefer tokens with organic activity
  const minOrganic = settings.minOrganicScore ?? 0;
  if (minOrganic > 0 && typeof t.organicScore === 'number' && t.organicScore < minOrganic) return false;

  // Pool age filter (GeckoTerminal): skip very new pools (honeypot risk)
  const minPoolAgeMin = settings.minPoolAgeMinutes ?? 0;
  if (minPoolAgeMin > 0 && t.poolCreatedAt) {
    const ageMin = (Date.now() - t.poolCreatedAt) / 60000;
    if (ageMin < minPoolAgeMin) return false;
  }

  const max24h = settings.maxPriceChange24hPercent ?? 500;
  if ((t.priceChange24h || 0) >= max24h) return false;
  const minLiq = settings.minLiquidityUsd ?? 25000;
  const maxTop10 = settings.maxTop10HoldersPercent ?? 80;
  try {
    const mk = await mobula.getTokenMarkets('solana', t.tokenAddress);
    if (mk) {
      if (minLiq > 0 && (mk.liquidityUSD || 0) < minLiq) return false;
      if (maxTop10 < 100 && (mk.top10HoldingsPercentage || 100) > maxTop10) return false;
      // Rug protection: reject high insider/sniper/bundler concentration
      if ((mk.insidersCount || 0) > 5) return false;
      if ((mk.bundlersCount || 0) > 10) return false;
      if ((mk.snipersCount || 0) > 15) return false;
      if ((mk.devHoldingsPercentage || 0) > 15) return false;
      if ((mk.insidersHoldingsPercentage || 0) > 20) return false;
      // Enrich token with Mobula 1h data when missing (e.g. DexScreener-only tokens)
      if (t.priceChange1h == null && typeof mk.priceChange1hPercentage === 'number') {
        t.priceChange1h = mk.priceChange1hPercentage;
      }
      if (!t.buyVolume1h && !t.sellVolume1h && (mk.volumeBuy1hUSD || mk.volumeSell1hUSD)) {
        t.buyVolume1h = mk.volumeBuy1hUSD || 0;
        t.sellVolume1h = mk.volumeSell1hUSD || 0;
      }
    }
  } catch (e) { /* skip filter on API error */ }
  return true;
}

async function inCooldown(userId, tokenAddress, cooldownHours) {
  if (!cooldownHours || cooldownHours <= 0) return false;
  const closed = await ScalpTrade.findOne(
    { userId, tokenAddress, status: 'CLOSED' },
    {},
    { sort: { exitTime: -1 } }
  ).lean();
  if (!closed || !closed.exitTime) return false;
  const hours = (Date.now() - new Date(closed.exitTime).getTime()) / 3600000;
  // Losers: 4x cooldown; big losers (-30%+): 8x; Winners: 2x (don't chase)
  const pnlPct = closed.pnlPercent || 0;
  const wasLoss = pnlPct <= 0;
  const bigLoss = pnlPct <= -30;
  const wasWin = pnlPct > 0;
  const multiplier = bigLoss ? 8 : (wasLoss ? 4 : (wasWin ? 2 : 1));
  const effectiveCooldown = cooldownHours * multiplier;
  return hours < effectiveCooldown;
}

// ====================================================
// Momentum confirmation with price acceleration tracking
// Memecoin: 25s, +0.3% (pump just starting)
// Scalping: 45s, +0.5%
// ====================================================
function checkMomentum(tokenAddress, currentPrice, opts = {}) {
  const momentumMs = opts.momentumMs ?? SCALP_MOMENTUM_MS;
  const momentumMinPct = opts.momentumMinPct ?? SCALP_MOMENTUM_MIN_PCT;
  const prev = momentumCache.get(tokenAddress);
  if (!prev) {
    momentumCache.set(tokenAddress, {
      price: currentPrice, seenAt: Date.now(), checks: 1,
      snapshots: [{ price: currentPrice, time: Date.now() }]
    });
    return { ready: false, reason: 'first_sight' };
  }
  const elapsed = Date.now() - prev.seenAt;

  if (elapsed < momentumMs) {
    prev.checks++;
    if (!prev.snapshots) prev.snapshots = [{ price: prev.price, time: prev.seenAt }];
    prev.snapshots.push({ price: currentPrice, time: Date.now() });
    return { ready: false, reason: `confirming (${Math.round(elapsed / 1000)}s / ${momentumMs / 1000}s)` };
  }

  const changeSinceFirstSight = ((currentPrice - prev.price) / prev.price) * 100;

  if (changeSinceFirstSight < momentumMinPct) {
    momentumCache.set(tokenAddress, {
      price: currentPrice, seenAt: Date.now(), checks: 1,
      snapshots: [{ price: currentPrice, time: Date.now() }]
    });
    return { ready: false, reason: `momentum_weak (${changeSinceFirstSight.toFixed(1)}%, need +${momentumMinPct}%)` };
  }

  // Price acceleration check: compare first half vs second half of observation
  // If the pump is decelerating (slowing down), it's fading -- don't buy the top
  const snaps = prev.snapshots || [];
  if (snaps.length >= 4) {
    const mid = Math.floor(snaps.length / 2);
    const firstHalfChange = ((snaps[mid].price - snaps[0].price) / snaps[0].price) * 100;
    const secondHalfChange = ((currentPrice - snaps[mid].price) / snaps[mid].price) * 100;

    if (secondHalfChange < 0 && firstHalfChange > momentumMinPct) {
      // Pumped in first half, now dropping -- fading pump
      momentumCache.set(tokenAddress, {
        price: currentPrice, seenAt: Date.now(), checks: 1,
        snapshots: [{ price: currentPrice, time: Date.now() }]
      });
      return { ready: false, reason: `pump_fading (1st:+${firstHalfChange.toFixed(1)}% 2nd:${secondHalfChange.toFixed(1)}%)` };
    }
  }

  momentumCache.delete(tokenAddress);
  return { ready: true, changeSinceFirstSight };
}

// Clean stale momentum entries (older than 10 minutes)
function cleanMomentumCache() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [addr, entry] of momentumCache) {
    if (entry.seenAt < cutoff) momentumCache.delete(addr);
  }
}

// ====================================================
// Adaptive trailing: strategy-aware trail widths
// Memecoin (base 2%): small profit: 1.5% trail, medium: 2%, big: 3%
// Scalping (base 5%): small profit: 4% trail, medium: 5%, big: 8%
// ====================================================
function getAdaptiveTrail(pnlPct, baseTrail, isMemecoin = false) {
  if (isMemecoin) {
    if (pnlPct >= 3) return Math.max(baseTrail, 3);
    if (pnlPct >= 1.5) return baseTrail;
    return Math.max(1.5, baseTrail * 0.75);
  }
  if (pnlPct >= 20) return Math.max(baseTrail, 8);
  if (pnlPct >= 10) return baseTrail;
  return Math.min(baseTrail, 4);
}

// ====================================================
// Exit logic (with adaptive trailing stop)
// ====================================================
function shouldSellPosition(pos, currentPrice, settings) {
  if (!currentPrice || currentPrice <= 0) return { sell: false };
  const entry = pos.entryPrice || 0.0000001;
  const pnlPct = ((currentPrice - entry) / entry) * 100;
  const holdMinutes = (Date.now() - new Date(pos.createdAt).getTime()) / 60000;
  const maxHold = settings.maxHoldMinutes ?? 12;
  const tp = settings.tpPercent ?? 12;
  const sl = settings.slPercent ?? 8;
  const baseTrail = settings.trailingStopPercent ?? 8;
  const useTrail = settings.useTrailingStop !== false;
  const useBreakeven = settings.useBreakevenStop !== false;
  const breakevenAt = settings.breakevenAtPercent ?? 5;
  let peakPrice = pos.peakPrice || pos.entryPrice;
  if (currentPrice > peakPrice) peakPrice = currentPrice;

  if (pnlPct <= -sl) return { sell: true, reason: 'stop_loss', pnlPct };
  // Fixed TP: skip when useTrailingTP (exit profit only via trailing)
  // Partial TP (40/30/30): TP1=40% of TP, TP2=70%, TP3=100%
  const usePartialTP = settings.usePartialTP !== false;
  if (!settings.useTrailingTP && usePartialTP) {
    const tp1 = tp * 0.4, tp2 = tp * 0.7;
    const sold = pos.partialSoldAmount || 0;
    const orig = pos.tokenAmount || 0;
    const soldPct = orig > 0 ? (sold / orig) * 100 : 0;
    if (pnlPct >= tp1 && soldPct < 1) return { sell: true, reason: 'partial_tp1', pnlPct, partialPercent: 40 };
    if (pnlPct >= tp2 && soldPct >= 39 && soldPct < 71) return { sell: true, reason: 'partial_tp2', pnlPct, partialPercent: 30 };
    if (pnlPct >= tp && soldPct >= 69) return { sell: true, reason: 'partial_tp3', pnlPct, partialPercent: 30 };
  }
  if (!settings.useTrailingTP && pnlPct >= tp) return { sell: true, reason: 'take_profit', pnlPct };

  // Breakeven enforcement: once triggered, sell if price drops back to entry
  if (useBreakeven && pos.breakevenTriggered && pnlPct <= 0) {
    return { sell: true, reason: 'breakeven_stop', pnlPct };
  }

  // Early bail: if down at the halfway mark, cut losses early
  // Memecoin: 1% down at 60% of hold (give pump time to develop)
  // Scalping: 1.5% down at 50% of hold
  const memecoin = (settings.strategy ?? 'memecoin') === 'memecoin';
  const earlyBailThreshold = memecoin ? 1.0 : 1.5;
  const earlyBailAt = memecoin ? maxHold * 0.6 : maxHold / 2;
  if (holdMinutes >= earlyBailAt && holdMinutes < maxHold && pnlPct <= -earlyBailThreshold) {
    return { sell: true, reason: 'early_bail', pnlPct };
  }

  // Stale position: if price hasn't moved meaningfully after 70% of hold time, exit
  // Flat positions tie up capital and usually drift into losses
  const staleThreshold = memecoin ? 0.3 : 0.5;
  if (holdMinutes >= maxHold * 0.7 && Math.abs(pnlPct) < staleThreshold) {
    return { sell: true, reason: 'stale_position', pnlPct };
  }

  // Time limit - force-close; use strategy-aware profit threshold
  // Memecoin TP is ~2%, so don't cut at 1.5% (that's 75% of TP)
  const timeLimitProfitCap = memecoin ? 0.5 : 1.5;
  if (holdMinutes >= maxHold && pnlPct <= timeLimitProfitCap) {
    return { sell: true, reason: 'time_limit', pnlPct };
  }
  if (holdMinutes >= maxHold * 2) {
    return { sell: true, reason: 'time_limit_hard', pnlPct };
  }

  // Min profit to activate trail: don't trail until we're in profit by X%
  const minProfitToTrail = settings.minProfitToActivateTrail ?? 0;
  if (minProfitToTrail > 0 && pnlPct < minProfitToTrail) {
    // Trail not active yet - skip trailing logic
  } else if (useTrail && pnlPct > 0 && peakPrice > 0) {
    const peakPnlPct = ((peakPrice - entry) / entry) * 100;
    const adaptiveTrail = getAdaptiveTrail(peakPnlPct, baseTrail, memecoin);
    const dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;
    if (dropFromPeak >= adaptiveTrail) {
      return { sell: true, reason: `trailing_stop(${adaptiveTrail}%)`, pnlPct };
    }
  }

  // Set breakeven flag when profit first reaches threshold
  if (useBreakeven && pnlPct >= breakevenAt && !pos.breakevenTriggered) {
    return { sell: false, updateBreakeven: true, peakPrice };
  }
  return { sell: false, peakPrice };
}

// ====================================================
// Live sell execution (full or partial)
// ====================================================
async function executeLiveSell(user, pos, currentPrice, keypair, opts = {}) {
  const walletAddress = keypair.publicKey.toBase58();
  const orig = pos.tokenAmount || 0;
  const sold = pos.partialSoldAmount || 0;
  const remaining = orig - sold;
  let amountToSell;
  if (opts.partialPercent != null && opts.partialPercent > 0 && opts.partialPercent < 100) {
    amountToSell = orig * (opts.partialPercent / 100);
  } else {
    amountToSell = remaining;
  }
  if (amountToSell <= 0) return false;
  try {
    const quote = await mobula.getSwapQuote(
      'solana', pos.tokenAddress, mobula.SOL_MINT,
      amountToSell, walletAddress, { slippage: 15 }
    );
    const serialized = quote?.data?.solana?.transaction?.serialized;
    if (!serialized) return false;
    const { VersionedTransaction } = require('@solana/web3.js');
    const txBuf = Buffer.from(serialized, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);
    const signedB64 = Buffer.from(tx.serialize()).toString('base64');
    const result = await mobula.sendSwapTransaction('solana', signedB64);
    const data = result.data || result;
    if (data.success && data.transactionHash) {
      const valueOut = amountToSell * currentPrice;
      const costBasis = pos.tokenAmount > 0 ? pos.amountIn * (amountToSell / pos.tokenAmount) : pos.amountIn;
      const pnl = valueOut - costBasis;
      const pnlPct = pos.entryPrice > 0 ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
      const isPartial = opts.partialPercent != null && opts.partialPercent > 0 && opts.partialPercent < 100;
      if (isPartial) {
        await ScalpTrade.updateOne({ _id: pos._id }, {
          $inc: { partialSoldAmount: amountToSell },
          $set: { peakPrice: Math.max(pos.peakPrice || pos.entryPrice, currentPrice) }
        });
        return { pnl, pnlPct, partial: true };
      }
      await ScalpTrade.updateOne({ _id: pos._id }, {
        $set: { exitPrice: currentPrice, amountOut: valueOut, pnl, pnlPercent: pnlPct, status: 'CLOSED', exitTime: new Date(), txHash: data.transactionHash, exitReason: opts.reason || 'auto_sell' }
      });
      return { pnl, pnlPct };
    }
  } catch (e) {
    console.error('[TrenchBot] Live sell failed:', e.message);
  }
  return null;
}

// ====================================================
// Profit payout: auto-send profits to another wallet
// ====================================================
async function sendProfitPayout(user, keypair, profitSol) {
  const settings = user.trenchAuto || {};
  const payoutAddr = settings.profitPayoutAddress;
  const payoutPct = settings.profitPayoutPercent || 0;
  const payoutMin = settings.profitPayoutMinSol || 0.1;

  if (!payoutAddr || payoutPct <= 0 || profitSol <= 0) return null;

  const payoutAmount = profitSol * (payoutPct / 100);
  if (payoutAmount < payoutMin) return null;

  try {
    const { Connection, PublicKey, Transaction, SystemProgram } = require('@solana/web3.js');
    const conn = new Connection(process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com');

    const walletBal = await conn.getBalance(keypair.publicKey);
    const reserveSol = (settings.minSolBalance || 0.05) + 0.01;
    const availableSol = (walletBal / 1e9) - reserveSol;
    if (availableSol < payoutAmount) return null;

    const lamports = Math.floor(payoutAmount * 1e9);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey(payoutAddr),
        lamports
      })
    );
    const sig = await conn.sendTransaction(tx, [keypair]);
    return { amount: payoutAmount, sig };
  } catch (e) {
    console.error('[TrenchBot] Profit payout failed:', e.message);
    return null;
  }
}

// ====================================================
// EXIT TICK - Fast loop (every 10s) to monitor open positions
// Only fetches fresh prices for held tokens, no scanning
// ====================================================
async function exitTick(userId) {
  const uid = userId.toString();
  const lockKey = `exit_${uid}`;
  if (tickLocks.get(lockKey)) return;
  tickLocks.set(lockKey, true);
  try { await _exitTickInner(userId); } finally { tickLocks.delete(lockKey); }
}

async function _exitTickInner(userId) {
  const bot = activeBots.get(userId.toString());
  if (!bot) return;

  const user = await User.findById(userId);
  if (!user) { stopBot(userId); return; }

  const rawSettings = user.trenchAuto || {};
  const settings = sanitizeSettings(rawSettings);
  const mode = rawSettings.mode || 'paper';

  const openPositions = await ScalpTrade.find({
    userId: user._id,
    isPaper: mode === 'paper',
    status: 'OPEN'
  }).lean();

  if (openPositions.length === 0) return;

  // Fetch fresh prices only for held tokens
  const heldAddresses = openPositions.map(p => p.tokenAddress);
  let freshPrices = {};
  try {
    const pairs = await dexscreener.fetchTokensBulk('solana', heldAddresses);
    for (const p of pairs) {
      if (p.tokenAddress && p.price > 0) freshPrices[p.tokenAddress] = p.price;
    }
  } catch (e) {
    // Fallback to cached trending data (either strategy)
    const cacheKey = isMemecoinMode(rawSettings) ? 'memecoin' : 'scalping';
    let cached = (trendingCacheByStrategy[cacheKey] || {}).data || [];
    if (cached.length === 0) cached = (trendingCacheByStrategy[cacheKey === 'memecoin' ? 'scalping' : 'memecoin'] || {}).data || [];
    for (const t of cached) {
      if (heldAddresses.includes(t.tokenAddress) && t.price > 0) {
        freshPrices[t.tokenAddress] = t.price;
      }
    }
  }

  let sellCount = 0;
  for (const pos of openPositions) {
    let currentPrice = freshPrices[pos.tokenAddress] || 0;

    // If bulk fetch missed it, try individual lookup
    if (!currentPrice || currentPrice <= 0) {
      try {
        const pairData = await dexscreener.fetchTokenPairs('solana', pos.tokenAddress);
        if (pairData && pairData.price > 0) currentPrice = pairData.price;
      } catch (e) { /* ignore */ }
    }
    if (!currentPrice || currentPrice <= 0) continue;

    const decision = shouldSellPosition(pos, currentPrice, settings);

    if (decision.updateBreakeven) {
      await ScalpTrade.updateOne({ _id: pos._id }, { $set: { breakevenTriggered: true } });
      botLog(userId, `Breakeven set on ${pos.tokenSymbol} (up ${((currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(1)}%)`);
      continue;
    }
    if (decision.peakPrice) {
      await ScalpTrade.updateOne({ _id: pos._id }, { $set: { peakPrice: decision.peakPrice } });
    }
    if (!decision.sell) continue;

    if (mode === 'paper') {
      const slippedPrice = currentPrice * (1 - PAPER_SLIPPAGE);
      const orig = pos.tokenAmount || 0;
      const sold = pos.partialSoldAmount || 0;
      const isPartial = decision.partialPercent != null && decision.partialPercent > 0 && decision.partialPercent < 100;
      const tokenAmountToSell = isPartial ? orig * (decision.partialPercent / 100) : (orig - sold);
      const valueOut = tokenAmountToSell * slippedPrice;
      const costBasis = orig > 0 ? (pos.amountIn || 0) * (tokenAmountToSell / orig) : (pos.amountIn || 0);
      const pnl = valueOut - costBasis;
      const pnlPct = ((slippedPrice - pos.entryPrice) / pos.entryPrice) * 100;

      user.trenchPaperBalance = Math.round(((user.trenchPaperBalance ?? 1000) + valueOut) * 100) / 100;

      if (isPartial) {
        await ScalpTrade.updateOne({ _id: pos._id }, {
          $inc: { partialSoldAmount: tokenAmountToSell },
          $set: { peakPrice: Math.max(pos.peakPrice || pos.entryPrice, currentPrice) }
        });
        botLog(userId, `PARTIAL ${pos.tokenSymbol} [${decision.reason}] ${decision.partialPercent}% PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
      } else {
        await ScalpTrade.updateOne({ _id: pos._id }, {
          $set: { exitPrice: slippedPrice, amountOut: valueOut, pnl, pnlPercent: pnlPct, status: 'CLOSED', exitTime: new Date(), exitReason: decision.reason || 'auto' }
        });
        botLog(userId, `SELL ${pos.tokenSymbol} [${decision.reason}] PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) [slip: -${(PAPER_SLIPPAGE * 100).toFixed(0)}%]`);
      }
      sellCount++;

      user.trenchStats = user.trenchStats || {};
      user.trenchStats.totalPnl = (user.trenchStats.totalPnl || 0) + pnl;
      if (pnl > 0) {
        user.trenchStats.wins = (user.trenchStats.wins || 0) + 1;
        user.trenchStats.consecutiveLosses = 0;
        user.trenchStats.bestTrade = Math.max(user.trenchStats.bestTrade || 0, pnl);
      } else {
        user.trenchStats.losses = (user.trenchStats.losses || 0) + 1;
        user.trenchStats.consecutiveLosses = (user.trenchStats.consecutiveLosses || 0) + 1;
        user.trenchStats.worstTrade = Math.min(user.trenchStats.worstTrade || 0, pnl);
        // Big loss cooldown: pause after -$25+ to avoid tilt
        if (pnl <= -25) {
          user.trenchAuto = user.trenchAuto || {};
          user.trenchAuto.lastBigLossAt = new Date();
          user.trenchAuto.lastBigLossAmount = pnl;
        }
        // Auto-blacklist tokens that rugged (-50%+)
        if (pnlPct <= -50) {
          if (!user.trenchBlacklist) user.trenchBlacklist = [];
          if (!user.trenchBlacklist.includes(pos.tokenAddress)) {
            user.trenchBlacklist.push(pos.tokenAddress);
            botLog(userId, `BLACKLIST ${pos.tokenSymbol} (rug: ${pnlPct.toFixed(0)}%)`);
          }
        }
      }
      await user.save({ validateBeforeSave: false });
    } else {
      const keypair = getBotKeypair(user);
      if (!keypair) continue;
      const result = await executeLiveSell(user, pos, currentPrice, keypair, {
        partialPercent: decision.partialPercent,
        reason: decision.reason
      });
      if (result) {
        const { pnl, pnlPct } = result;
        user.trenchStats = user.trenchStats || {};
        user.trenchStats.totalPnl = (user.trenchStats.totalPnl || 0) + pnl;
        if (pnl > 0) { user.trenchStats.wins = (user.trenchStats.wins || 0) + 1; user.trenchStats.consecutiveLosses = 0; user.trenchStats.bestTrade = Math.max(user.trenchStats.bestTrade || 0, pnl); }
        else {
          user.trenchStats.losses = (user.trenchStats.losses || 0) + 1;
          user.trenchStats.consecutiveLosses = (user.trenchStats.consecutiveLosses || 0) + 1;
          user.trenchStats.worstTrade = Math.min(user.trenchStats.worstTrade || 0, pnl);
          if (pnl <= -25) {
            user.trenchAuto = user.trenchAuto || {};
            user.trenchAuto.lastBigLossAt = new Date();
            user.trenchAuto.lastBigLossAmount = pnl;
          }
          if (pnlPct <= -50) {
            if (!user.trenchBlacklist) user.trenchBlacklist = [];
            if (!user.trenchBlacklist.includes(pos.tokenAddress)) {
              user.trenchBlacklist.push(pos.tokenAddress);
              botLog(userId, `BLACKLIST ${pos.tokenSymbol} (rug: ${pnlPct.toFixed(0)}%)`);
            }
          }
        }
        await user.save({ validateBeforeSave: false });
        sellCount++;
        botLog(userId, `LIVE SELL ${pos.tokenSymbol} [${decision.reason}] PnL: $${pnl.toFixed(2)}`);

        if (pnl > 0 && settings.profitPayoutAddress) {
          // currentPrice is the TOKEN price, not SOL — use a reasonable SOL estimate
          const solPrice = 150;
          const profitSol = pnl / solPrice;
          const payout = await sendProfitPayout(user, keypair, profitSol);
          if (payout) {
            botLog(userId, `PAYOUT ${payout.amount.toFixed(4)} SOL sent to ${settings.profitPayoutAddress.slice(0, 8)}...`);
          }
        }
      }
    }
  }

  if (sellCount > 0) {
    bot.tradesClosed += sellCount;
  }
}

// ====================================================
// ENTRY TICK - Slower loop (every 90s) to find new trades
// Scans trending tokens, applies momentum check, opens positions
// ====================================================
async function entryTick(userId) {
  const uid = userId.toString();
  const lockKey = `entry_${uid}`;
  if (tickLocks.get(lockKey)) return;
  tickLocks.set(lockKey, true);
  try { await _entryTickInner(userId); } finally { tickLocks.delete(lockKey); }
}

async function _entryTickInner(userId) {
  const bot = activeBots.get(userId.toString());
  if (!bot) return;
  bot.scanCount++;

  const user = await User.findById(userId);
  if (!user) { stopBot(userId); return; }

  // Time-of-day filter: only scan during allowed hours (UTC)
  const raw = user.trenchAuto || {};
  const startH = raw.tradingHoursStartUTC ?? 0;
  const endH = raw.tradingHoursEndUTC ?? 24;
  if (startH > 0 || endH < 24) {
    const hourUTC = new Date().getUTCHours();
    const inRange = endH > startH
      ? (hourUTC >= startH && hourUTC < endH)
      : (hourUTC >= startH || hourUTC < endH);
    if (!inRange) return;  // Outside trading hours
  }

  const rawSettings = user.trenchAuto || {};
  const settings = sanitizeSettings(rawSettings);
  const intervals = getIntervals(rawSettings);
  const mode = rawSettings.mode || 'paper';
  const maxPositions = settings.maxOpenPositions;
  const blacklist = user.trenchBlacklist || [];

  // Risk check
  resetDailyPnlIfNewDay(user);
  const riskCheck = shouldPauseForRisk(user, settings);
  if (riskCheck.pause) {
    user.trenchAuto.lastPausedAt = new Date();
    user.trenchAuto.pausedReason = riskCheck.reason;
    await user.save({ validateBeforeSave: false });
    botLog(userId, `PAUSED: ${riskCheck.reason}`);
    stopBot(userId);
    return;
  }

  const validTrendings = await fetchTrendingsCached(rawSettings);
  if (validTrendings.length === 0) {
    botLog(userId, 'No trending tokens found, waiting...');
    return;
  }

  const openCount = await ScalpTrade.countDocuments({ userId: user._id, status: 'OPEN' });
  const slotsAvailable = maxPositions - openCount;
  if (slotsAvailable <= 0) {
    if (bot.scanCount % 3 === 0) botLog(userId, `Monitoring ${openCount} positions (${validTrendings.length} tokens tracked)`);
    return;
  }

  const heldTokens = new Set((await ScalpTrade.find({ userId: user._id, status: 'OPEN' }).lean()).map(p => p.tokenAddress));

  const candidates = validTrendings
    .filter(t => !heldTokens.has(t.tokenAddress) && !blacklist.includes(t.tokenAddress) && t.price > 0)
    .slice(0, 300);

  if (candidates.length === 0) {
    botLog(userId, `Scanning... ${validTrendings.length} tokens, 0 candidates after filters`);
    return;
  }

  // Clean stale momentum entries
  cleanMomentumCache();

  // Fetch live prices for tokens in momentum window (use live data instead of cache)
  const momentumAddrs = [];
  for (const [addr, entry] of momentumCache) {
    if (Date.now() - entry.seenAt < intervals.momentumMs) momentumAddrs.push(addr);
  }
  let momentumFreshPrices = {};
  if (momentumAddrs.length > 0) {
    try {
      const pairs = await dexscreener.fetchTokensBulk('solana', momentumAddrs.slice(0, 30));
      for (const p of pairs) {
        if (p.tokenAddress && p.price > 0) momentumFreshPrices[p.tokenAddress] = p.price;
      }
    } catch (e) { /* ignore */ }
  }

  let buyCount = 0;
  let momentumWaiting = 0;
  let filteredOut = 0;
  let cooldownBlocked = 0;
  const maxBuysThisScan = Math.min(MAX_BUYS_PER_SCAN, slotsAvailable);
  if (mode === 'paper') {
    let amountPerTrade = settings.amountPerTradeUsd ?? 50;
    amountPerTrade *= getKellyMultiplier(user, rawSettings);
    amountPerTrade = Math.max(5, Math.min(500, amountPerTrade));
    for (const t of candidates) {
      if (buyCount >= maxBuysThisScan) break;
      if ((user.trenchPaperBalance ?? 0) < amountPerTrade) { botLog(userId, 'Insufficient paper balance'); break; }

      // Cheap checks first, expensive API calls last
      const cool = await inCooldown(user._id, t.tokenAddress, settings.cooldownHours ?? 1);
      if (cool) { cooldownBlocked++; continue; }

      const priceForMomentum = momentumFreshPrices[t.tokenAddress] ?? t.price;
      const momentumOpts = { momentumMs: intervals.momentumMs, momentumMinPct: intervals.momentumMinPct };
      const momentum = checkMomentum(t.tokenAddress, priceForMomentum, momentumOpts);
      if (!momentum.ready) { momentumWaiting++; continue; }

      const pass = await passesEntryFilters(t, settings, blacklist);
      if (!pass) { filteredOut++; continue; }

      // Fetch fresh pair data right before buy — price + momentum confirmation
      let freshPair = null;
      try { freshPair = await dexscreener.fetchTokenPairs('solana', t.tokenAddress); } catch (e) { /* proceed */ }
      const freshPrice = freshPair?.price > 0 ? freshPair.price : null;
      const refPrice = momentumFreshPrices[t.tokenAddress] ?? t.price;
      if (freshPrice && refPrice > 0) {
        const dropPct = ((refPrice - freshPrice) / refPrice) * 100;
        if (dropPct > intervals.freshDropSkip) {
          botLog(userId, `SKIP ${t.symbol} price dropped ${dropPct.toFixed(1)}% since confirm`);
          continue;
        }
      }
      // Volume-at-entry: verify 5m trend is still positive (not reversed)
      if (freshPair && typeof freshPair.priceChange5m === 'number' && freshPair.priceChange5m < -2) {
        botLog(userId, `SKIP ${t.symbol} 5m change reversed to ${freshPair.priceChange5m.toFixed(1)}%`);
        continue;
      }
      const entryPrice = (freshPrice && freshPrice > 0) ? freshPrice : t.price;

      try {
        // Apply slippage: entry price is worse than listed
        const slippedEntry = entryPrice * (1 + PAPER_SLIPPAGE);
        const amount = Math.min(amountPerTrade, user.trenchPaperBalance);
        const tokenAmount = amount / slippedEntry;
        user.trenchPaperBalance = Math.round((user.trenchPaperBalance - amount) * 100) / 100;
        await user.save({ validateBeforeSave: false });
        await ScalpTrade.create({
          userId: user._id, walletAddress: 'paper', isPaper: true,
          tokenAddress: t.tokenAddress, tokenSymbol: t.symbol, tokenName: t.name,
          side: 'BUY', amountIn: amount, tokenAmount, entryPrice: slippedEntry, peakPrice: slippedEntry, status: 'OPEN'
        });
        buyCount++;
        bot.tradesOpened++;
        const vol = (t.volume24h || 0) >= 1000 ? '$' + Math.round((t.volume24h || 0) / 1000) + 'k' : '$' + Math.round(t.volume24h || 0);
        const liq = (t.liquidity || 0) >= 1000 ? '$' + Math.round((t.liquidity || 0) / 1000) + 'k' : '$' + Math.round(t.liquidity || 0);
        const bp = t.buyPressure ? ` bp:${(t.buyPressure * 100).toFixed(0)}%` : '';
        const h1 = t.priceChange1h ? ` 1h:+${(t.priceChange1h).toFixed(1)}%` : '';
        const bv1h = (t.buyVolume1h || 0) + (t.sellVolume1h || 0);
        const vel = t.liquidity > 0 ? (bv1h / t.liquidity).toFixed(1) : '0';
        const holders = t.holderCount ? ` hldr:${t.holderCount}` : '';
        botLog(userId, `BUY ${t.symbol} $${amount.toFixed(2)} @ $${slippedEntry.toFixed(8)} (${h1}${bp} vel:${vel}x score:${t._qualityScore || 0} vol:${vol} liq:${liq}${holders} mom:+${(momentum.changeSinceFirstSight || 0).toFixed(1)}%)`);
      } catch (err) {
        botLog(userId, `Buy failed ${t.symbol}: ${err.message}`);
      }
    }
  } else {
    if (!user.trenchBot?.connected || !user.trenchBot?.publicKey) { botLog(userId, 'No bot wallet connected'); return; }
    const keypair = getBotKeypair(user);
    if (!keypair) { botLog(userId, 'Invalid bot wallet key'); return; }
    const walletAddress = keypair.publicKey.toBase58();
    let amountPerTrade = settings.amountPerTradeSol ?? 0.05;
    amountPerTrade *= getKellyMultiplier(user, rawSettings);
    amountPerTrade = Math.max(0.01, Math.min(1, amountPerTrade));

    const minSol = settings.minSolBalance ?? 0.05;
    let solBalance = 0;
    try {
      const { Connection, PublicKey } = require('@solana/web3.js');
      const conn = new Connection(process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com');
      const bal = await conn.getBalance(new PublicKey(walletAddress));
      solBalance = bal / 1e9;
    } catch (e) { /* ignore */ }
    if (solBalance < minSol) { botLog(userId, `SOL balance too low: ${solBalance.toFixed(4)}`); return; }

    for (const t of candidates) {
      if (buyCount >= maxBuysThisScan) break;

      const cool = await inCooldown(user._id, t.tokenAddress, settings.cooldownHours ?? 1);
      if (cool) { cooldownBlocked++; continue; }

      const priceForMomentum = momentumFreshPrices[t.tokenAddress] ?? t.price;
      const momentumOpts = { momentumMs: intervals.momentumMs, momentumMinPct: intervals.momentumMinPct };
      const momentum = checkMomentum(t.tokenAddress, priceForMomentum, momentumOpts);
      if (!momentum.ready) { momentumWaiting++; continue; }

      const pass = await passesEntryFilters(t, settings, blacklist);
      if (!pass) { filteredOut++; continue; }

      let freshPairLive = null;
      try { freshPairLive = await dexscreener.fetchTokenPairs('solana', t.tokenAddress); } catch (e) { /* proceed */ }
      const freshPrice = freshPairLive?.price > 0 ? freshPairLive.price : null;
      const refPrice = momentumFreshPrices[t.tokenAddress] ?? t.price;
      if (freshPrice && refPrice > 0) {
        const dropPct = ((refPrice - freshPrice) / refPrice) * 100;
        if (dropPct > intervals.freshDropSkip) {
          botLog(userId, `SKIP ${t.symbol} price dropped ${dropPct.toFixed(1)}% since confirm`);
          continue;
        }
      }
      if (freshPairLive && typeof freshPairLive.priceChange5m === 'number' && freshPairLive.priceChange5m < -2) {
        botLog(userId, `SKIP ${t.symbol} 5m change reversed to ${freshPairLive.priceChange5m.toFixed(1)}%`);
        continue;
      }
      const entryPrice = (freshPrice && freshPrice > 0) ? freshPrice : t.price;

      try {
        const quote = await mobula.getSwapQuote('solana', mobula.SOL_MINT, t.tokenAddress, amountPerTrade, walletAddress, { slippage: 8 });
        const serialized = quote?.data?.solana?.transaction?.serialized;
        if (!serialized) continue;
        const { VersionedTransaction } = require('@solana/web3.js');
        const txBuf = Buffer.from(serialized, 'base64');
        const tx = VersionedTransaction.deserialize(txBuf);
        tx.sign([keypair]);
        const signedB64 = Buffer.from(tx.serialize()).toString('base64');
        const result = await mobula.sendSwapTransaction('solana', signedB64);
        const data = result.data || result;
        if (data.success && data.transactionHash) {
          const solPrice = 150;
          const tokenAmount = (amountPerTrade * solPrice) / (entryPrice || 1e-9);
          await ScalpTrade.create({
            userId: user._id, walletAddress, isPaper: false,
            tokenAddress: t.tokenAddress, tokenSymbol: t.symbol, tokenName: t.name,
            side: 'BUY', amountIn: amountPerTrade, tokenAmount, entryPrice, peakPrice: entryPrice, txHash: data.transactionHash, status: 'OPEN'
          });
          buyCount++;
          bot.tradesOpened++;
          botLog(userId, `LIVE BUY ${t.symbol} ${amountPerTrade} SOL @ $${t.price.toFixed(8)}`);
        }
      } catch (err) {
        botLog(userId, `Live buy failed ${t.symbol}: ${err.message}`);
      }
    }
  }

  // Always log scan summary so Live Activity shows regular updates
  const parts = [`${candidates.length} candidates`, `${slotsAvailable} slots`];
  if (buyCount > 0) parts.push(`${buyCount} bought`);
  if (filteredOut > 0) parts.push(`${filteredOut} filtered`);
  if (cooldownBlocked > 0) parts.push(`${cooldownBlocked} cooldown`);
  if (momentumWaiting > 0) parts.push(`${momentumWaiting} momentum`);
  botLog(userId, `Scan: ${parts.join(' | ')}`);

  user.trenchAuto.lastRunAt = new Date();
  await user.save({ validateBeforeSave: false });
}

// ====================================================
// START / STOP / STATUS
// ====================================================
async function startBot(userId) {
  const uid = userId.toString();
  if (activeBots.has(uid)) return { already: true };

  const user = await User.findById(userId).lean();
  const rawSettings = user?.trenchAuto || {};
  const intervals = getIntervals(rawSettings);
  const s = sanitizeSettings(rawSettings);
  const memecoin = isMemecoinMode(rawSettings);

  const bot = {
    startedAt: new Date(),
    strategy: memecoin ? 'memecoin' : 'scalping',
    scanCount: 0,
    tradesOpened: 0,
    tradesClosed: 0,
    log: [],
    lastAction: null,
    exitInterval: null,
    entryInterval: null
  };
  activeBots.set(uid, bot);

  const modeLabel = memecoin ? 'Meme Bot' : 'Scalp Bot';
  botLog(userId, `${modeLabel} — TP:${s.tpPercent}% SL:${s.slPercent}% hold:${s.maxHoldMinutes}m | ${intervals.momentumMs / 1000}s mom +${intervals.momentumMinPct}%`);

  // First tick: run entry scan immediately (which also seeds momentum cache)
  entryTick(userId).catch(err => botLog(userId, `Entry error: ${err.message}`));

  // Fast exit monitoring loop
  bot.exitInterval = setInterval(() => {
    exitTick(userId).catch(err => botLog(userId, `Exit error: ${err.message}`));
  }, intervals.exitInterval);

  // Entry scanning loop
  bot.entryInterval = setInterval(() => {
    entryTick(userId).catch(err => botLog(userId, `Entry error: ${err.message}`));
  }, intervals.entryInterval);

  return { started: true };
}

function stopBot(userId) {
  const uid = userId.toString();
  const bot = activeBots.get(uid);
  if (!bot) return { already: true };
  if (bot.exitInterval) clearInterval(bot.exitInterval);
  if (bot.entryInterval) clearInterval(bot.entryInterval);
  botLog(userId, 'Bot STOPPED');
  activeBots.delete(uid);
  return { stopped: true, scanCount: bot.scanCount, tradesOpened: bot.tradesOpened, tradesClosed: bot.tradesClosed };
}

function getBotStatus(userId) {
  const uid = userId.toString();
  const bot = activeBots.get(uid);
  if (!bot) return { running: false };
  return {
    running: true,
    strategy: bot.strategy || 'scalping',
    startedAt: bot.startedAt,
    scanCount: bot.scanCount,
    tradesOpened: bot.tradesOpened,
    tradesClosed: bot.tradesClosed,
    uptime: Math.round((Date.now() - bot.startedAt.getTime()) / 1000),
    lastAction: bot.lastAction,
    log: bot.log.slice(-30)
  };
}

// ====================================================
// Legacy: background scheduler
// ====================================================
async function runTrenchAutoTrade(opts = {}) {
  const runForUserId = opts.runForUserId;

  if (runForUserId) {
    const uid = runForUserId.toString();
    if (!activeBots.has(uid)) {
      await startBot(runForUserId);
    }
    return { started: true };
  }

  const users = await User.find({ 'trenchAuto.enabled': true }).lean();
  let started = 0;
  for (const u of users) {
    const uid = u._id.toString();
    if (!activeBots.has(uid)) {
      const settings = u.trenchAuto || {};
      const intervalMin = settings.checkIntervalMinutes ?? 15;
      const lastRun = settings.lastRunAt;
      if (lastRun && intervalMin > 0) {
        const elapsed = (Date.now() - new Date(lastRun).getTime()) / 60000;
        if (elapsed < intervalMin) continue;
      }
      try {
        await entryTick(u._id);
        started++;
      } catch (e) {
        console.error(`[TrenchBot] Background tick error for ${u.username}:`, e.message);
      }
    }
  }
  return { users: users.length, ticked: started };
}

module.exports = { runTrenchAutoTrade, startBot, stopBot, getBotStatus, encrypt, decrypt, getBotKeypair, scoreCandidate };
