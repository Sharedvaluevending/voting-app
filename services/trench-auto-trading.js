// services/trench-auto-trading.js
// ====================================================
// TRENCH AUTO TRADING - Persistent bot per user
// Scans every 30s, enters trades, monitors exits, repeats
// ====================================================

const User = require('../models/User');
const ScalpTrade = require('../models/ScalpTrade');
const mobula = require('./mobula-api');
const dexscreener = require('./dexscreener-api');
const crypto = require('crypto');
const push = require('./push-notifications');

const ENCRYPT_KEY = process.env.TRENCH_SECRET || process.env.SESSION_SECRET || 'trench-default-key-change-me';
const ALGO = 'aes-256-gcm';

const BOT_SCAN_INTERVAL = 30 * 1000; // 30 seconds between scans
const TRENDING_CACHE_TTL = 90 * 1000; // cache trending data for 90s
const MAX_LOG_ENTRIES = 50;

// ====================================================
// In-memory bot state per user
// ====================================================
const activeBots = new Map();

let trendingCache = { data: [], fetchedAt: 0 };

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
// Trending data fetcher with cache
// ====================================================

// Quality score: prefer tokens with real volume, liquidity, and moderate gains
// Avoids pump-and-dump tokens (>1000% 24h) and dead tokens (<0%)
function scoreCandidate(t) {
  const change = t.priceChange24h || 0;
  const vol = t.volume24h || 0;
  const liq = t.liquidity || 0;

  // Hard reject: extreme pumps (likely rug/dump) or tokens already crashing
  if (change > 2000) return -1;
  if (change < -30) return -1;
  if (vol < 5000) return -1;
  if (liq < 3000) return -1;

  let score = 0;

  // Sweet spot: moderate gainers (5-500%) are ideal for scalping
  if (change >= 5 && change <= 50) score += 30;
  else if (change > 50 && change <= 200) score += 25;
  else if (change > 200 && change <= 500) score += 15;
  else if (change > 500 && change <= 1000) score += 5;
  else if (change > 1000) score += 0;
  else if (change >= 0 && change < 5) score += 10;

  // Volume matters: tokens with real trading activity
  if (vol >= 100000) score += 30;
  else if (vol >= 50000) score += 25;
  else if (vol >= 20000) score += 20;
  else if (vol >= 10000) score += 15;
  else score += 5;

  // Liquidity: need enough to actually exit the trade
  if (liq >= 50000) score += 25;
  else if (liq >= 20000) score += 20;
  else if (liq >= 10000) score += 15;
  else if (liq >= 5000) score += 10;
  else score += 3;

  return score;
}

async function fetchTrendingsCached() {
  if (Date.now() - trendingCache.fetchedAt < TRENDING_CACHE_TTL && trendingCache.data.length > 0) {
    return trendingCache.data;
  }
  let trendings = [];
  try {
    trendings = await dexscreener.fetchSolanaTrendings(300);
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

  // Score and sort by quality, not raw pump percentage
  const scored = Array.from(seen.values()).map(t => {
    t._qualityScore = scoreCandidate(t);
    return t;
  }).filter(t => t._qualityScore > 0);

  scored.sort((a, b) => b._qualityScore - a._qualityScore);

  const all = Array.from(seen.values());
  console.log(`[TrenchBot] ${all.length} total tokens, ${scored.length} pass quality filter (vol>$5k, liq>$3k, change -30% to +2000%)`);

  trendingCache = { data: scored, fetchedAt: Date.now() };
  return scored;
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
  const consecLoss = settings.consecutiveLossesToPause ?? 5;
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
  let max24h = settings.maxPriceChange24hPercent ?? 5000;
  if (max24h < 500) max24h = 5000;
  if (max24h < 10000 && (t.priceChange24h || 0) >= max24h) return false;
  let minLiq = settings.minLiquidityUsd ?? 0;
  let maxTop10 = settings.maxTop10HoldersPercent ?? 100;
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
  return hours < cooldownHours;
}

// ====================================================
// Exit logic
// ====================================================
function shouldSellPosition(pos, currentPrice, settings) {
  if (!currentPrice || currentPrice <= 0) return { sell: false };
  const entry = pos.entryPrice || 0.0000001;
  const pnlPct = ((currentPrice - entry) / entry) * 100;
  const holdMinutes = (Date.now() - new Date(pos.createdAt).getTime()) / 60000;
  const maxHold = settings.maxHoldMinutes ?? 30;
  const tp = settings.tpPercent ?? 25;
  const sl = settings.slPercent ?? 8;
  const trail = settings.trailingStopPercent ?? 8;
  const useTrail = settings.useTrailingStop !== false;
  const useBreakeven = settings.useBreakevenStop !== false;
  const breakevenAt = settings.breakevenAtPercent ?? 5;
  const partialAt = settings.partialTpAtPercent ?? 15;
  const partialPct = settings.partialTpPercent ?? 50;

  let peakPrice = pos.peakPrice || pos.entryPrice;
  if (currentPrice > peakPrice) peakPrice = currentPrice;

  if (holdMinutes >= maxHold) return { sell: true, reason: 'time_limit', pnlPct };
  if (pnlPct <= -sl) return { sell: true, reason: 'stop_loss', pnlPct };
  if (pnlPct >= tp) return { sell: true, reason: 'take_profit', pnlPct };
  if (useTrail && pnlPct > 0 && peakPrice > 0) {
    const dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;
    if (dropFromPeak >= trail) return { sell: true, reason: 'trailing_stop', pnlPct };
  }
  if (useBreakeven && pnlPct >= breakevenAt && !pos.breakevenTriggered) {
    return { sell: false, updateBreakeven: true, peakPrice };
  }
  if (partialPct > 0 && pnlPct >= partialAt && (pos.partialSoldAmount || 0) === 0) {
    return { sell: true, reason: 'partial_tp', partialPercent: partialPct, pnlPct };
  }
  return { sell: false, peakPrice };
}

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
// SINGLE BOT TICK - one scan cycle for one user
// ====================================================
async function botTick(userId) {
  const bot = activeBots.get(userId.toString());
  if (!bot) return;
  bot.scanCount++;

  const user = await User.findById(userId);
  if (!user) { stopBot(userId); return; }

  const settings = user.trenchAuto || {};
  const mode = settings.mode || 'paper';
  const maxPositions = settings.maxOpenPositions ?? 3;
  const blacklist = user.trenchBlacklist || [];
  const minScore = settings.minTrendingScore ?? 0;

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

  // Fetch trending tokens (cached)
  const validTrendings = await fetchTrendingsCached();
  if (validTrendings.length === 0) {
    botLog(userId, 'No trending tokens found, waiting...');
    return;
  }

  const openPaper = await ScalpTrade.find({ userId: user._id, isPaper: true, status: 'OPEN' }).lean();
  const openLive = await ScalpTrade.find({ userId: user._id, isPaper: false, status: 'OPEN' }).lean();
  const openPositions = mode === 'paper' ? openPaper : openLive;
  const allOpen = [...openPaper, ...openLive];

  // ---- PHASE 1: CHECK EXITS ----
  let sellCount = 0;
  for (const pos of openPositions) {
    const t = validTrendings.find(x => x.tokenAddress === pos.tokenAddress);
    let currentPrice = t ? t.price : 0;
    if (!currentPrice || currentPrice <= 0) {
      try {
        const pairData = await dexscreener.fetchTokenPairs('solana', pos.tokenAddress);
        if (pairData && pairData.price > 0) currentPrice = pairData.price;
      } catch (e) { /* ignore */ }
    }
    if (!currentPrice || currentPrice <= 0) currentPrice = pos.entryPrice;

    const decision = shouldSellPosition(pos, currentPrice, settings);

    if (decision.updateBreakeven) {
      await ScalpTrade.updateOne({ _id: pos._id }, { $set: { breakevenTriggered: true } });
      botLog(userId, `Breakeven triggered on ${pos.tokenSymbol}`);
      continue;
    }
    if (decision.peakPrice) {
      await ScalpTrade.updateOne({ _id: pos._id }, { $set: { peakPrice: decision.peakPrice } });
    }
    if (!decision.sell) continue;

    if (mode === 'paper') {
      const isPartial = decision.reason === 'partial_tp' && (settings.partialTpPercent ?? 0) > 0;
      const sellPct = isPartial ? (settings.partialTpPercent ?? 50) / 100 : 1;
      const tokenAmountToSell = (pos.tokenAmount || 0) * sellPct;
      const valueOut = tokenAmountToSell * currentPrice;
      const pnl = valueOut - (pos.amountIn || 0) * sellPct;
      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      user.trenchPaperBalance = Math.round(((user.trenchPaperBalance ?? 1000) + valueOut) * 100) / 100;

      if (isPartial) {
        await ScalpTrade.updateOne({ _id: pos._id }, { $set: { partialSoldAmount: (pos.partialSoldAmount || 0) + tokenAmountToSell, peakPrice: currentPrice } });
        botLog(userId, `PARTIAL SELL ${pos.tokenSymbol} ${pnlPct.toFixed(1)}%`);
      } else {
        await ScalpTrade.updateOne({ _id: pos._id }, {
          $set: { exitPrice: currentPrice, amountOut: valueOut, pnl, pnlPercent: pnlPct, status: 'CLOSED', exitTime: new Date(), exitReason: decision.reason || 'auto' }
        });
        botLog(userId, `SELL ${pos.tokenSymbol} [${decision.reason}] PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
        sellCount++;
      }

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
      if (!isPartial) notifyUser(user, `Trench SELL ${pos.tokenSymbol}`, `PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`, 'close').catch(() => {});
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
      }
    }
  }

  // ---- PHASE 2: SCAN FOR NEW ENTRIES ----
  const openAfterSells = await ScalpTrade.countDocuments({ userId: user._id, status: 'OPEN' });
  const slotsAvailable = maxPositions - openAfterSells;
  if (slotsAvailable <= 0) {
    if (bot.scanCount % 10 === 0) botLog(userId, `Monitoring ${openAfterSells} positions (${validTrendings.length} tokens tracked)`);
    return;
  }

  const heldTokens = new Set((await ScalpTrade.find({ userId: user._id, status: 'OPEN' }).lean()).map(p => p.tokenAddress));

  const candidates = validTrendings
    .filter(t => !heldTokens.has(t.tokenAddress) && !blacklist.includes(t.tokenAddress) && t.price > 0)
    .slice(0, 200);

  if (candidates.length === 0) {
    botLog(userId, `Scanning... ${validTrendings.length} tokens found, 0 candidates after filters`);
    return;
  }

  let buyCount = 0;
  if (mode === 'paper') {
    const amountPerTrade = settings.amountPerTradeUsd ?? 50;
    for (const t of candidates) {
      if (buyCount >= slotsAvailable) break;
      if ((user.trenchPaperBalance ?? 0) < amountPerTrade) { botLog(userId, 'Insufficient paper balance'); break; }
      const pass = await passesEntryFilters(t, settings, blacklist);
      if (!pass) continue;
      const cool = await inCooldown(user._id, t.tokenAddress, settings.cooldownHours ?? 1);
      if (cool) continue;
      try {
        const amount = Math.min(amountPerTrade, user.trenchPaperBalance);
        const tokenAmount = amount / (t.price || 1);
        user.trenchPaperBalance = Math.round((user.trenchPaperBalance - amount) * 100) / 100;
        await user.save({ validateBeforeSave: false });
        await ScalpTrade.create({
          userId: user._id, walletAddress: 'paper', isPaper: true,
          tokenAddress: t.tokenAddress, tokenSymbol: t.symbol, tokenName: t.name,
          side: 'BUY', amountIn: amount, tokenAmount, entryPrice: t.price, peakPrice: t.price, status: 'OPEN'
        });
        buyCount++;
        bot.tradesOpened++;
        const vol = (t.volume24h || 0) >= 1000 ? '$' + Math.round((t.volume24h || 0) / 1000) + 'k' : '$' + Math.round(t.volume24h || 0);
        const liq = (t.liquidity || 0) >= 1000 ? '$' + Math.round((t.liquidity || 0) / 1000) + 'k' : '$' + Math.round(t.liquidity || 0);
        botLog(userId, `BUY ${t.symbol} $${amount.toFixed(2)} @ $${t.price.toFixed(8)} (24h: ${(t.priceChange24h || 0).toFixed(1)}%, vol: ${vol}, liq: ${liq}, score: ${t._qualityScore || 0})`);
        notifyUser(user, `Trench BUY ${t.symbol}`, `$${amount} @ $${t.price.toFixed(8)}`, 'open').catch(() => {});
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
      if (buyCount >= slotsAvailable) break;
      const pass = await passesEntryFilters(t, settings, blacklist);
      if (!pass) continue;
      const cool = await inCooldown(user._id, t.tokenAddress, settings.cooldownHours ?? 1);
      if (cool) continue;
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
          const tokenAmount = (amountPerTrade * 200) / (t.price || 1e-9);
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
    botLog(userId, `Scanning... ${candidates.length} candidates checked, ${slotsAvailable} slots open, waiting for entry...`);
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
    interval: null
  };
  activeBots.set(uid, bot);

  botLog(userId, 'Bot STARTED - scanning every 30s');

  // Run first tick immediately
  botTick(userId).catch(err => botLog(userId, `Error: ${err.message}`));

  bot.interval = setInterval(() => {
    botTick(userId).catch(err => botLog(userId, `Error: ${err.message}`));
  }, BOT_SCAN_INTERVAL);

  return { started: true };
}

function stopBot(userId) {
  const uid = userId.toString();
  const bot = activeBots.get(uid);
  if (!bot) return { already: true };
  if (bot.interval) clearInterval(bot.interval);
  botLog(userId, 'Bot STOPPED');
  activeBots.delete(uid);
  return { stopped: true, scanCount: bot.scanCount, tradesOpened: bot.tradesOpened };
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
    uptime: Math.round((Date.now() - bot.startedAt.getTime()) / 1000),
    lastAction: bot.lastAction,
    log: bot.log.slice(-20)
  };
}

// ====================================================
// Legacy: background scheduler for users with enabled flag
// (keeps running for users who enabled auto but haven't clicked Start)
// ====================================================
async function runTrenchAutoTrade(opts = {}) {
  const forceRun = !!opts.forceRun;
  const runForUserId = opts.runForUserId;

  if (runForUserId) {
    // If called for a specific user, just run a single tick via the bot system
    const uid = runForUserId.toString();
    if (!activeBots.has(uid)) {
      startBot(runForUserId);
    }
    return { started: true };
  }

  // Background: check all users with enabled flag who don't have an active bot
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
      // Run a single tick for this user without starting persistent bot
      try {
        await botTick(u._id);
        started++;
      } catch (e) {
        console.error(`[TrenchBot] Background tick error for ${u.username}:`, e.message);
      }
    }
  }
  return { users: users.length, ticked: started };
}

module.exports = { runTrenchAutoTrade, startBot, stopBot, getBotStatus, encrypt, decrypt, getBotKeypair };
