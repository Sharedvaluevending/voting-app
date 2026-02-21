// services/trench-auto-trading.js
// ====================================================
// TRENCH AUTO TRADING - Full feature set
// Paper + Live, profit locking, entry filters, risk controls
// ====================================================

const User = require('../models/User');
const ScalpTrade = require('../models/ScalpTrade');
const mobula = require('./mobula-api');
const crypto = require('crypto');
const push = require('./push-notifications');

const ENCRYPT_KEY = process.env.TRENCH_SECRET || process.env.SESSION_SECRET || 'trench-default-key-change-me';
const ALGO = 'aes-256-gcm';

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
    console.error('[TrenchAuto] Invalid bot key:', e.message);
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

async function passesEntryFilters(t, settings, blacklist) {
  if (!settings.useEntryFilters) return true;
  if (blacklist && blacklist.includes(t.tokenAddress)) return false;
  const max24h = settings.maxPriceChange24hPercent ?? 200;
  if (max24h < 1000 && (t.priceChange24h || 0) >= max24h) return false;
  if ((settings.minLiquidityUsd ?? 0) > 0 || (settings.maxTop10HoldersPercent ?? 100) < 100) {
    try {
      const mk = await mobula.getTokenMarkets('solana', t.tokenAddress);
      if (mk) {
        if ((settings.minLiquidityUsd ?? 0) > 0 && (mk.liquidityUSD || 0) < settings.minLiquidityUsd) return false;
        if ((settings.maxTop10HoldersPercent ?? 100) < 100 && (mk.top10HoldingsPercentage || 100) > settings.maxTop10HoldersPercent) return false;
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

function shouldSellPosition(pos, currentPrice, settings, trendings) {
  if (!currentPrice || currentPrice <= 0) return { sell: false };
  const entry = pos.entryPrice || 0.0000001;
  const pnlPct = ((currentPrice - entry) / entry) * 100;
  const holdMinutes = (Date.now() - new Date(pos.createdAt).getTime()) / 60000;
  const maxHold = settings.maxHoldMinutes ?? 60;
  const tp = settings.tpPercent ?? 15;
  const sl = settings.slPercent ?? 10;
  const trail = settings.trailingStopPercent ?? 10;
  const useTrail = settings.useTrailingStop !== false;
  const useBreakeven = settings.useBreakevenStop !== false;
  const breakevenAt = settings.breakevenAtPercent ?? 5;
  const partialAt = settings.partialTpAtPercent ?? 15;
  const partialPct = settings.partialTpPercent ?? 50;

  let peakPrice = pos.peakPrice || pos.entryPrice;
  if (currentPrice > peakPrice) peakPrice = currentPrice;

  if (holdMinutes >= maxHold) return { sell: true, reason: 'time_limit' };
  if (pnlPct <= -sl) return { sell: true, reason: 'stop_loss' };
  if (pnlPct >= tp) return { sell: true, reason: 'take_profit' };
  if (useTrail && pnlPct > 0 && peakPrice > 0) {
    const dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;
    if (dropFromPeak >= trail) return { sell: true, reason: 'trailing_stop' };
  }
  if (useBreakeven && pnlPct >= breakevenAt && !pos.breakevenTriggered) {
    return { sell: false, updateBreakeven: true };
  }
  if (partialPct > 0 && pnlPct >= partialAt && (pos.partialSoldAmount || 0) === 0) {
    return { sell: true, reason: 'partial_tp', partialPercent: partialPct };
  }
  return { sell: false, peakPrice };
}

async function executeLiveSell(user, pos, currentPrice, keypair, settings) {
  const walletAddress = keypair.publicKey.toBase58();
  const amountToSell = (pos.partialSoldAmount || 0) > 0
    ? (pos.tokenAmount || 0) - pos.partialSoldAmount
    : (pos.tokenAmount || 0);
  if (amountToSell <= 0) return false;
  try {
    const quote = await mobula.getSwapQuote(
      'solana',
      pos.tokenAddress,
      mobula.SOL_MINT,
      amountToSell,
      walletAddress,
      { slippage: 15 }
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
      await ScalpTrade.updateOne(
        { _id: pos._id },
        {
          $set: {
            exitPrice: currentPrice,
            amountOut: valueOut,
            pnl,
            pnlPercent: pnlPct,
            status: 'CLOSED',
            exitTime: new Date(),
            txHash: data.transactionHash,
            exitReason: 'auto_sell'
          }
        }
      );
      return { pnl, pnlPct };
    }
  } catch (e) {
    console.error('[TrenchAuto] Live sell failed:', e.message);
  }
  return null;
}

async function runTrenchAutoTrade() {
  const users = await User.find({ 'trenchAuto.enabled': true }).lean();
  if (users.length === 0) return;

  let trendings = [];
  try {
    trendings = await (mobula.fetchMetaTrendingsMulti || mobula.fetchMetaTrendings)('solana');
  } catch (e) {
    console.error('[TrenchAuto] Mobula fetch failed:', e.message);
    return;
  }

  const validTrendings = trendings.filter(t => t.tokenAddress && t.price > 0 && (t.trendingScore || 0) >= 0);
  if (validTrendings.length === 0) {
    console.log('[TrenchAuto] No valid Solana trendings (need tokenAddress + price). Try MOBULA_API_KEY for full data.');
  }

  for (const u of users) {
    const user = await User.findById(u._id);
    if (!user || !user.trenchAuto?.enabled) continue;

    const settings = user.trenchAuto;
    const intervalMin = settings?.checkIntervalMinutes ?? 15;
    const lastRun = settings?.lastRunAt;
    if (lastRun && intervalMin > 0) {
      const elapsed = (Date.now() - new Date(lastRun).getTime()) / 60000;
      if (elapsed < intervalMin) continue;
    }
    const minScore = settings.minTrendingScore ?? 3;
    const maxPositions = settings.maxOpenPositions ?? 3;
    const mode = settings.mode || 'paper';
    const blacklist = user.trenchBlacklist || [];

    if (user.trenchAuto.lastPausedAt) {
      const pauseHours = 24;
      const elapsed = (Date.now() - new Date(user.trenchAuto.lastPausedAt).getTime()) / 3600000;
      if (elapsed < pauseHours) continue;
      user.trenchAuto.lastPausedAt = null;
      user.trenchAuto.pausedReason = '';
      user.trenchStats = user.trenchStats || {};
      user.trenchStats.consecutiveLosses = 0;
      await user.save({ validateBeforeSave: false });
    }

    const riskCheck = shouldPauseForRisk(user, settings);
    if (riskCheck.pause) {
      user.trenchAuto.lastPausedAt = new Date();
      user.trenchAuto.pausedReason = riskCheck.reason;
      await user.save({ validateBeforeSave: false });
      console.log(`[TrenchAuto] Paused for user ${user.username}: ${riskCheck.reason}`);
      continue;
    }

    resetDailyPnlIfNewDay(user);

    const openPaper = await ScalpTrade.find({ userId: user._id, isPaper: true, status: 'OPEN' }).lean();
    const openLive = await ScalpTrade.find({ userId: user._id, isPaper: false, status: 'OPEN' }).lean();
    const openPositions = mode === 'paper' ? openPaper : openLive;
    const openCount = openPaper.length + openLive.length;
    const heldTokens = new Set([...openPaper, ...openLive].map(p => p.tokenAddress));

    for (const pos of openPositions) {
      const t = validTrendings.find(x => x.tokenAddress === pos.tokenAddress);
      const currentPrice = t ? t.price : pos.entryPrice;
      const decision = shouldSellPosition(pos, currentPrice, settings, validTrendings);

      if (decision.updateBreakeven) {
        await ScalpTrade.updateOne({ _id: pos._id }, { $set: { breakevenTriggered: true } });
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
          await ScalpTrade.updateOne(
            { _id: pos._id },
            { $set: { partialSoldAmount: (pos.partialSoldAmount || 0) + tokenAmountToSell, peakPrice: currentPrice } }
          );
        } else {
          await ScalpTrade.updateOne(
            { _id: pos._id },
            {
              $set: {
                exitPrice: currentPrice,
                amountOut: valueOut,
                pnl,
                pnlPercent: pnlPct,
                status: 'CLOSED',
                exitTime: new Date(),
                exitReason: decision.reason || 'auto'
              }
            }
          );
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
        user.trenchAuto.lastRunAt = new Date();
        await user.save({ validateBeforeSave: false });
        if (!isPartial) {
          notifyUser(user, `Trench SELL ${pos.tokenSymbol}`, `PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`, 'close').catch(() => {});
        }
        console.log(`[TrenchAuto] Paper SELL ${pos.tokenSymbol} ${decision.reason} PnL $${pnl.toFixed(2)} for user ${user.username}`);
      } else {
        const keypair = getBotKeypair(user);
        if (!keypair) continue;
        const result = await executeLiveSell(user, pos, currentPrice, keypair, settings);
        if (result) {
          const { pnl } = result;
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
          user.trenchAuto.lastRunAt = new Date();
          await user.save({ validateBeforeSave: false });
          notifyUser(user, `Trench LIVE SELL ${pos.tokenSymbol}`, `PnL: $${pnl.toFixed(2)}`, 'close').catch(() => {});
          console.log(`[TrenchAuto] Live SELL ${pos.tokenSymbol} PnL $${pnl.toFixed(2)} for user ${user.username}`);
        }
      }
    }

    const openPaperAfter = await ScalpTrade.find({ userId: user._id, isPaper: true, status: 'OPEN' }).lean();
    const openLiveAfter = await ScalpTrade.find({ userId: user._id, isPaper: false, status: 'OPEN' }).lean();
    const heldAfter = new Set([...openPaperAfter, ...openLiveAfter].map(p => p.tokenAddress));

    if (mode === 'paper') {
      const balance = user.trenchPaperBalance ?? 1000;
      const amountPerTrade = settings.amountPerTradeUsd ?? 20;
      if (balance < amountPerTrade || (openPaperAfter.length + openLiveAfter.length) >= maxPositions) continue;

      let candidates = validTrendings
        .filter(t => !heldAfter.has(t.tokenAddress) && (t.trendingScore || 0) >= minScore)
        .sort((a, b) => (b.trendingScore || 0) - (a.trendingScore || 0))
        .slice(0, maxPositions - openPaperAfter.length - openLiveAfter.length);

      if (candidates.length === 0 && validTrendings.length > 0) {
        console.log(`[TrenchAuto] ${user.username}: no buy candidates (${validTrendings.length} trendings, minScore=${minScore}, held=${heldAfter.size}, maxPos=${maxPositions})`);
      }

      for (const t of candidates) {
        if (user.trenchPaperBalance < amountPerTrade) break;
        const pass = await passesEntryFilters(t, settings, blacklist);
        if (!pass) continue;
        const cool = await inCooldown(user._id, t.tokenAddress, settings.cooldownHours ?? 4);
        if (cool) continue;
        try {
          const amount = Math.min(amountPerTrade, user.trenchPaperBalance);
          const tokenAmount = amount / (t.price || 1);
          user.trenchPaperBalance = Math.round((user.trenchPaperBalance - amount) * 100) / 100;
          await user.save();
          await ScalpTrade.create({
            userId: user._id,
            walletAddress: 'paper',
            isPaper: true,
            tokenAddress: t.tokenAddress,
            tokenSymbol: t.symbol,
            tokenName: t.name,
            side: 'BUY',
            amountIn: amount,
            tokenAmount,
            entryPrice: t.price,
            peakPrice: t.price,
            status: 'OPEN'
          });
          user.trenchAuto.lastRunAt = new Date();
          await user.save({ validateBeforeSave: false });
          notifyUser(user, `Trench BUY ${t.symbol}`, `$${amount} @ $${t.price.toFixed(8)}`, 'open').catch(() => {});
          console.log(`[TrenchAuto] Paper BUY ${t.symbol} $${amount} for user ${user.username}`);
        } catch (err) {
          console.error(`[TrenchAuto] Paper buy failed:`, err.message);
        }
      }
    } else {
      if (!user.trenchBot?.connected || !user.trenchBot?.publicKey) continue;
      const keypair = getBotKeypair(user);
      if (!keypair) continue;
      const walletAddress = keypair.publicKey.toBase58();
      const amountPerTrade = settings.amountPerTradeSol ?? 0.05;
      if (openLiveAfter.length >= maxPositions) continue;

      const minSol = settings.minSolBalance ?? 0.05;
      let solBalance = 0;
      try {
        const { Connection, PublicKey } = require('@solana/web3.js');
        const conn = new Connection(process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com');
        const bal = await conn.getBalance(new PublicKey(walletAddress));
        solBalance = bal / 1e9;
      } catch (e) { /* ignore */ }
      if (solBalance < minSol) continue;

      let candidates = validTrendings
        .filter(t => !heldAfter.has(t.tokenAddress) && (t.trendingScore || 0) >= minScore)
        .sort((a, b) => (b.trendingScore || 0) - (a.trendingScore || 0))
        .slice(0, maxPositions - openLiveAfter.length);

      if (candidates.length === 0 && validTrendings.length > 0) {
        console.log(`[TrenchAuto] ${user.username} (live): no buy candidates`);
      }

      for (const t of candidates) {
        const pass = await passesEntryFilters(t, settings, blacklist);
        if (!pass) continue;
        const cool = await inCooldown(user._id, t.tokenAddress, settings.cooldownHours ?? 4);
        if (cool) continue;
        try {
          const quote = await mobula.getSwapQuote('solana', mobula.SOL_MINT, t.tokenAddress, amountPerTrade, walletAddress, { slippage: 8 });
          const serialized = quote?.data?.solana?.transaction?.serialized;
          if (!serialized) continue;
          const { Keypair, VersionedTransaction } = require('@solana/web3.js');
          const txBuf = Buffer.from(serialized, 'base64');
          const tx = VersionedTransaction.deserialize(txBuf);
          tx.sign([keypair]);
          const signedB64 = Buffer.from(tx.serialize()).toString('base64');
          const result = await mobula.sendSwapTransaction('solana', signedB64);
          const data = result.data || result;
          if (data.success && data.transactionHash) {
            const tokenAmount = (amountPerTrade * 200) / (t.price || 1e-9);
            await ScalpTrade.create({
              userId: user._id,
              walletAddress,
              isPaper: false,
              tokenAddress: t.tokenAddress,
              tokenSymbol: t.symbol,
              tokenName: t.name,
              side: 'BUY',
              amountIn: amountPerTrade,
              tokenAmount,
              entryPrice: t.price,
              peakPrice: t.price,
              txHash: data.transactionHash,
              status: 'OPEN'
            });
            user.trenchAuto.lastRunAt = new Date();
            await user.save({ validateBeforeSave: false });
            notifyUser(user, `Trench LIVE BUY ${t.symbol}`, `${amountPerTrade} SOL`, 'open').catch(() => {});
            console.log(`[TrenchAuto] Live BUY ${t.symbol} ${amountPerTrade} SOL for user ${user.username}`);
          }
        } catch (err) {
          console.error(`[TrenchAuto] Live buy failed for ${t.symbol}:`, err.message);
        }
      }
    }
  }
}

module.exports = { runTrenchAutoTrade, encrypt, decrypt, getBotKeypair };
