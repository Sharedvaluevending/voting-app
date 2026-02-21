// services/trench-auto-trading.js
// ====================================================
// TRENCH AUTO TRADING - Persistent bot per user
// Split loop: 10s exit monitoring, 90s entry scanning
// Slippage simulation, momentum confirmation, adaptive trailing
// ====================================================

const User = require('../models/User');
const ScalpTrade = require('../models/ScalpTrade');
const mobula = require('./mobula-api');
const dexscreener = require('./dexscreener-api');
const crypto = require('crypto');
const push = require('./push-notifications');

const ENCRYPT_KEY = process.env.TRENCH_SECRET || process.env.SESSION_SECRET || 'trench-default-key-change-me';
const ALGO = 'aes-256-gcm';

const EXIT_CHECK_INTERVAL = 10 * 1000;  // 10s - fast exit monitoring
const ENTRY_SCAN_INTERVAL = 60 * 1000;  // 60s - entry scanning
const TRENDING_CACHE_TTL = 60 * 1000;
const MAX_LOG_ENTRIES = 50;
const PAPER_SLIPPAGE = 0.02; // 2% simulated slippage each way
const MAX_BUYS_PER_SCAN = 2;  // stagger entries across scans
const MIN_QUALITY_SCORE = 60; // skip marginal candidates, focus on strong setups

// ====================================================
// In-memory state
// ====================================================
const activeBots = new Map();
let trendingCache = { data: [], fetchedAt: 0 };
const tickLocks = new Map();

// Momentum tracking: tokenAddress -> { price, seenAt }
const momentumCache = new Map();

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

async function notifyUser(user, title, body, type) {
  try {
    const u = await User.findById(user._id);
    if (!u) return;
    const ok = type === 'open' ? (u.trenchAuto?.trenchNotifyTradeOpen !== false) : (u.trenchAuto?.trenchNotifyTradeClose !== false);
    if (ok) await push.sendPushToUser(u, title, body);
  } catch (e) { /* ignore */ }
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
function scoreCandidate(t) {
  const change = t.priceChange24h || 0;
  const change1h = t.priceChange1h || 0;
  const vol = t.volume24h || 0;
  const liq = t.liquidity || 0;
  const buyPressure = t.buyPressure || 0.5;
  const organicScore = t.organicScore || 0;
  const numBuyers1h = t.numBuyers1h || 0;
  const holderCount = t.holderCount || 0;
  const volLiqRatio = liq > 0 ? vol / liq : 0;
  const sourceCount = t._sourceCount || 1;

  // Hard rejects
  if (change > 500) return -1;
  if (change < -25) return -1;
  if (vol < 15000) return -1;
  if (liq < 8000) return -1;
  if (buyPressure < 0.35) return -1;
  if (change1h < -10) return -1;
  if (holderCount > 0 && holderCount < 50) return -1;  // too few holders = rug risk
  if (volLiqRatio > 25) return -1;  // extreme ratio = likely wash trading

  let score = 0;

  // 1h momentum -- strongest signal for scalping
  if (change1h >= 5 && change1h <= 30) score += 25;
  else if (change1h > 30 && change1h <= 60) score += 15;
  else if (change1h >= 1 && change1h < 5) score += 12;
  else if (change1h >= -2 && change1h < 1) score += 5;
  else if (change1h >= -10 && change1h < -2) score += 0;

  // 24h price change context
  if (change >= 5 && change <= 50) score += 20;
  else if (change > 50 && change <= 100) score += 18;
  else if (change > 100 && change <= 200) score += 12;
  else if (change > 200 && change <= 500) score += 5;
  else if (change >= 0 && change < 5) score += 3;

  // Volume tiers
  if (vol >= 200000) score += 25;
  else if (vol >= 100000) score += 20;
  else if (vol >= 50000) score += 15;
  else if (vol >= 15000) score += 10;
  else score += 3;

  // Liquidity tiers
  if (liq >= 100000) score += 20;
  else if (liq >= 50000) score += 16;
  else if (liq >= 25000) score += 12;
  else if (liq >= 8000) score += 8;
  else score += 2;

  // Volume/liquidity ratio -- healthy trading activity relative to pool size
  if (volLiqRatio >= 3 && volLiqRatio <= 15) score += 10;  // sweet spot
  else if (volLiqRatio >= 1.5 && volLiqRatio < 3) score += 6;
  else if (volLiqRatio >= 0.5 && volLiqRatio < 1.5) score += 3;

  // Buy pressure bonus
  if (buyPressure >= 0.6) score += 15;
  else if (buyPressure >= 0.55) score += 10;
  else if (buyPressure >= 0.5) score += 5;

  // Organic score (real activity vs wash trading)
  if (organicScore >= 80) score += 15;
  else if (organicScore >= 50) score += 10;
  else if (organicScore >= 20) score += 5;

  // Recent organic buyers
  if (numBuyers1h >= 50) score += 10;
  else if (numBuyers1h >= 20) score += 6;
  else if (numBuyers1h >= 5) score += 3;

  // Holder count -- more holders = more established, harder to rug
  if (holderCount >= 1000) score += 10;
  else if (holderCount >= 500) score += 7;
  else if (holderCount >= 200) score += 4;
  else if (holderCount >= 50) score += 1;

  // Verified token bonus (Jupiter verification)
  if (t.isVerified) score += 5;

  // Cross-source bonus -- found by multiple scanners = more legit
  if (sourceCount >= 3) score += 8;
  else if (sourceCount >= 2) score += 4;

  return score;
}

// ====================================================
// Trending data fetcher with cache
// ====================================================
async function fetchTrendingsCached() {
  if (Date.now() - trendingCache.fetchedAt < TRENDING_CACHE_TTL && trendingCache.data.length > 0) {
    return trendingCache.data;
  }
  let trendings = [];
  try {
    trendings = await dexscreener.fetchSolanaTrendings(500);
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

  const scored = Array.from(seen.values()).map(t => {
    t._qualityScore = scoreCandidate(t);
    return t;
  }).filter(t => t._qualityScore >= MIN_QUALITY_SCORE);

  scored.sort((a, b) => b._qualityScore - a._qualityScore);

  const all = Array.from(seen.values());
  const softPass = all.filter(t => (t._qualityScore || 0) > 0).length;
  console.log(`[TrenchBot] ${all.length} total tokens, ${softPass} pass basic filter, ${scored.length} pass quality threshold (score>=${MIN_QUALITY_SCORE})`);

  trendingCache = { data: scored, fetchedAt: Date.now() };
  return scored;
}

// ====================================================
// Settings sanitizer - clamps wild DB values to sane ranges
// ====================================================
function sanitizeSettings(raw) {
  const s = { ...raw };
  s.slPercent = Math.min(Math.max(s.slPercent ?? 12, 3), 30);
  s.tpPercent = Math.min(Math.max(s.tpPercent ?? 18, 5), 50);
  s.maxHoldMinutes = Math.min(Math.max(s.maxHoldMinutes ?? 20, 5), 60);
  s.maxOpenPositions = Math.min(Math.max(s.maxOpenPositions ?? 6, 1), 15);
  s.consecutiveLossesToPause = Math.min(Math.max(s.consecutiveLossesToPause ?? 3, 2), 10);
  s.cooldownHours = Math.min(Math.max(s.cooldownHours ?? 1, 0.25), 4);
  s.maxPriceChange24hPercent = Math.min(Math.max(s.maxPriceChange24hPercent ?? 500, 100), 1000);
  s.minLiquidityUsd = Math.min(Math.max(s.minLiquidityUsd ?? 10000, 5000), 100000);
  s.maxTop10HoldersPercent = Math.min(Math.max(s.maxTop10HoldersPercent ?? 80, 50), 100);
  s.maxDailyLossPercent = Math.min(Math.max(s.maxDailyLossPercent ?? 15, 5), 50);
  s.trailingStopPercent = Math.min(Math.max(s.trailingStopPercent ?? 8, 3), 20);
  s.breakevenAtPercent = Math.min(Math.max(s.breakevenAtPercent ?? 5, 2), 15);
  s.amountPerTradeUsd = Math.min(Math.max(s.amountPerTradeUsd ?? 50, 5), 500);
  s.amountPerTradeSol = Math.min(Math.max(s.amountPerTradeSol ?? 0.05, 0.01), 1);
  s.minTrendingScore = 1;
  return s;
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
  if (!settings.useEntryFilters) return true;
  if (blacklist && blacklist.includes(t.tokenAddress)) return false;
  const max24h = settings.maxPriceChange24hPercent ?? 500;
  if ((t.priceChange24h || 0) >= max24h) return false;
  const minLiq = settings.minLiquidityUsd ?? 10000;
  const maxTop10 = settings.maxTop10HoldersPercent ?? 80;
  if (minLiq > 0 || maxTop10 < 100) {
    try {
      const mk = await mobula.getTokenMarkets('solana', t.tokenAddress);
      if (mk) {
        if (minLiq > 0 && (mk.liquidityUSD || 0) < minLiq) return false;
        if (maxTop10 < 100 && (mk.top10HoldingsPercentage || 100) > maxTop10) return false;
      }
    } catch (e) { /* skip filter on API error */ }
  }
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
  // Losers get 4x longer cooldown to avoid re-entering the same bad coin
  const wasLoss = (closed.pnlPercent || 0) <= 0;
  const effectiveCooldown = wasLoss ? cooldownHours * 4 : cooldownHours;
  return hours < effectiveCooldown;
}

// ====================================================
// Momentum confirmation
// Records price on first sight, only allows buy if price
// held or went up on the next scan (90s later)
// ====================================================
function checkMomentum(tokenAddress, currentPrice) {
  const prev = momentumCache.get(tokenAddress);
  if (!prev) {
    momentumCache.set(tokenAddress, { price: currentPrice, seenAt: Date.now(), checks: 1 });
    return { ready: false, reason: 'first_sight' };
  }
  const elapsed = Date.now() - prev.seenAt;
  if (elapsed < 120000) {
    prev.checks++;
    return { ready: false, reason: `confirming (${Math.round(elapsed / 1000)}s / 120s)` };
  }
  const changeSinceFirstSight = ((currentPrice - prev.price) / prev.price) * 100;
  // Price must be rising -- only buy if price went UP during 120s observation
  // Coins that are flat or dropping are not in a real uptrend
  if (changeSinceFirstSight < 0) {
    momentumCache.set(tokenAddress, { price: currentPrice, seenAt: Date.now(), checks: 1 });
    return { ready: false, reason: `momentum_flat (${changeSinceFirstSight.toFixed(1)}%)` };
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
// Adaptive trailing stop
// Small profit (<15%): 7% trail (wide enough to avoid noise)
// Medium profit (15-30%): normal base trail (8%)
// Big profit (>30%): wide 12% trail to let winners run
// ====================================================
function getAdaptiveTrail(pnlPct, baseTrail) {
  if (pnlPct >= 30) return Math.max(baseTrail, 12);
  if (pnlPct >= 15) return baseTrail;
  return Math.min(baseTrail, 7);
}

// ====================================================
// Exit logic (with adaptive trailing stop)
// ====================================================
function shouldSellPosition(pos, currentPrice, settings) {
  if (!currentPrice || currentPrice <= 0) return { sell: false };
  const entry = pos.entryPrice || 0.0000001;
  const pnlPct = ((currentPrice - entry) / entry) * 100;
  const holdMinutes = (Date.now() - new Date(pos.createdAt).getTime()) / 60000;
  const maxHold = settings.maxHoldMinutes ?? 30;
  const tp = settings.tpPercent ?? 25;
  const sl = settings.slPercent ?? 8;
  const baseTrail = settings.trailingStopPercent ?? 8;
  const useTrail = settings.useTrailingStop !== false;
  const useBreakeven = settings.useBreakevenStop !== false;
  const breakevenAt = settings.breakevenAtPercent ?? 5;
  let peakPrice = pos.peakPrice || pos.entryPrice;
  if (currentPrice > peakPrice) peakPrice = currentPrice;

  if (pnlPct <= -sl) return { sell: true, reason: 'stop_loss', pnlPct };
  if (pnlPct >= tp) return { sell: true, reason: 'take_profit', pnlPct };

  // Breakeven enforcement: once triggered, sell if price drops back to entry
  if (useBreakeven && pos.breakevenTriggered && pnlPct <= 0) {
    return { sell: true, reason: 'breakeven_stop', pnlPct };
  }

  // Early bail: if down more than 2% at the halfway mark, cut losses early
  // Data shows coins that are red at 10min almost never recover by 20min
  const halfHold = maxHold / 2;
  if (holdMinutes >= halfHold && holdMinutes < maxHold && pnlPct <= -2) {
    return { sell: true, reason: 'early_bail', pnlPct };
  }

  // Time limit: only force-close if flat or losing
  if (holdMinutes >= maxHold && pnlPct <= 2) {
    return { sell: true, reason: 'time_limit', pnlPct };
  }
  if (holdMinutes >= maxHold * 2) {
    return { sell: true, reason: 'time_limit_hard', pnlPct };
  }

  // Adaptive trailing: use PEAK pnl to determine trail width so it doesn't
  // tighten during normal pullbacks from a high
  if (useTrail && pnlPct > 0 && peakPrice > 0) {
    const peakPnlPct = ((peakPrice - entry) / entry) * 100;
    const adaptiveTrail = getAdaptiveTrail(peakPnlPct, baseTrail);
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
// Live sell execution
// ====================================================
async function executeLiveSell(user, pos, currentPrice, keypair) {
  const walletAddress = keypair.publicKey.toBase58();
  const amountToSell = (pos.partialSoldAmount || 0) > 0
    ? (pos.tokenAmount || 0) - pos.partialSoldAmount
    : (pos.tokenAmount || 0);
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
      await ScalpTrade.updateOne({ _id: pos._id }, {
        $set: { exitPrice: currentPrice, amountOut: valueOut, pnl, pnlPercent: pnlPct, status: 'CLOSED', exitTime: new Date(), txHash: data.transactionHash, exitReason: 'auto_sell' }
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
    // Fallback to cached trending data
    const cached = trendingCache.data || [];
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
      const tokenAmountToSell = pos.tokenAmount || 0;
      const valueOut = tokenAmountToSell * slippedPrice;
      const pnl = valueOut - (pos.amountIn || 0);
      const pnlPct = ((slippedPrice - pos.entryPrice) / pos.entryPrice) * 100;

      user.trenchPaperBalance = Math.round(((user.trenchPaperBalance ?? 1000) + valueOut) * 100) / 100;

      await ScalpTrade.updateOne({ _id: pos._id }, {
        $set: { exitPrice: slippedPrice, amountOut: valueOut, pnl, pnlPercent: pnlPct, status: 'CLOSED', exitTime: new Date(), exitReason: decision.reason || 'auto' }
      });
      botLog(userId, `SELL ${pos.tokenSymbol} [${decision.reason}] PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) [slip: -${(PAPER_SLIPPAGE * 100).toFixed(0)}%]`);
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
      }
      await user.save({ validateBeforeSave: false });
      notifyUser(user, `Trench SELL ${pos.tokenSymbol}`, `PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`, 'close').catch(() => {});
    } else {
      const keypair = getBotKeypair(user);
      if (!keypair) continue;
      const result = await executeLiveSell(user, pos, currentPrice, keypair);
      if (result) {
        const { pnl, pnlPct } = result;
        user.trenchStats = user.trenchStats || {};
        user.trenchStats.totalPnl = (user.trenchStats.totalPnl || 0) + pnl;
        if (pnl > 0) { user.trenchStats.wins = (user.trenchStats.wins || 0) + 1; user.trenchStats.consecutiveLosses = 0; user.trenchStats.bestTrade = Math.max(user.trenchStats.bestTrade || 0, pnl); }
        else { user.trenchStats.losses = (user.trenchStats.losses || 0) + 1; user.trenchStats.consecutiveLosses = (user.trenchStats.consecutiveLosses || 0) + 1; user.trenchStats.worstTrade = Math.min(user.trenchStats.worstTrade || 0, pnl); }
        await user.save({ validateBeforeSave: false });
        sellCount++;
        botLog(userId, `LIVE SELL ${pos.tokenSymbol} [${decision.reason}] PnL: $${pnl.toFixed(2)}`);
        notifyUser(user, `Trench LIVE SELL ${pos.tokenSymbol}`, `PnL: $${pnl.toFixed(2)}`, 'close').catch(() => {});

        if (pnl > 0 && settings.profitPayoutAddress) {
          const solPrice = currentPrice > 1 ? currentPrice : 85;
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

  const rawSettings = user.trenchAuto || {};
  const settings = sanitizeSettings(rawSettings);
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

  const validTrendings = await fetchTrendingsCached();
  if (validTrendings.length === 0) {
    botLog(userId, 'No trending tokens found, waiting...');
    return;
  }

  const openCount = await ScalpTrade.countDocuments({ userId: user._id, status: 'OPEN' });
  const slotsAvailable = maxPositions - openCount;
  if (slotsAvailable <= 0) {
    if (bot.scanCount % 6 === 0) botLog(userId, `Monitoring ${openCount} positions (${validTrendings.length} tokens tracked)`);
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

  let buyCount = 0;
  let momentumWaiting = 0;
  let filteredOut = 0;
  let cooldownBlocked = 0;
  const maxBuysThisScan = Math.min(MAX_BUYS_PER_SCAN, slotsAvailable);
  if (mode === 'paper') {
    const amountPerTrade = settings.amountPerTradeUsd ?? 50;
    for (const t of candidates) {
      if (buyCount >= maxBuysThisScan) break;
      if ((user.trenchPaperBalance ?? 0) < amountPerTrade) { botLog(userId, 'Insufficient paper balance'); break; }

      // Cheap checks first, expensive API calls last
      const cool = await inCooldown(user._id, t.tokenAddress, settings.cooldownHours ?? 1);
      if (cool) { cooldownBlocked++; continue; }

      const momentum = checkMomentum(t.tokenAddress, t.price);
      if (!momentum.ready) { momentumWaiting++; continue; }

      const pass = await passesEntryFilters(t, settings, blacklist);
      if (!pass) { filteredOut++; continue; }

      try {
        // Apply slippage: entry price is 2% worse than listed
        const slippedEntry = t.price * (1 + PAPER_SLIPPAGE);
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
        const os = t.organicScore ? ` org:${Math.round(t.organicScore)}` : '';
        const h1 = t.priceChange1h ? ` 1h:${(t.priceChange1h).toFixed(1)}%` : '';
        const holders = t.holderCount ? ` hldr:${t.holderCount}` : '';
        const src = (t._sourceCount || 1) > 1 ? ` src:${t._sourceCount}` : '';
        botLog(userId, `BUY ${t.symbol} $${amount.toFixed(2)} @ $${slippedEntry.toFixed(8)} (24h:${(t.priceChange24h || 0).toFixed(1)}%${h1} vol:${vol} liq:${liq} score:${t._qualityScore || 0}${bp}${os}${holders}${src} mom:+${(momentum.changeSinceFirstSight || 0).toFixed(1)}%)`);
        notifyUser(user, `Trench BUY ${t.symbol}`, `$${amount} @ $${slippedEntry.toFixed(8)}`, 'open').catch(() => {});
      } catch (err) {
        botLog(userId, `Buy failed ${t.symbol}: ${err.message}`);
      }
    }
  } else {
    if (!user.trenchBot?.connected || !user.trenchBot?.publicKey) { botLog(userId, 'No bot wallet connected'); return; }
    const keypair = getBotKeypair(user);
    if (!keypair) { botLog(userId, 'Invalid bot wallet key'); return; }
    const walletAddress = keypair.publicKey.toBase58();
    const amountPerTrade = settings.amountPerTradeSol ?? 0.05;

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

      const momentum = checkMomentum(t.tokenAddress, t.price);
      if (!momentum.ready) { momentumWaiting++; continue; }

      const pass = await passesEntryFilters(t, settings, blacklist);
      if (!pass) { filteredOut++; continue; }

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
          const tokenAmount = (amountPerTrade * solPrice) / (t.price || 1e-9);
          await ScalpTrade.create({
            userId: user._id, walletAddress, isPaper: false,
            tokenAddress: t.tokenAddress, tokenSymbol: t.symbol, tokenName: t.name,
            side: 'BUY', amountIn: amountPerTrade, tokenAmount, entryPrice: t.price, peakPrice: t.price, txHash: data.transactionHash, status: 'OPEN'
          });
          buyCount++;
          bot.tradesOpened++;
          botLog(userId, `LIVE BUY ${t.symbol} ${amountPerTrade} SOL @ $${t.price.toFixed(8)}`);
          notifyUser(user, `Trench LIVE BUY ${t.symbol}`, `${amountPerTrade} SOL`, 'open').catch(() => {});
        }
      } catch (err) {
        botLog(userId, `Live buy failed ${t.symbol}: ${err.message}`);
      }
    }
  }

  if (buyCount === 0 && slotsAvailable > 0) {
    const parts = [`${candidates.length} candidates`, `${slotsAvailable} slots`];
    if (filteredOut > 0) parts.push(`${filteredOut} filtered`);
    if (cooldownBlocked > 0) parts.push(`${cooldownBlocked} cooldown`);
    if (momentumWaiting > 0) parts.push(`${momentumWaiting} momentum`);
    botLog(userId, `Scan: ${parts.join(' | ')}`);
  }

  user.trenchAuto.lastRunAt = new Date();
  await user.save({ validateBeforeSave: false });
}

// ====================================================
// START / STOP / STATUS
// ====================================================
function startBot(userId) {
  const uid = userId.toString();
  if (activeBots.has(uid)) return { already: true };

  const bot = {
    startedAt: new Date(),
    scanCount: 0,
    tradesOpened: 0,
    tradesClosed: 0,
    log: [],
    lastAction: null,
    exitInterval: null,
    entryInterval: null
  };
  activeBots.set(uid, bot);

  // Log sanitized settings on start so we can verify
  User.findById(userId).lean().then(u => {
    const s = sanitizeSettings(u?.trenchAuto || {});
    botLog(userId, `Bot STARTED — SL:${s.slPercent}% TP:${s.tpPercent}% hold:${s.maxHoldMinutes}m(bail@${Math.round(s.maxHoldMinutes/2)}m/-2%) slots:${s.maxOpenPositions} (max ${MAX_BUYS_PER_SCAN}/scan) cool:${s.cooldownHours}h(4x losers) minScore:${MIN_QUALITY_SCORE} momentum:120s(must be UP) trail:7/8/12%`);
  }).catch(() => {
    botLog(userId, 'Bot STARTED — exits 10s, entries 60s');
  });

  // First tick: run entry scan immediately (which also seeds momentum cache)
  entryTick(userId).catch(err => botLog(userId, `Entry error: ${err.message}`));

  // Fast exit monitoring loop (10 seconds)
  bot.exitInterval = setInterval(() => {
    exitTick(userId).catch(err => botLog(userId, `Exit error: ${err.message}`));
  }, EXIT_CHECK_INTERVAL);

  // Slower entry scanning loop (90 seconds)
  bot.entryInterval = setInterval(() => {
    entryTick(userId).catch(err => botLog(userId, `Entry error: ${err.message}`));
  }, ENTRY_SCAN_INTERVAL);

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
    startedAt: bot.startedAt,
    scanCount: bot.scanCount,
    tradesOpened: bot.tradesOpened,
    tradesClosed: bot.tradesClosed,
    uptime: Math.round((Date.now() - bot.startedAt.getTime()) / 1000),
    lastAction: bot.lastAction,
    log: bot.log.slice(-20)
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
      startBot(runForUserId);
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

module.exports = { runTrenchAutoTrade, startBot, stopBot, getBotStatus, encrypt, decrypt, getBotKeypair };
