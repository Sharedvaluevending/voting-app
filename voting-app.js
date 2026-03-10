// voting-app.js
// ====================================================
// CRYPTO SIGNALS PRO v3.0
// Professional crypto trading signals platform with:
//   - Multi-strategy 0-100 scoring engine
//   - Bitget OHLCV candles + CoinGecko prices
//   - User accounts with paper trading ($10k start)
//   - 1 trade per pair, suggested leverage
//   - Trade tracking, performance analytics
//   - Trading journal, educational content
//   - Learning engine (tracks outcomes, adjusts weights)
// ====================================================

require('dotenv').config();

const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.2,
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers.cookie;
        delete event.request.headers.authorization;
      }
      return event;
    }
  });
}

const cluster = require('cluster');
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const compression = require('compression');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const cron = require('node-cron');

// In PM2 cluster mode, only one worker should run scheduled/interval tasks
// to avoid duplicated DB writes, API calls, and external service hits.
// PM2 sets NODE_APP_INSTANCE=0,1,2... for each cluster worker.
const _pmInstanceId = process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? null;
const IS_PRIMARY_WORKER = _pmInstanceId == null || String(_pmInstanceId) === '0';
console.log(`[Worker] pid=${process.pid} instance=${_pmInstanceId ?? 'standalone'} IS_PRIMARY=${IS_PRIMARY_WORKER}`);

// Prevent unhandled promise rejections (e.g. MongoDB) from crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled rejection (non-fatal):', reason?.message || reason);
});
const session = require('express-session');
const MongoStore = require('connect-mongo');
const crypto = require('crypto');
const path = require('path');
const Queue = require('bull');
const jwt = require('jsonwebtoken');

const { fetchAllPrices, fetchAllCandles, fetchAllCandlesForCoin, fetchAllHistory, fetchCandles, getCurrentPrice, fetchLivePrice, isDataReady, getFundingRate, getAllFundingRates, isCandleFresh, getCandleSource, recordScoreHistory, getScoreHistory, recordRegimeSnapshot, getRegimeTimeline, pricesReadyPromise, TRACKED_COINS, COIN_META, registerScannerCoinMeta, getCoinMeta, fetchCoinDataForDetail } = require('./services/crypto-api');
const { analyzeAllCoins, analyzeCoin } = require('./services/trading-engine');
const { requireLogin, optionalUser, guestOnly } = require('./middleware/auth');
const {
  requirePro,
  requireElite,
  requireTrench,
  checkCopilotLimit,
  checkLLMLimit,
  checkVoiceLimit,
  getMonthlyLimits
} = require('./middleware/subscription');
const { openTrade, closeTrade, closeTradePartial, updateTradeLevels, checkStopsAndTPs, recheckTradeScores, SCORE_RECHECK_MINUTES, getOpenTrades, getTradeHistory, getPerformanceStats, resetAccount, suggestLeverage, reconcileBalance, fixBalance } = require('./services/paper-trading');
const { initializeStrategies, getPerformanceReport, resetStrategyWeights } = require('./services/learning-engine');
const { runBacktest, runBacktestForCoin } = require('./services/backtest');
const bitget = require('./services/bitget');
const { getWebSocketPrice, getAllWebSocketPrices, addBrowserClient, isWebSocketConnected, shutdown: shutdownWebSocketPrices } = require('./services/websocket-prices');
const { approveTrade, checkOllamaReachable } = require('./services/ollama-client');
const { runAgent } = require('./services/llm-agent');
const { parseBase64Audio, transcribeWithWhisper, synthesizeWithPiper } = require('./services/voice-copilot');
const {
  getConfig: getFreeSignalConfig,
  saveConfig: saveFreeSignalConfig,
  lookupUserByEmail: lookupFreeSignalUserByEmail,
  runPeriodicFreeSignalUpdate
} = require('./services/free-signal-discord');
const { sendLifecycleEmail } = require('./services/email');
const {
  getAdminDiscordConfig,
  saveAdminDiscordConfig,
  postMassiveBacktestToDiscord,
  postBacktestRunToDiscord,
  resolveUserByEmail: resolveAdminDiscordUserByEmail
} = require('./services/admin-discord');
const StrategyWeight = require('./models/StrategyWeight');
const {
  buildCacheStatusMatrix,
  getCacheStorageStats,
  formatBytes,
  syncAllCandles,
  syncCoinTimeframe,
  populateMissingCandles,
  cleanupOldCandles,
  logStartupStats,
  CACHE_TIMEFRAMES,
  MS_PER_TIMEFRAME
} = require('./services/candle-cache');

const User = require('./models/User');
const Trade = require('./models/Trade');
const Journal = require('./models/Journal');
const Alert = require('./models/Alert');
const CandleCache = require('./models/CandleCache');
const Referral = require('./models/Referral');
const CommissionTransaction = require('./models/CommissionTransaction');
const BetaCode = require('./models/BetaCode');
const SystemConfig = require('./models/SystemConfig');
const { getStripeClient, getPriceConfig, handleStripeEvent } = require('./services/stripe-billing');
const { cacheResponse } = require('./services/cache-store');

const app = express();
const PORT = process.env.PORT || 3000;
const stripe = getStripeClient();
const APP_BASE_URL = process.env.BASE_URL || 'https://alphaconfluence.com';
const STRIPE_PRICE_CONFIG = getPriceConfig();
const REGIME_KEYS = ['trending', 'ranging', 'volatile', 'compression', 'mixed'];
app.set('trust proxy', 1);
const STARTED_AT_MS = Date.now();
const SLOW_HTTP_MS = Number(process.env.SLOW_HTTP_MS || 1200);
const SLOW_DB_MS = Number(process.env.SLOW_DB_MS || 300);
const METRICS_WINDOW_MS = 10 * 60 * 1000;
const STRATEGY_WEIGHTS_TTL_MS = Number(process.env.STRATEGY_WEIGHTS_TTL_MS || 30000);
const USER_NAV_CACHE_TTL_MS = Number(process.env.USER_NAV_CACHE_TTL_MS || 15000);

const opsMetrics = {
  http: {
    byRoute: new Map(),
    latencies: [],
    total: 0,
    errors5xx: 0
  },
  db: {
    byOp: new Map(),
    latencies: [],
    total: 0,
    errors: 0
  }
};
const strategyWeightsCache = { data: null, loadedAt: 0 };
const userNavSnapshotCache = new Map();
const topPerformersCache = { data: [], loadedAt: 0 };
const TOP_PERFORMERS_TTL_MS = Number(process.env.TOP_PERFORMERS_TTL_MS || 60000);
const healthResponseCache = { payload: null, loadedAt: 0 };
const HEALTH_CACHE_TTL_MS = Number(process.env.HEALTH_CACHE_TTL_MS || 2500);
const landingPageCache = { html: '', loadedAt: 0 };
const LANDING_CACHE_TTL_MS = Number(process.env.LANDING_CACHE_TTL_MS || 30000);

function parseEnvList(v) {
  return String(v || '')
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeReferralCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function normalizeSelectedPlan(plan) {
  const normalized = String(plan || '').trim().toLowerCase();
  return normalized === 'elite' ? 'elite' : (normalized === 'pro' ? 'pro' : '');
}

const _betaConfigCache = { data: null, fetchedAt: 0 };
async function getBetaConfig() {
  const now = Date.now();
  if (_betaConfigCache.data && (now - _betaConfigCache.fetchedAt) < 5000) return _betaConfigCache.data;
  try {
    const doc = await SystemConfig.findOne({ key: 'beta_config' }).lean();
    const val = doc?.value || {};
    _betaConfigCache.data = { enabled: !!val.enabled, referralsEnabled: !!val.referralsEnabled };
    _betaConfigCache.fetchedAt = now;
    return _betaConfigCache.data;
  } catch { return { enabled: false, referralsEnabled: true }; }
}

function getClientIpAddress(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || req.connection?.remoteAddress || 'unknown';
}

function hashIpAddress(ip) {
  const cleanIp = String(ip || '').trim();
  if (!cleanIp) return '';
  return crypto.createHash('sha256').update(cleanIp).digest('hex');
}

function getTrialDaysRemaining(user) {
  if (!user?.trialEndsAt) return 0;
  const diff = new Date(user.trialEndsAt).getTime() - Date.now();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

const PACK_PRICE_OPTIONS = {
  copilot: {
    50: 299,
    200: 799,
    500: 1499
  },
  llm: {
    50: 299,
    200: 799,
    500: 1499
  },
  voice: {
    30: 299,
    120: 799,
    300: 1499
  }
};

function getPackPriceId(packType, packAmount) {
  const cfg = STRIPE_PRICE_CONFIG?.packs || {};
  const typeCfg = cfg[String(packType || '').toLowerCase()] || {};
  return typeCfg[String(packAmount || '')] || '';
}

async function resolveTrenchPriceId() {
  if (STRIPE_PRICE_CONFIG?.trench) return STRIPE_PRICE_CONFIG.trench;
  if (!stripe) return '';

  const products = await stripe.products.list({ active: true, limit: 100 });
  const trenchProduct = (products.data || []).find((p) => {
    const tier = String(p?.metadata?.tier || '').toLowerCase();
    const name = String(p?.name || '').toLowerCase();
    return tier === 'trench' || name.includes('trench warfare');
  });
  if (!trenchProduct) return '';

  const prices = await stripe.prices.list({ product: trenchProduct.id, active: true, limit: 100 });
  const monthly = (prices.data || []).find((p) => p?.recurring?.interval === 'month' && Number(p?.unit_amount || 0) === 500)
    || (prices.data || []).find((p) => p?.recurring?.interval === 'month');
  return monthly?.id || '';
}

function computeUsageSnapshot(user) {
  const monthly = getMonthlyLimits(user || {});
  const tier = String(user?.subscriptionTier || 'free');
  const eliteLike = tier === 'elite' || tier === 'partner';
  return {
    tier,
    copilotUsed: user?.copilotQuestionsUsed || 0,
    copilotLimit: monthly.copilot,
    copilotPackRemaining: user?.copilotPackQuestions || 0,
    llmUsed: user?.llmMessagesUsed || 0,
    llmLimit: monthly.llm,
    llmPackRemaining: user?.llmPackMessages || 0,
    voiceUsed: user?.voiceMinutesUsed || 0,
    voiceLimit: monthly.voice,
    voicePackRemaining: user?.voicePackMinutes || 0,
    unlimitedLabel: eliteLike ? 'Unlimited' : null
  };
}

function estimateAudioMinutes(audioBuffer, mimeType) {
  const bytes = Number(audioBuffer?.length || 0);
  if (bytes <= 0) return 0;
  const mt = String(mimeType || '').toLowerCase();
  const bytesPerMinute = mt.includes('wav') ? 1920000 : 240000;
  return Math.max(0, bytes / bytesPerMinute);
}

function requireProForLargeBacktest(req, res, next) {
  const bodyCoins = Array.isArray(req.body?.coins) ? req.body.coins : [];
  const coinCount = bodyCoins.length > 0 ? bodyCoins.length : (req.body?.coinId ? 1 : 0);
  if (coinCount <= 3) return next();
  return requirePro(req, res, next);
}
const ADMIN_EMAILS = parseEnvList(process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '');
const ADMIN_USERNAMES = parseEnvList(process.env.ADMIN_USERNAMES || process.env.ADMIN_USERNAME || 'admin');

function isAdminIdentity(user) {
  if (!user) return false;
  if (user.isAdmin === true) return true;
  const email = String(user.email || '').toLowerCase();
  const username = String(user.username || '').toLowerCase();
  return (email && ADMIN_EMAILS.includes(email)) || (username && ADMIN_USERNAMES.includes(username));
}

async function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ success: false, error: 'Login required' });
    }
    return res.redirect('/login');
  }
  try {
    const user = await User.findById(req.session.userId).select('email username isAdmin').lean();
    if (!isAdminIdentity(user)) {
      return res.status(403).send('Admin access required');
    }
    req.adminUser = user;
    return next();
  } catch (err) {
    return res.status(500).send('Admin auth failed');
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function trimMetricArray(arr, maxLen = 5000) {
  if (arr.length > maxLen) arr.splice(0, arr.length - maxLen);
}

function cleanupOldMetrics() {
  const now = Date.now();
  for (const [k, v] of opsMetrics.http.byRoute.entries()) {
    if (now - v.lastAt > METRICS_WINDOW_MS) opsMetrics.http.byRoute.delete(k);
  }
  for (const [k, v] of opsMetrics.db.byOp.entries()) {
    if (now - v.lastAt > METRICS_WINDOW_MS) opsMetrics.db.byOp.delete(k);
  }
  for (const [k, v] of userNavSnapshotCache.entries()) {
    if (now - v.at > (USER_NAV_CACHE_TTL_MS * 8)) userNavSnapshotCache.delete(k);
  }
}

const runtimeIntervals = new Set();
const runtimeTimeouts = new Set();
const taskLocks = new Map();
const MAX_TIMER_MS = 2147483647; // Node max signed 32-bit timer delay (~24.8 days)

function safeTimerMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > MAX_TIMER_MS) return MAX_TIMER_MS;
  return Math.floor(n);
}

function trackInterval(fn, ms) {
  const delay = safeTimerMs(ms);
  const id = setInterval(fn, delay);
  runtimeIntervals.add(id);
  return id;
}

function trackTimeout(fn, ms) {
  const delay = safeTimerMs(ms);
  const id = setTimeout(() => {
    runtimeTimeouts.delete(id);
    fn();
  }, delay);
  runtimeTimeouts.add(id);
  return id;
}

function runNonOverlapping(taskName, fn) {
  if (taskLocks.get(taskName)) return;
  taskLocks.set(taskName, true);
  Promise.resolve()
    .then(() => fn())
    .catch((err) => {
      console.warn(`[Task:${taskName}]`, err?.message || err);
    })
    .finally(() => {
      taskLocks.delete(taskName);
    });
}

async function getStrategyWeightsCached() {
  const now = Date.now();
  if (strategyWeightsCache.data && (now - strategyWeightsCache.loadedAt) < STRATEGY_WEIGHTS_TTL_MS) {
    return strategyWeightsCache.data;
  }
  const strategyWeights = await StrategyWeight.find({ active: true }).lean();
  strategyWeightsCache.data = strategyWeights || [];
  strategyWeightsCache.loadedAt = now;
  return strategyWeightsCache.data;
}

function getTopPerformerCoinsCached() {
  const now = Date.now();
  if (topPerformersCache.data.length > 0 && (now - topPerformersCache.loadedAt) < TOP_PERFORMERS_TTL_MS) {
    return topPerformersCache.data;
  }
  try {
    const resultsDir = path.join(__dirname, 'data/backtest-results');
    if (!fs.existsSync(resultsDir)) return [];
    const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('massive-') && f.endsWith('.json'));
    if (files.length === 0) return [];
    const latest = files.sort().reverse()[0];
    const data = JSON.parse(fs.readFileSync(path.join(resultsDir, latest), 'utf8'));
    topPerformersCache.data = (data.top10 || []).slice(0, 5).map(c => c.symbol);
    topPerformersCache.loadedAt = now;
    return topPerformersCache.data;
  } catch (e) {
    return [];
  }
}

function createRateLimiter(opts = {}) {
  const windowMs = Math.max(1000, Number(opts.windowMs) || 60000);
  const max = Math.max(1, Number(opts.max) || 60);
  const keyPrefix = String(opts.keyPrefix || 'global');
  const blockedMessage = opts.message || 'Too many requests. Please try again shortly.';
  const customKeyGenerator = typeof opts.keyGenerator === 'function' ? opts.keyGenerator : null;
  const buckets = new Map();

  function getClientIp(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xff || req.ip || req.connection?.remoteAddress || 'unknown';
  }

  trackInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets.entries()) {
      if ((now - entry.startedAt) > (windowMs * 2)) buckets.delete(key);
    }
  }, Math.max(30000, windowMs));

  return function limiter(req, res, next) {
    const rawKey = customKeyGenerator ? customKeyGenerator(req) : getClientIp(req);
    const key = `${keyPrefix}:${String(rawKey || getClientIp(req))}`;
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || (now - entry.startedAt) > windowMs) {
      entry = { count: 0, startedAt: now };
      buckets.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - entry.startedAt)) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ success: false, error: blockedMessage, retryAfterSeconds });
    }
    next();
  };
}

function hasOpsMetricsAccess(req) {
  const configuredKey = String(process.env.OPS_METRICS_KEY || '').trim();
  const providedKey = String(req.headers['x-ops-key'] || '').trim();
  if (configuredKey && providedKey && providedKey === configuredKey) return true;

  // Local-only fallback when no ops key is configured (useful for local profiling)
  if (!configuredKey) {
    const ip = String(req.ip || req.connection?.remoteAddress || '');
    if (ip === '127.0.0.1' || ip === '::1' || ip.endsWith('::ffff:127.0.0.1')) return true;
  }
  return false;
}

// ====================================================
// MONGODB — non-fatal: app works without DB (backtest, signals still run)
// Features that need DB (trades, journal, auth) degrade gracefully.
// ====================================================
const mongoURI = process.env.MONGODB_URI || (process.env.NODE_ENV === 'production' ? null : 'mongodb://127.0.0.1:27017/votingApp');
if (!mongoURI && process.env.NODE_ENV === 'production') {
  console.warn('[DB] MONGODB_URI not set in production. Auth, trades, and journal disabled. Set MONGODB_URI in Render to enable.');
}

// Prefer explicit standard URI on Render to avoid SRV DNS issues (ENOTFOUND)
const uri = process.env.MONGODB_URI_STANDARD || mongoURI;
let dbConnected = false;

if (uri) {
  mongoose.set('bufferCommands', false);
  mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 100),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 10),
    maxIdleTimeMS: Number(process.env.MONGO_MAX_IDLE_MS || 30000),
    waitQueueTimeoutMS: Number(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS || 12000),
    heartbeatFrequencyMS: Number(process.env.MONGO_HEARTBEAT_MS || 10000),
    autoIndex: process.env.NODE_ENV !== 'production'
  })
    .then(() => {
      dbConnected = true;
      console.log('[DB] Connected to MongoDB');
      initializeStrategies().catch(err => console.error('[DB] Strategy init error:', err.message));
      logStartupStats().catch(err => console.warn('[Cache] Startup stats error:', err.message));
    })
    .catch(err => {
      console.warn('[DB] MongoDB not available — running without database. Trades, auth, and journal disabled.');
      console.warn('[DB] Reason:', err.message);
      if (uri.startsWith('mongodb+srv://') && process.env.NODE_ENV === 'production') {
        console.warn('[DB] Tip: On Render, use the standard connection string (mongodb://...) in MONGODB_URI or MONGODB_URI_STANDARD to avoid SRV DNS errors.');
      }
    });

  // Prevent MongoDB errors from crashing the process
  mongoose.connection.on('error', err => {
    console.warn('[DB] MongoDB error (non-fatal):', err.message);
  });
} else {
  console.warn('[DB] No MongoDB URI configured — running without database.');
}

// ====================================================
// OPS INSTRUMENTATION: slow DB query tracking
// ====================================================
if (!mongoose.__opsInstrumentationPatched) {
  mongoose.__opsInstrumentationPatched = true;
  const QueryProto = mongoose.Query && mongoose.Query.prototype;
  if (QueryProto && typeof QueryProto.exec === 'function') {
    const origExec = QueryProto.exec;
    QueryProto.exec = async function patchedExec(...args) {
      const started = Date.now();
      try {
        const out = await origExec.apply(this, args);
        const elapsed = Date.now() - started;
        opsMetrics.db.total += 1;
        opsMetrics.db.latencies.push(elapsed);
        trimMetricArray(opsMetrics.db.latencies, 4000);
        const modelName = this.model?.modelName || 'unknown';
        const op = this.op || 'query';
        const key = `${modelName}.${op}`;
        const m = opsMetrics.db.byOp.get(key) || { count: 0, slow: 0, totalMs: 0, maxMs: 0, lastAt: 0 };
        m.count += 1;
        m.totalMs += elapsed;
        m.maxMs = Math.max(m.maxMs, elapsed);
        m.lastAt = Date.now();
        if (elapsed >= SLOW_DB_MS) {
          m.slow += 1;
          if (process.env.NODE_ENV !== 'test') {
            console.warn(`[DB-SLOW] ${key} took ${elapsed}ms`);
          }
        }
        opsMetrics.db.byOp.set(key, m);
        return out;
      } catch (err) {
        opsMetrics.db.errors += 1;
        throw err;
      }
    };
  }

  const AggProto = mongoose.Aggregate && mongoose.Aggregate.prototype;
  if (AggProto && typeof AggProto.exec === 'function') {
    const origAggExec = AggProto.exec;
    AggProto.exec = async function patchedAggExec(...args) {
      const started = Date.now();
      try {
        const out = await origAggExec.apply(this, args);
        const elapsed = Date.now() - started;
        opsMetrics.db.total += 1;
        opsMetrics.db.latencies.push(elapsed);
        trimMetricArray(opsMetrics.db.latencies, 4000);
        const modelName = this._model?.modelName || 'unknown';
        const key = `${modelName}.aggregate`;
        const m = opsMetrics.db.byOp.get(key) || { count: 0, slow: 0, totalMs: 0, maxMs: 0, lastAt: 0 };
        m.count += 1;
        m.totalMs += elapsed;
        m.maxMs = Math.max(m.maxMs, elapsed);
        m.lastAt = Date.now();
        if (elapsed >= SLOW_DB_MS) {
          m.slow += 1;
          if (process.env.NODE_ENV !== 'test') {
            console.warn(`[DB-SLOW] ${key} took ${elapsed}ms`);
          }
        }
        opsMetrics.db.byOp.set(key, m);
        return out;
      } catch (err) {
        opsMetrics.db.errors += 1;
        throw err;
      }
    };
  }
}

// ====================================================
// MIDDLEWARE
// ====================================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({
  limit: '12mb',
  verify: (req, res, buf) => {
    if (req.originalUrl === '/api/stripe/webhook') {
      req.rawBody = buf.toString('utf8');
    }
  }
}));
app.use(compression({ threshold: 1024, level: 6 }));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false
}));
app.use(mongoSanitize());
app.use(express.static(path.join(__dirname, 'public')));
trackInterval(cleanupOldMetrics, 60 * 1000);

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const elapsed = Date.now() - started;
    const route = req.route?.path ? `${req.method} ${req.route.path}` : `${req.method} ${req.path}`;
    opsMetrics.http.total += 1;
    if (res.statusCode >= 500) opsMetrics.http.errors5xx += 1;
    opsMetrics.http.latencies.push(elapsed);
    trimMetricArray(opsMetrics.http.latencies, 5000);
    const m = opsMetrics.http.byRoute.get(route) || { count: 0, slow: 0, totalMs: 0, maxMs: 0, status5xx: 0, lastAt: 0 };
    m.count += 1;
    m.totalMs += elapsed;
    m.maxMs = Math.max(m.maxMs, elapsed);
    if (res.statusCode >= 500) m.status5xx += 1;
    if (elapsed >= SLOW_HTTP_MS) {
      m.slow += 1;
      console.warn(`[HTTP-SLOW] ${route} took ${elapsed}ms status=${res.statusCode}`);
    }
    m.lastAt = Date.now();
    opsMetrics.http.byRoute.set(route, m);
  });
  next();
});

const authLimiter = createRateLimiter({
  keyPrefix: 'auth',
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many auth attempts. Please wait and try again.'
});
const unauthenticatedApiLimiter = createRateLimiter({
  keyPrefix: 'api-unauth',
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_UNAUTH_LIMIT || 20),
  message: 'Too many requests'
});
const authenticatedApiLimiter = createRateLimiter({
  keyPrefix: 'api-auth',
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_AUTH_LIMIT || 500),
  keyGenerator: (req) => req._apiRateIdentity || req.session?.userId || req.ip || req.connection?.remoteAddress || 'unknown',
  message: 'API rate limit exceeded. Please slow down.'
});
const backtestLimiter = createRateLimiter({
  keyPrefix: 'api-backtest',
  windowMs: 60 * 1000,
  max: Number(process.env.API_BACKTEST_PER_MIN || 3),
  keyGenerator: (req) => req.session?.userId || req.ip || req.connection?.remoteAddress || 'unknown',
  message: 'Backtest limit: 3 per minute'
});
const heavyJobLimiter = createRateLimiter({
  keyPrefix: 'heavy-jobs',
  windowMs: 60 * 1000,
  max: 6,
  message: 'Too many heavy jobs requested. Please wait before starting another.'
});

function getApiAuthIdentity(req) {
  if (req.session?.userId) return String(req.session.userId);
  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.toLowerCase().startsWith('bearer ')) return '';
  const token = authHeader.slice(7).trim();
  const secret = String(process.env.JWT_SECRET || process.env.SESSION_SECRET || '').trim();
  if (!token || !secret) return '';
  try {
    const payload = jwt.verify(token, secret);
    return String(payload?.userId || payload?.sub || payload?.id || '');
  } catch (_) {
    return '';
  }
}

// Session secret: required in production for secure persistent sessions.
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: SESSION_SECRET environment variable is required in production. Set it and restart.');
    process.exit(1);
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[SECURITY] SESSION_SECRET not set — using random secret. Sessions will reset on restart.');
}

// Session store: use MongoStore only when MONGODB_URI is explicitly set (production).
// In local dev without env var, use MemoryStore to avoid crashes when MongoDB isn't running.
const sessionConfig = {
  secret: sessionSecret,
  resave: false,             // let touchAfter handle lazy updates; reduces per-request DB writes
  saveUninitialized: true,   // save new sessions immediately so CSRF tokens persist
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
};

const hasExplicitMongoURI = !!(process.env.MONGODB_URI || process.env.MONGODB_URI_STANDARD);
if (hasExplicitMongoURI && uri) {
  try {
    sessionConfig.store = MongoStore.create({
      mongoUrl: uri,
      collectionName: 'sessions',
      ttl: 7 * 24 * 60 * 60, // 7 days
      autoRemove: 'native',
      touchAfter: 24 * 3600, // lazy session update
      // NOTE: do NOT use crypto option — if SESSION_SECRET changes (random on restart),
      // old encrypted sessions become unreadable → "Cannot read properties of null ('length')"
      mongoOptions: {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        maxPoolSize: Number(process.env.MONGO_SESSION_POOL_SIZE || 20),
        maxIdleTimeMS: 30000
      }
    });
    sessionConfig.store.on('error', function(err) {
      console.warn('[Session] MongoStore error (non-fatal):', err.message);
    });
  } catch (err) {
    console.warn('[Session] MongoStore creation failed, using MemoryStore:', err.message);
  }
}

if (!sessionConfig.store) {
  console.warn('[Session] Using MemoryStore (sessions lost on restart, no auth features)');
}

const sessionMiddleware = session(sessionConfig);
app.use(sessionMiddleware);
app.use('/api', (req, res, next) => {
  if (req.path === '/ops/metrics') return next();
  const identity = getApiAuthIdentity(req);
  if (identity) {
    req._apiRateIdentity = identity;
    return authenticatedApiLimiter(req, res, next);
  }
  return unauthenticatedApiLimiter(req, res, next);
});

const passport = require('passport');
require('./config/passport');
app.use(passport.initialize());
app.use(passport.session());

// Load user data into res.locals for all templates
app.use(async (req, res, next) => {
  res.locals.currentPath = req.originalUrl || '/';
  res.locals.user = null;
  res.locals.isAdmin = false;
  res.locals.balance = 10000;
  res.locals.totalEquity = 10000;
  res.locals.livePnl = null;
  const wantsHtml = req.method === 'GET' && !req.path.startsWith('/api/') && req.headers.accept?.includes('text/html');
  if (!wantsHtml || !dbConnected || !req.session || !req.session.userId) return next();
  try {
    const uid = String(req.session.userId);
    const cached = userNavSnapshotCache.get(uid);
    if (cached && (Date.now() - cached.at) < USER_NAV_CACHE_TTL_MS) {
      res.locals.user = cached.user;
      res.locals.isAdmin = !!cached.isAdmin;
      res.locals.balance = cached.balance;
      res.locals.totalEquity = cached.totalEquity;
      res.locals.livePnl = cached.livePnl;
      return next();
    }

    const user = await User.findById(req.session.userId).select('username email paperBalance isAdmin subscriptionTier isPartner').lean();
    if (user) {
      res.locals.user = user;
      res.locals.isAdmin = isAdminIdentity(user);
      const cashBalance = user.paperBalance != null ? user.paperBalance : 10000;
      res.locals.balance = cashBalance;
      req.session.username = user.username;
      // Compute total equity = cash + margin locked + unrealized P&L
      try {
        const openTrades = await getOpenTrades(req.session.userId);
        if (openTrades.length > 0) {
          const prices = await fetchAllPrices();
          const priceMap = {};
          prices.forEach(p => { if (p && p.id != null) priceMap[p.id] = Number(p.price); });

          // For non-tracked coins (top 3 market scan), fetch live prices
          // so equity and PnL display correctly in the navbar
          const missingCoinIds = [];
          for (const t of openTrades) {
            if (!priceMap[t.coinId] && t.coinId) {
              if (!TRACKED_COINS.includes(t.coinId) && !getCoinMeta(t.coinId) && t.symbol) {
                registerScannerCoinMeta(t.coinId, t.symbol);
              }
              missingCoinIds.push(t.coinId);
            }
          }
          if (missingCoinIds.length > 0) {
            const uniqueMissing = [...new Set(missingCoinIds)];
            const lps = await Promise.all(uniqueMissing.map(id => fetchLivePrice(id)));
            uniqueMissing.forEach((id, i) => {
              if (lps[i] != null && Number.isFinite(lps[i]) && lps[i] > 0) priceMap[id] = lps[i];
            });
          }

          let totalPnl = 0;
          let totalMargin = 0;
          let count = 0;
          for (const t of openTrades) {
            totalMargin += t.margin || ((t.positionSize || 0) / (t.leverage || 1));
            const cp = priceMap[t.coinId];
            if (cp == null || !t.entryPrice || !t.positionSize) continue;
            const unrealized = t.direction === 'LONG'
              ? ((cp - t.entryPrice) / t.entryPrice) * t.positionSize
              : ((t.entryPrice - cp) / t.entryPrice) * t.positionSize;
            totalPnl += (t.partialPnl || 0) + unrealized;
            count++;
          }
          if (count > 0) res.locals.livePnl = totalPnl;
          res.locals.totalEquity = Math.round((cashBalance + totalMargin + totalPnl) * 100) / 100;
        } else {
          res.locals.totalEquity = cashBalance;
        }
      } catch (e) { res.locals.totalEquity = cashBalance; }
      userNavSnapshotCache.set(uid, {
        at: Date.now(),
        user,
        isAdmin: res.locals.isAdmin,
        balance: res.locals.balance,
        totalEquity: res.locals.totalEquity,
        livePnl: res.locals.livePnl
      });
    } else {
      delete req.session.userId;
      delete req.session.username;
    }
  } catch (err) {
    console.warn('[Auth] User load error (non-fatal):', err.message);
  }
  next();
});

// Lightweight user loader for subscription and usage middleware.
// Only loads the fields actually needed by tier checks and usage limiters.
const _subUserCache = new Map();
const SUB_USER_CACHE_TTL = 10000;
app.use(async (req, res, next) => {
  if (!req.session?.userId || !dbConnected) return next();
  try {
    const uid = String(req.session.userId);
    const cached = _subUserCache.get(uid);
    if (cached && (Date.now() - cached.at) < SUB_USER_CACHE_TTL) {
      req.subscriptionUser = cached.user;
      return next();
    }
    const user = await User.findById(uid)
      .select('subscriptionTier trialEndsAt isPartner trenchWarfareEnabled copilotQuestionsUsed copilotPackQuestions llmMessagesUsed llmPackMessages voiceMinutesUsed voicePackMinutes legal settings.llmAgentEnabled')
      .lean();
    if (user) {
      req.subscriptionUser = user;
      _subUserCache.set(uid, { at: Date.now(), user });
    }
  } catch (err) {
    console.warn('[Subscription] user load failed:', err.message);
  }
  return next();
});

const LEGAL_ACK_VERSION = '2026-03';

app.use((req, res, next) => {
  res.locals.legalAckVersion = LEGAL_ACK_VERSION;
  res.locals.legalAckRequired = false;
  if (req.session?.userId && req.subscriptionUser) {
    const legal = req.subscriptionUser.legal || {};
    const hasCurrentVersion = legal.version === LEGAL_ACK_VERSION;
    const hasCoreAcceptances = !!(legal.riskAcceptedAt && legal.termsAcceptedAt && legal.privacyAcceptedAt);
    res.locals.legalAckRequired = !(hasCurrentVersion && hasCoreAcceptances);
  }
  next();
});

// ====================================================
// SECURITY: Frame protection + CSRF
// ====================================================
app.use((req, res, next) => {
  // Clickjacking protection: prevent embedding in iframes
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// CSRF protection: generate token per session, validate on state-changing requests
function generateCsrfToken(session) {
  if (!session._csrfSecret) {
    session._csrfSecret = crypto.randomBytes(24).toString('hex');
  }
  return session._csrfSecret;
}

function validateCsrfToken(req) {
  const token = req.body._csrf || req.headers['x-csrf-token'] || '';
  const secret = req.session?._csrfSecret || '';
  return secret.length > 0 && token === secret;
}

// CSRF: validate on POST/PUT/DELETE, then generate token for templates.
// Login/register are exempt — no authenticated session to protect.
const CSRF_EXEMPT_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];

app.use((req, res, next) => {
  // Step 1: Validate CSRF on state-changing requests
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const isJsonApi = req.path.startsWith('/api/') || req.xhr || req.headers['content-type']?.includes('application/json');
    const isExempt = CSRF_EXEMPT_PATHS.includes(req.path);
    if (!isJsonApi && !isExempt && !validateCsrfToken(req)) {
      console.warn(`[CSRF] Blocked ${req.method} ${req.path} from ${req.ip}`);
      const referer = req.headers.referer || req.path;
      const sep = referer.includes('?') ? '&' : '?';
      return res.redirect(referer + sep + 'error=Session+expired.+Please+try+again.');
    }
  }

  // Step 2: Generate token for templates (only creates if not already set)
  if (req.session) {
    const hadSecret = !!req.session._csrfSecret;
    res.locals.csrfToken = generateCsrfToken(req.session);
    // If we just created the secret, force save so it persists (fixes MongoStore before first POST)
    if (!hadSecret && req.session._csrfSecret) {
      return req.session.save((err) => {
        if (err) console.warn('[CSRF] Session save:', err?.message);
        next();
      });
    }
  }
  next();
});

// ====================================================
// TEMPLATE HELPERS
// ====================================================
function formatPrice(price) {
  if (price === null || price === undefined) return '0.00';
  if (price >= 1000) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);   // e.g. 1.3677
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(8);
}

function formatBigNumber(num) {
  if (!num) return '0';
  if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  return num.toLocaleString();
}

app.locals.formatPrice = formatPrice;
app.locals.formatBigNumber = formatBigNumber;

// ====================================================
// AUTH ROUTES
// ====================================================
const googleAuthEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

app.get('/login', guestOnly, (req, res) => {
  res.render('login', { activePage: 'login', error: req.query.error || null, success: req.query.success || null, googleAuthEnabled });
});

app.get('/register', guestOnly, async (req, res) => {
  const referralCode = normalizeReferralCode(req.query.ref || '');
  const selectedPlan = normalizeSelectedPlan(req.query.plan || '');
  const betaConfig = await getBetaConfig();
  res.render('register', { activePage: 'register', error: null, googleAuthEnabled, referralCode, selectedPlan, betaEnabled: betaConfig.enabled });
});

if (googleAuthEnabled) {
  app.get('/auth/google', guestOnly, passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login?error=Google+sign-in+failed' }), (req, res) => {
    req.session.userId = req.user._id;
    req.session.username = req.user.username;
    req.session.save((err) => {
      if (err) console.error('[Auth] Session save error:', err.message);
      res.redirect('/');
    });
  });
} else {
  app.get('/auth/google', guestOnly, (req, res) => res.redirect('/login?error=Google+sign-in+not+configured'));
}

app.post('/login', authLimiter, guestOnly, async (req, res) => {
  if (!dbConnected) {
    return res.render('login', { activePage: 'login', error: 'Database not available. Login requires MongoDB.' });
  }
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !(await user.comparePassword(password))) {
      return res.render('login', { activePage: 'login', error: 'Invalid email or password' });
    }
    req.session.userId = user._id;
    req.session.username = user.username;
    // Explicitly save session BEFORE redirect — ensures userId is written to store
    // before the browser follows the 302 and makes a new GET request
    req.session.save((err) => {
      if (err) {
        console.error('[Login] Session save error:', err.message);
        return res.render('login', { activePage: 'login', error: 'Login failed — could not save session. Please try again.' });
      }
      res.redirect('/');
    });
  } catch (err) {
    console.error('[Login] Error:', err.message);
    res.render('login', { activePage: 'login', error: 'Something went wrong. Please try again.' });
  }
});

app.post('/register', authLimiter, guestOnly, async (req, res) => {
  const betaConfig = await getBetaConfig();
  const renderErr = (error, rc, sp) => res.render('register', { activePage: 'register', error, googleAuthEnabled, referralCode: rc || '', selectedPlan: sp || '', betaEnabled: betaConfig.enabled });

  if (!dbConnected) {
    return renderErr('Database not available. Registration requires MongoDB.', '', '');
  }
  try {
    const { username, email, password } = req.body;
    const referralCode = normalizeReferralCode(req.body.referralCode || req.query.ref || '');
    const selectedPlan = normalizeSelectedPlan(req.body.selectedPlan || req.query.plan || '');
    const betaAccessCode = String(req.body.betaAccessCode || '').trim().toUpperCase();

    if (!username || !email || !password) {
      return renderErr('All fields are required', referralCode, selectedPlan);
    }
    if (password.length < 6) {
      return renderErr('Password must be at least 6 characters', referralCode, selectedPlan);
    }

    // Beta gate: require a valid beta access code when closed beta is ON
    let validBetaCode = null;
    if (betaConfig.enabled) {
      if (!betaAccessCode) {
        return renderErr('Beta access code is required during closed beta.', referralCode, selectedPlan);
      }
      validBetaCode = await BetaCode.findOne({ code: betaAccessCode, active: true, usedBy: null });
      if (!validBetaCode) {
        return renderErr('Invalid or already-used beta access code.', referralCode, selectedPlan);
      }
    }

    const existing = await User.findOne({ $or: [{ email: email.toLowerCase().trim() }, { username: username.trim() }] });
    if (existing) {
      return renderErr('Email or username already taken', referralCode, selectedPlan);
    }

    let appliedReferralCode = '';
    if (referralCode) {
      if (!betaConfig.referralsEnabled) {
        return renderErr('Referral codes are not active yet — launching soon!', referralCode, selectedPlan);
      }
      const partner = await Referral.findOne({ referralCode, status: 'active' }).lean();
      if (!partner) {
        return renderErr('Invalid referral code', referralCode, selectedPlan);
      }
      if (String(partner.email || '').toLowerCase() === String(email || '').toLowerCase()) {
        return renderErr('You cannot refer yourself', referralCode, selectedPlan);
      }
      appliedReferralCode = partner.referralCode;
    }

    const clientIp = getClientIpAddress(req);
    const registrationIpHash = hashIpAddress(clientIp);

    // Skip IP-based trial-dupe check for beta users (they get partner, not trial)
    if (!validBetaCode) {
      const ipDuplicateFilters = [];
      if (registrationIpHash) {
        ipDuplicateFilters.push({ registrationIpHash, trialGrantedAt: { $ne: null } });
      }
      if (clientIp && clientIp !== 'unknown') {
        ipDuplicateFilters.push({ 'legal.acceptedIp': clientIp, trialEndsAt: { $ne: null } });
      }
      if (ipDuplicateFilters.length > 0) {
        const existingTrialFromIp = await User.exists({ $or: ipDuplicateFilters });
        if (existingTrialFromIp) {
          return renderErr('A free trial was already claimed from this network. Please log in to your existing account or contact support.', referralCode, selectedPlan);
        }
      }
    }

    // Beta users get partner tier; normal users get trial
    const isBetaSignup = !!validBetaCode;
    const tier = isBetaSignup ? 'partner' : 'trial';
    const user = new User({
      email: email.toLowerCase().trim(),
      username: username.trim(),
      password,
      subscriptionTier: tier,
      isPartner: isBetaSignup,
      trialGrantedAt: isBetaSignup ? null : new Date(),
      registrationIpHash,
      trialEndsAt: isBetaSignup ? null : new Date(Date.now() + (14 * 24 * 60 * 60 * 1000)),
      subscriptionEndsAt: isBetaSignup ? null : new Date(Date.now() + (14 * 24 * 60 * 60 * 1000)),
      referredBy: appliedReferralCode
    });
    await user.save();

    // Mark beta code as used
    if (validBetaCode) {
      validBetaCode.usedBy = user._id;
      validBetaCode.usedByEmail = user.email;
      validBetaCode.usedAt = new Date();
      await validBetaCode.save();
    }

    // Auto-create Referral partner record for beta users
    if (isBetaSignup) {
      const partnerCode = normalizeReferralCode(username) || `BETA${Math.floor(1000 + Math.random() * 9000)}`;
      const existingPartner = await Referral.findOne({ referralCode: partnerCode }).lean();
      if (!existingPartner) {
        await Referral.create({
          name: username.trim(),
          email: email.toLowerCase().trim(),
          referralCode: partnerCode,
          commissionRate: 10,
          status: 'active',
          tier: 'partner'
        });
        user.referralCode = partnerCode;
        await User.updateOne({ _id: user._id }, { $set: { referralCode: partnerCode } });
      }
    }

    req.session.userId = user._id;
    req.session.username = user.username;
    req.session.save((err) => {
      if (err) {
        console.error('[Register] Session save error:', err.message);
        return renderErr('Account created but login failed. Please log in manually.', referralCode, selectedPlan);
      }
      if (selectedPlan) {
        return res.redirect(`/pricing?plan=${encodeURIComponent(selectedPlan)}&autostart=1`);
      }
      return res.redirect('/');
    });
  } catch (err) {
    const referralCode = normalizeReferralCode(req.body?.referralCode || req.query.ref || '');
    const selectedPlan = normalizeSelectedPlan(req.body?.selectedPlan || req.query.plan || '');
    renderErr(err.message || 'Registration failed', referralCode, selectedPlan);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/forgot-password', guestOnly, (req, res) => {
  res.render('forgot-password', { activePage: 'login', error: null, success: null });
});

app.post('/forgot-password', authLimiter, guestOnly, async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    if (!email) return res.render('forgot-password', { activePage: 'login', error: 'Email is required', success: null });
    const user = await User.findOne({ email });
    const crypto = require('crypto');
    const { sendPasswordResetEmail } = require('./services/email');
    const baseUrl = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      user.resetToken = token;
      user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);
      await user.save({ validateBeforeSave: false });
      const resetUrl = `${baseUrl}/reset-password?token=${token}`;
      await sendPasswordResetEmail(user.email, resetUrl);
    }
    res.render('forgot-password', { activePage: 'login', error: null, success: 'If that email exists, we sent a reset link. Check your inbox and spam.' });
  } catch (err) {
    console.error('[ForgotPassword]', err);
    res.render('forgot-password', { activePage: 'login', error: 'Something went wrong. Try again.', success: null });
  }
});

app.get('/reset-password', guestOnly, async (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect('/forgot-password?error=Invalid+link');
  const user = await User.findOne({ resetToken: token, resetTokenExpiry: { $gt: new Date() } });
  if (!user) return res.render('reset-password', { token: '', error: 'Link expired or invalid. Request a new one.', activePage: 'login' });
  res.render('reset-password', { token, error: null, activePage: 'login' });
});

app.post('/reset-password', authLimiter, guestOnly, async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    if (!token) return res.redirect('/forgot-password?error=Invalid+link');
    if (!password || password.length < 6) return res.render('reset-password', { token, error: 'Password must be at least 6 characters', activePage: 'login' });
    if (password !== confirmPassword) return res.render('reset-password', { token, error: 'Passwords do not match', activePage: 'login' });
    const user = await User.findOne({ resetToken: token, resetTokenExpiry: { $gt: new Date() } });
    if (!user) return res.render('reset-password', { token: '', error: 'Link expired or invalid. Request a new one.', activePage: 'login' });
    user.password = password;
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();
    res.redirect('/login?success=Password+reset.+Log+in+with+your+new+password.');
  } catch (err) {
    console.error('[ResetPassword]', err);
    res.render('reset-password', { token: req.body.token, error: 'Something went wrong.', activePage: 'login' });
  }
});

// ====================================================
// PRICING + STRIPE BILLING
// ====================================================
app.get('/pricing', async (req, res) => {
  const user = req.session?.userId ? await User.findById(req.session.userId).lean() : null;
  const selectedPlan = normalizeSelectedPlan(req.query.plan || '');
  const autoStartPlan = req.query.autostart === '1' ? selectedPlan : '';
  res.render('pricing', {
    activePage: 'pricing',
    pageTitle: 'Pricing',
    user,
    selectedPlan,
    autoStartPlan,
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    proPriceId: STRIPE_PRICE_CONFIG.pro,
    elitePriceId: STRIPE_PRICE_CONFIG.elite,
    trenchPriceId: STRIPE_PRICE_CONFIG.trench,
    packPriceConfig: STRIPE_PRICE_CONFIG.packs || {}
  });
});

app.get('/help', async (req, res) => {
  const user = req.session?.userId ? await User.findById(req.session.userId).select('username email subscriptionTier').lean() : null;
  res.render('help', { activePage: 'help', pageTitle: 'Help Center', user });
});

app.get('/faq', async (req, res) => {
  const user = req.session?.userId ? await User.findById(req.session.userId).select('username email subscriptionTier').lean() : null;
  res.render('faq', { activePage: 'faq', pageTitle: 'FAQ', user });
});

app.get('/risk-disclosure', async (req, res) => {
  const user = req.session?.userId ? await User.findById(req.session.userId).select('username email subscriptionTier').lean() : null;
  res.render('risk-disclosure', { activePage: 'risk-disclosure', pageTitle: 'Risk Disclosure', user });
});

app.get('/terms', async (req, res) => {
  const user = req.session?.userId ? await User.findById(req.session.userId).select('username email subscriptionTier').lean() : null;
  res.render('terms', { activePage: 'terms', pageTitle: 'Terms of Service', user });
});

app.get('/privacy', async (req, res) => {
  const user = req.session?.userId ? await User.findById(req.session.userId).select('username email subscriptionTier').lean() : null;
  res.render('privacy', { activePage: 'privacy', pageTitle: 'Privacy Policy', user });
});

// Trench Warfare — admin only
app.get('/trench-upgrade', requireAdmin, (req, res) => res.redirect('/pricing'));

app.get('/success', requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId).lean();
  res.render('billing-success', { activePage: 'pricing', user, pageTitle: 'Payment Success' });
});

app.get('/cancel', requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId).lean();
  res.render('billing-cancel', { activePage: 'pricing', user, pageTitle: 'Checkout Cancelled' });
});

app.post('/api/stripe/create-checkout', requireLogin, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const requestedTier = String(req.body?.tier || '').toLowerCase();
    const normalizedTier = requestedTier === 'elite' ? 'elite' : 'pro';
    const priceId = normalizedTier === 'elite' ? STRIPE_PRICE_CONFIG.elite : STRIPE_PRICE_CONFIG.pro;
    if (!priceId) return res.status(400).json({ error: 'Price ID is not configured' });

    const shouldApplyStripeTrial = user.subscriptionTier === 'free'
      && !user.trialGrantedAt
      && !user.trialEndsAt;
    const subscriptionData = {
      metadata: {
        userId: String(user._id),
        referralCode: user.referredBy || ''
      }
    };
    if (shouldApplyStripeTrial) {
      subscriptionData.trial_period_days = 14;
      subscriptionData.trial_settings = { end_behavior: { missing_payment_method: 'cancel' } };
    }

    const session = await stripe.checkout.sessions.create({
      customer_email: user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      payment_method_collection: 'if_required',
      subscription_data: subscriptionData,
      success_url: `${APP_BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/pricing`,
      metadata: {
        userId: String(user._id),
        referralCode: user.referredBy || '',
        requestedTier: normalizedTier
      }
    });
    return res.json({ url: session.url, id: session.id });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to create checkout session' });
  }
});

// Trench Warfare — admin only
app.post('/api/stripe/add-trench', requireAdmin, (req, res) => res.status(410).json({ error: 'Trench add-on billing disabled' }));

app.post('/api/stripe/buy-pack', requireLogin, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const packType = String(req.body?.packType || '').toLowerCase();
    const packAmount = Number(req.body?.packAmount || 0);
    const priceId = getPackPriceId(packType, packAmount);
    if (!priceId) return res.status(400).json({ error: 'Pack price is not configured' });
    if (!PACK_PRICE_OPTIONS[packType] || !PACK_PRICE_OPTIONS[packType][packAmount]) {
      return res.status(400).json({ error: 'Unsupported pack option' });
    }

    const session = await stripe.checkout.sessions.create({
      customer_email: user.email,
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      payment_intent_data: {
        metadata: {
          userId: String(user._id),
          packType,
          packAmount: String(packAmount)
        }
      },
      metadata: {
        userId: String(user._id),
        packType,
        packAmount: String(packAmount)
      },
      success_url: `${APP_BASE_URL}/pricing?pack=success`,
      cancel_url: `${APP_BASE_URL}/pricing?pack=cancelled`
    });
    return res.json({ url: session.url, id: session.id });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to create pack checkout' });
  }
});

app.get('/api/stripe/billing-portal', requireLogin, async (req, res) => {
  try {
    if (!stripe) return res.status(503).send('Stripe not configured');
    const user = await User.findById(req.session.userId);
    if (!user?.stripeCustomerId) return res.redirect('/pricing?error=no_customer');
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${APP_BASE_URL}/performance`
    });
    return res.redirect(portalSession.url);
  } catch (err) {
    return res.redirect('/pricing?error=' + encodeURIComponent(err.message || 'Portal unavailable'));
  }
});

app.post('/api/stripe/webhook', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    const signature = req.headers['stripe-signature'];
    if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(400).json({ error: 'Webhook signature configuration missing' });
    }
    const event = stripe.webhooks.constructEvent(req.rawBody || '', signature, process.env.STRIPE_WEBHOOK_SECRET);
    await handleStripeEvent(event);
    return res.json({ received: true });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Webhook error' });
  }
});

// ====================================================
// REFERRALS
// ====================================================
app.get('/api/referral/validate', async (req, res) => {
  try {
    const betaConfig = await getBetaConfig();
    if (!betaConfig.referralsEnabled) {
      return res.status(400).json({ valid: false, error: 'Referral codes are not active yet — launching soon!' });
    }
    const code = normalizeReferralCode(req.query.code || '');
    if (!code) return res.status(400).json({ valid: false, error: 'Missing code' });
    const partner = await Referral.findOne({ referralCode: code }).lean();
    if (!partner) return res.status(404).json({ valid: false, error: 'Invalid referral code' });
    if (partner.status === 'paused') return res.status(400).json({ valid: false, error: 'This referral code is not currently active' });
    if (partner.status === 'cancelled') return res.status(400).json({ valid: false, error: 'This referral code has expired' });
    return res.json({ valid: true, code: partner.referralCode, commissionRate: partner.commissionRate });
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

// Build engine options: strategy weights, BTC signal, strategy stats, funding rates, BTC candles
// Optional user: when provided, merges feature toggles (quality filters) for paper/live trades
async function buildEngineOptions(prices, allCandles, allHistory, user) {
  const strategyWeights = await getStrategyWeightsCached();
  const strategyStats = {};
  strategyWeights.forEach(s => {
    strategyStats[s.strategyId] = { totalTrades: s.performance?.totalTrades || 0 };
  });
  let btcSignal = null;
  let btcDirection = null;
  const btcData = prices.find(p => p.id === 'bitcoin');
  const btcCandles = allCandles && allCandles.bitcoin ? allCandles.bitcoin['1h'] || null : null;
  if (btcData) {
    const btcCandlesAll = allCandles && allCandles.bitcoin;
    const btcHistory = allHistory && allHistory.bitcoin || { prices: [], volumes: [] };
    const btcSig = analyzeCoin(btcData, btcCandlesAll, btcHistory, { strategyWeights, strategyStats });
    btcSignal = btcSig.signal;
    // BTC direction for correlation scoring
    if (btcSig.signal === 'STRONG_BUY' || btcSig.signal === 'BUY') btcDirection = 'BULL';
    else if (btcSig.signal === 'STRONG_SELL' || btcSig.signal === 'SELL') btcDirection = 'BEAR';
  }
  // Funding rates for contrarian signal
  const fundingRates = getAllFundingRates();
  const opts = { strategyWeights, strategyStats, btcSignal, btcCandles, btcDirection, fundingRates };
  if (user?.disabledRegimesByCoin && typeof user.disabledRegimesByCoin === 'object') {
    opts.disabledRegimesByCoin = user.disabledRegimesByCoin;
  }
  // User-specific quality filters (for paper/live) - defaults ON for quality
  if (user?.settings) {
    const s = user.settings;
    opts.featurePriceActionConfluence = (s.featurePriceActionConfluence ?? true) === true;
    opts.featureVolatilityFilter = s.featureVolatilityFilter === true;
    opts.featureVolumeConfirmation = (s.featureVolumeConfirmation ?? true) === true;
    opts.featureFundingRateFilter = (s.featureFundingRateFilter ?? true) === true;
    // Theme detector: boost signals for coins in trending sectors (theme-detector skill inspired)
    if (s.featureThemeDetector === true) {
      try {
        const { getHotThemeCoinIds } = require('./services/crypto-themes');
        opts.hotThemeCoinIds = await getHotThemeCoinIds(5);
      } catch (e) { /* ignore */ }
    }
  }
  return opts;
}

// ====================================================
// DASHBOARD (public, enhanced for logged-in users)
// ====================================================
app.get('/', async (req, res) => {
  if (!req.session?.userId) {
    const now = Date.now();
    if (landingPageCache.html && (now - landingPageCache.loadedAt) < LANDING_CACHE_TTL_MS) {
      return res.send(landingPageCache.html);
    }
    return res.render('landing', (err, html) => {
      if (err) return res.status(500).send('Error loading landing page');
      landingPageCache.html = html;
      landingPageCache.loadedAt = now;
      return res.send(html);
    });
  }
  try {
    const [prices, allCandles, allHistory] = await Promise.all([
      fetchAllPrices(),
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory()
    ]);
    const pricesMerged = mergeWebSocketPrices(prices);
    let dashUser = null;
    if (req.session?.userId) {
      try {
        dashUser = await User.findById(req.session.userId).select('excludedCoins settings disabledRegimesByCoin subscriptionTier trialEndsAt copilotQuestionsUsed copilotPackQuestions llmMessagesUsed llmPackMessages voiceMinutesUsed voicePackMinutes').lean();
      } catch (e) { /* ignore */ }
    }
    const options = await buildEngineOptions(pricesMerged, allCandles, allHistory, dashUser);
    const signals = analyzeAllCoins(pricesMerged, allCandles, allHistory, options);

    // Record score history for each coin (for score evolution tracking)
    const regimeCounts = {};
    signals.forEach(sig => {
      if (sig.coin && sig.coin.id) {
        recordScoreHistory(sig.coin.id, {
          score: sig.score,
          signal: sig.signal,
          regime: sig.regime,
          strategyName: sig.strategyName,
          confidence: sig.confidence
        });
        const r = sig.regime || 'unknown';
        regimeCounts[r] = (regimeCounts[r] || 0) + 1;
      }
    });
    if (Object.keys(regimeCounts).length > 0) {
      recordRegimeSnapshot(regimeCounts);
    }

    // Fetch user's excluded coins if logged in
    let excludedCoins = [];
    if (dashUser) {
      excludedCoins = dashUser.excludedCoins || [];
    }

    // For logged-in users: only show non-excluded coins on dashboard (monitoredSignals)
    let monitoredSignals = dashUser
      ? signals.filter(s => !excludedCoins.includes(s.coin?.id))
      : signals;
    // Min R:R filter: hide signals below threshold when enabled (default ON)
    if (dashUser?.settings?.minRiskRewardEnabled !== false) {
      const minRr = Number(dashUser?.settings?.minRiskReward) || 1.5;
      monitoredSignals = monitoredSignals.filter(s => (s.riskReward || 0) >= minRr);
    }

    const topPerformerCoins = getTopPerformerCoinsCached();

    const excludedSignals = dashUser ? signals.filter(s => excludedCoins.includes(s.coin?.id)) : [];
    const excludedCoinsFull = dashUser ? excludedCoins.map(id => {
      const sig = signals.find(s => s.coin?.id === id);
      const meta = COIN_META[id];
      return { id, symbol: sig?.coin?.symbol || meta?.symbol || id, name: sig?.coin?.name || meta?.name || id };
    }) : [];

    let top3MarketPicks = [];
    let marketHoldState = false;
    try {
      const scanner = require('./services/market-scanner');
      top3MarketPicks = scanner.getTop3Cached();
      marketHoldState = scanner.isMarketHoldState();

      // Exclude coins user has open trades on, or recently closed (within cooldown)
      if (dashUser && top3MarketPicks.length > 0) {
        const openTrades = await getOpenTrades(req.session.userId);
        const cooldownHours = dashUser?.settings?.cooldownHours ?? 6;
        const cooldownMs = cooldownHours * 3600 * 1000;
        const recentClosed = await Trade.find({
          userId: req.session.userId,
          status: { $ne: 'OPEN' },
          exitTime: { $gte: new Date(Date.now() - cooldownMs) }
        }).select('coinId').lean();
        const excludeCoinIds = new Set([
          ...openTrades.map(t => t.coinId),
          ...recentClosed.map(t => t.coinId)
        ]);
        top3MarketPicks = top3MarketPicks.filter(p => !excludeCoinIds.has(p.coin?.id));
      }
    } catch (e) { /* ignore */ }

    res.render('dashboard', {
      activePage: 'dashboard',
      prices: pricesMerged,
      signals: monitoredSignals,
      allSignals: signals,
      deleted: req.query.deleted === '1',
      excludedCoins,
      excludedSignals,
      excludedCoinsFull,
      disabledRegimesByCoin: dashUser?.disabledRegimesByCoin || {},
      topPerformerCoins,
      top3MarketPicks,
      marketHoldState,
      trialDaysRemaining: getTrialDaysRemaining(dashUser),
      usage: computeUsageSnapshot(dashUser),
      subscriptionTier: dashUser?.subscriptionTier || 'free',
      errorMsg: req.query.error || null,
      COIN_META
    });
  } catch (err) {
    console.error('[Dashboard] Error:', err);
    res.status(500).send('Error loading dashboard. Try refreshing in a few seconds.');
  }
});

// ====================================================
// COIN DETAIL (tracked 20 + top 3 market-scanner coins)
// ====================================================
app.get('/coin/:coinId', async (req, res) => {
  try {
    const coinId = req.params.coinId;
    const detailUser = req.session?.userId
      ? await User.findById(req.session.userId).select('settings disabledRegimesByCoin').lean()
      : null;
    let coinData, candles, history, prices, allCandles, allHistory;
    let sig;

    if (TRACKED_COINS.includes(coinId)) {
      [prices, allCandles, allHistory] = await Promise.all([
        fetchAllPrices(),
        Promise.resolve(fetchAllCandles()),
        fetchAllHistory()
      ]);
      coinData = prices.find(p => p.id === coinId);
      if (!coinData) return res.redirect('/?error=price_unavailable');
      candles = fetchCandles(coinId);
      history = allHistory[coinId] || { prices: [], volumes: [] };
      const options = await buildEngineOptions(prices, allCandles, allHistory, detailUser);
      sig = analyzeCoin(coinData, candles, history, options);
    } else {
      // For scanner coins: prefer real candles (same as tracked) when available
      let cachedSig = null;
      try {
        const scannerFull = require('./services/market-scanner').getTop3FullCached();
        cachedSig = scannerFull.find(s => (s.coin?.id || s.coinData?.id) === coinId);
      } catch (e) { /* scanner not loaded */ }

      // Register meta so fetchAllCandlesForCoin can resolve Bitget/Kraken symbol
      if (cachedSig && (cachedSig.coin?.symbol || cachedSig.coinData?.symbol)) {
        registerScannerCoinMeta(coinId, cachedSig.coin?.symbol || cachedSig.coinData?.symbol);
      }
      candles = await fetchAllCandlesForCoin(coinId);

      if (candles && candles['1h'] && candles['1h'].length >= 20) {
        // Same treatment as tracked coins: use real OHLCV (Bitget/Kraken)
        const fetched = await fetchCoinDataForDetail(coinId);
        coinData = fetched?.coinData || cachedSig?.coin || cachedSig?.coinData;
        if (!coinData) return res.redirect('/?error=coin_not_found');
        history = fetched?.history || { prices: [], volumes: [] };
        prices = [coinData];
        allCandles = { [coinId]: candles };
        allHistory = { [coinId]: history };
        const options = await buildEngineOptions(prices, allCandles, allHistory, detailUser);
        sig = analyzeCoin(coinData, candles, history, options);
        if (!sig.coin && sig.coinData) sig.coin = sig.coinData;
      } else if (cachedSig) {
        // Fallback: use cached signal (CoinGecko history-based)
        sig = cachedSig;
        if (!sig.coin && sig.coinData) sig.coin = sig.coinData;
      } else {
        // Coin not in cache: fetch fresh (coin may have left top 3)
        const fetched = await fetchCoinDataForDetail(coinId);
        if (!fetched) return res.redirect('/?error=coin_not_found');
        coinData = fetched.coinData;
        history = fetched.history;
        candles = await fetchAllCandlesForCoin(coinId);
        prices = [coinData];
        allCandles = candles ? { [coinId]: candles } : {};
        allHistory = { [coinId]: history };
        const options = await buildEngineOptions(prices, allCandles, allHistory, detailUser);
        sig = analyzeCoin(coinData, candles, history, options);
      }
    }

    res.render('coin-detail', {
      activePage: 'dashboard',
      pageTitle: sig.coin.name,
      sig,
      isScannerCoin: !TRACKED_COINS.includes(coinId),
      validRegimes: REGIME_KEYS,
      disabledRegimesForCoin: detailUser?.disabledRegimesByCoin?.[coinId] || []
    });
  } catch (err) {
    console.error('[CoinDetail] Error:', err);
    res.redirect('/?error=load_failed');
  }
});

// ====================================================
// CHART (TradingView embed; optional trade levels from query)
// ====================================================
app.get('/chart/:coinId', async (req, res) => {
  const coinId = req.params.coinId;
  let meta = getCoinMeta(coinId);
  if (!meta || !meta.bybit) {
    if (!TRACKED_COINS.includes(coinId)) {
      const fetched = await fetchCoinDataForDetail(coinId);
      if (!fetched) return res.status(404).send('Coin not found. <a href="/">Back to Dashboard</a>');
      meta = getCoinMeta(coinId);
    }
    if (!meta || !meta.bybit) return res.status(404).send('Chart not available for this coin. <a href="/">Back to Dashboard</a>');
  }
  // Use Bitget for TradingView symbol with Kraken fallback
  const TV_PAIRS = {
    'BTCUSDT': 'BITGET:BTCUSDT', 'ETHUSDT': 'BITGET:ETHUSDT', 'SOLUSDT': 'BITGET:SOLUSDT',
    'DOGEUSDT': 'BITGET:DOGEUSDT', 'XRPUSDT': 'BITGET:XRPUSDT', 'ADAUSDT': 'BITGET:ADAUSDT',
    'DOTUSDT': 'BITGET:DOTUSDT', 'AVAXUSDT': 'BITGET:AVAXUSDT', 'LINKUSDT': 'BITGET:LINKUSDT',
    'POLUSDT': 'BITGET:POLUSDT', 'BNBUSDT': 'BITGET:BNBUSDT', 'LTCUSDT': 'BITGET:LTCUSDT',
    'UNIUSDT': 'BITGET:UNIUSDT', 'ATOMUSDT': 'BITGET:ATOMUSDT'
  };
  const tvSymbol = TV_PAIRS[meta.bybit] || ('BITGET:' + meta.bybit);
  let entry = req.query.entry ? Number(req.query.entry) : null;
  let sl = req.query.sl ? Number(req.query.sl) : null;
  let tp1 = req.query.tp1 ? Number(req.query.tp1) : null;
  let tp2 = req.query.tp2 ? Number(req.query.tp2) : null;
  let tp3 = req.query.tp3 ? Number(req.query.tp3) : null;
  let setupInfo = null;
  if (req.query.setupId && req.query.setupName) {
    let phases = [];
    try {
      if (req.query.phases) phases = JSON.parse(req.query.phases);
    } catch (e) {}
    setupInfo = { setupId: req.query.setupId, setupName: req.query.setupName, phases };
  }
  let originalSl = null;
  let tradeActions = [];
  let direction = null;
  const tradeId = req.query.tradeId;
  if (tradeId && req.session && req.session.userId) {
    const trade = await Trade.findOne({ _id: tradeId, userId: req.session.userId }).lean();
    if (trade) {
      originalSl = trade.originalStopLoss || trade.stopLoss;
      tradeActions = trade.actions || [];
      direction = trade.direction;
      // Always prefer DB values over URL params for SL/entry — URL params can be stale
      // (e.g. stop was trailed since the trades page was loaded)
      if (trade.stopLoss) sl = trade.stopLoss;
      if (trade.entryPrice) entry = trade.entryPrice;
      // Load TPs from DB (URL params may be absent when navigating directly with only tradeId)
      if (!tp1 && trade.takeProfit1) tp1 = trade.takeProfit1;
      if (!tp2 && trade.takeProfit2) tp2 = trade.takeProfit2;
      if (!tp3 && trade.takeProfit3) tp3 = trade.takeProfit3;
    }
  }
  // Calculate Fibonacci levels for chart overlay
  let chartCandles = fetchCandles(coinId);
  if (!chartCandles && !TRACKED_COINS.includes(coinId)) chartCandles = await fetchAllCandlesForCoin(coinId);
  let fibLevels = null;
  if (chartCandles && chartCandles['4h'] && chartCandles['4h'].length >= 10) {
    const highs = chartCandles['4h'].map(c => c.high);
    const lows = chartCandles['4h'].map(c => c.low);
    const lookback = Math.min(50, highs.length);
    const swingHigh = Math.max(...highs.slice(-lookback));
    const swingLow = Math.min(...lows.slice(-lookback));
    const range = swingHigh - swingLow;
    if (range > 0) {
      fibLevels = {
        fib236: swingHigh - range * 0.236,
        fib382: swingHigh - range * 0.382,
        fib500: swingHigh - range * 0.5,
        fib618: swingHigh - range * 0.618
      };
    }
  }

  const chartCoinsBase = TRACKED_COINS.filter(id => getCoinMeta(id)?.bybit).map(id => ({
    id, symbol: getCoinMeta(id).symbol, name: getCoinMeta(id).name
  }));
  let top3Picks = [];
  try { top3Picks = require('./services/market-scanner').getTop3Cached(); } catch (e) {}
  top3Picks.forEach(p => { if (p.coin?.id && p.coin?.symbol) registerScannerCoinMeta(p.coin.id, p.coin.symbol); });
  const chartCoinsExtra = top3Picks.filter(p => !chartCoinsBase.some(c => c.id === p.coin?.id)).map(p => p.coin ? { id: p.coin.id, symbol: p.coin.symbol, name: p.coin.name } : null).filter(Boolean);
  const chartCoins = [...chartCoinsBase, ...chartCoinsExtra];
  const currentCoinIndex = chartCoins.findIndex(c => c.id === coinId);
  const prevCoinId = currentCoinIndex > 0 ? chartCoins[currentCoinIndex - 1].id : (chartCoins[chartCoins.length - 1]?.id || coinId);
  const nextCoinId = currentCoinIndex >= 0 && currentCoinIndex < chartCoins.length - 1 ? chartCoins[currentCoinIndex + 1].id : (chartCoins[0]?.id || coinId);

  res.render('chart', {
    activePage: 'dashboard',
    pageTitle: meta.name + ' Chart',
    coinId,
    coinName: meta.name,
    symbol: meta.symbol,
    tvSymbol,
    entry,
    sl,
    originalSl,
    tradeActions,
    direction,
    tradeId: tradeId || null,
    tp1,
    tp2,
    tp3,
    fibLevels,
    prevCoinId,
    nextCoinId,
    chartCoins,
    setupInfo: setupInfo || null
  });
});

// ====================================================
// TRADE ROUTES (require login)
// ====================================================
app.get('/trades', requireLogin, async (req, res) => {
  try {
    const [trades, prices, user, adminDiscordConfig] = await Promise.all([
      getOpenTrades(req.session.userId),
      fetchAllPrices(),
      User.findById(req.session.userId).lean(),
      res.locals.isAdmin ? getAdminDiscordConfig() : Promise.resolve(null)
    ]);
    // Fetch live prices for all open-trade coins so PnL is accurate.
    // For non-tracked coins (top 3 market scan), the bulk prices array won't
    // have them, so we register their meta and ADD them to the array.
    let pricesToUse = Array.isArray(prices) ? [...prices] : [];
    if (trades.length > 0) {
      const coinIds = [...new Set(trades.map(t => t.coinId))];
      // Re-register scanner meta for non-tracked coins so fetchLivePrice works
      for (const t of trades) {
        if (!TRACKED_COINS.includes(t.coinId) && !getCoinMeta(t.coinId) && t.symbol) {
          registerScannerCoinMeta(t.coinId, t.symbol);
        }
      }
      const livePrices = await Promise.all(coinIds.map(id => fetchLivePrice(id)));
      for (let i = 0; i < coinIds.length; i++) {
        const cid = coinIds[i];
        const lp = livePrices[i];
        if (lp == null || !Number.isFinite(lp) || lp <= 0) continue;
        const existingIdx = pricesToUse.findIndex(x => x.id === cid);
        if (existingIdx >= 0) {
          pricesToUse[existingIdx] = { ...pricesToUse[existingIdx], price: lp };
        } else {
          // Coin not in tracked prices — add it so trades.ejs can find it
          const trade = trades.find(t => t.coinId === cid);
          pricesToUse.push({ id: cid, symbol: trade?.symbol || cid.toUpperCase(), price: lp });
        }
      }
    }
    res.render('trades', {
      activePage: 'trades',
      trades,
      prices: pricesToUse,
      user,
      adminDiscordConfig,
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    console.error('[Trades] Error:', err);
    res.status(500).send('Error loading trades');
  }
});

app.post('/trades/open', requireLogin, requirePro, async (req, res) => {
  try {
    const { coinId, direction, strategyType } = req.body;
    if (!coinId || !direction) {
      return res.redirect('/trades?error=' + encodeURIComponent('Missing trade data'));
    }

    // Validate direction
    if (!['LONG', 'SHORT'].includes(direction)) {
      return res.redirect('/trades?error=' + encodeURIComponent('Invalid direction'));
    }

    let coinData, allCandles, allHistory, prices;
    if (TRACKED_COINS.includes(coinId)) {
      prices = await fetchAllPrices();
      coinData = prices.find(p => p.id === coinId);
      if (!coinData) return res.redirect('/trades?error=' + encodeURIComponent('Price data not available'));
      [allCandles, allHistory] = await Promise.all([Promise.resolve(fetchAllCandles()), fetchAllHistory()]);
    } else {
      const fetched = await fetchCoinDataForDetail(coinId);
      if (!fetched) return res.redirect('/trades?error=' + encodeURIComponent('Coin not available'));
      coinData = fetched.coinData;
      allHistory = { [coinId]: fetched.history };
      allCandles = { [coinId]: await fetchAllCandlesForCoin(coinId) };
      prices = [coinData];
    }

    const [livePrice, user] = await Promise.all([
      fetchLivePrice(coinId),
      User.findById(req.session.userId).lean()
    ]);
    const options = await buildEngineOptions(prices, allCandles, allHistory, user);
    const candles = allCandles[coinId] || fetchCandles(coinId);
    const history = allHistory[coinId] || { prices: [], volumes: [] };
    const signal = analyzeCoin(coinData, candles, history, options);
    const signalDir = (signal.signal === 'BUY' || signal.signal === 'STRONG_BUY') ? 'LONG'
      : (signal.signal === 'SELL' || signal.signal === 'STRONG_SELL') ? 'SHORT'
      : null;
    const minScoreThreshold = user?.settings?.autoTradeMinScore ?? 55;
    const bestDisplayStrat = (signal.topStrategies || []).find(s =>
      (s.signal === 'BUY' || s.signal === 'STRONG_BUY' || s.signal === 'SELL' || s.signal === 'STRONG_SELL') &&
      (s.score || 0) >= minScoreThreshold
    ) || null;
    const displaySignal = signal.signal === 'HOLD' && bestDisplayStrat ? bestDisplayStrat.signal : signal.signal;
    const displayDir = (displaySignal === 'BUY' || displaySignal === 'STRONG_BUY') ? 'LONG'
      : (displaySignal === 'SELL' || displaySignal === 'STRONG_SELL') ? 'SHORT'
      : null;
    // Scanner/top3 coins use history-based analysis → often lower confluence. Relax to minConf=1.
    const isScannerCoin = !TRACKED_COINS.includes(coinId);
    const minConf = (signal.score || 0) >= 58 ? 1 : (isScannerCoin ? 1 : 2);
    const overallCanTrade = (signal.score || 0) >= minScoreThreshold && (signal.confluenceLevel || 0) >= minConf;
    const confidenceFilterEnabled = user?.settings?.featureConfidenceFilterEnabled === true;
    const minConfidence = Math.max(0, Math.min(100, Number(user?.settings?.minConfidence ?? 60)));
    const signalConfidence = Number(signal?.confidence || 0);

    let selectedStrat = null;
    if (strategyType && signal.topStrategies && Array.isArray(signal.topStrategies)) {
      selectedStrat = signal.topStrategies.find(s => s.id === strategyType) || null;
      if (!selectedStrat) {
        return res.redirect('/trades?error=' + encodeURIComponent('Selected strategy not found'));
      }
      const stratDir = (selectedStrat.signal === 'BUY' || selectedStrat.signal === 'STRONG_BUY') ? 'LONG'
        : (selectedStrat.signal === 'SELL' || selectedStrat.signal === 'STRONG_SELL') ? 'SHORT'
        : null;
      if (!stratDir || stratDir !== direction) {
        return res.redirect('/trades?error=' + encodeURIComponent('Selected strategy does not match trade direction'));
      }
      if ((selectedStrat.score || 0) < minScoreThreshold) {
        return res.redirect('/trades?error=' + encodeURIComponent(`Selected strategy score must be at least ${minScoreThreshold}`));
      }
    } else {
      if (!overallCanTrade) {
        return res.redirect('/trades?error=' + encodeURIComponent(`Main signal requires score >=${minScoreThreshold} and confluence >=${minConf}`));
      }
      if (!displayDir || displayDir !== direction) {
        return res.redirect('/trades?error=' + encodeURIComponent('Trade direction does not match current signal'));
      }
    }
    if (confidenceFilterEnabled && signalConfidence < minConfidence) {
      return res.redirect('/trades?error=' + encodeURIComponent(`Confidence filter: ${signalConfidence.toFixed(0)} < ${minConfidence}`));
    }

    // Always use the canonical signal score (finalScore) — never the strategy-specific displayScore.
    // Strategy scores use different dimension weights and produce different numbers; using them
    // as trade.score creates confusing inconsistencies across the platform.
    const useScore = signal.score || 0;
    const signalLev = signal.suggestedLeverage || suggestLeverage(useScore, signal.regime || 'mixed', 'normal');
    const useFixed = user?.settings?.useFixedLeverage;
    const lev = user?.settings?.disableLeverage ? 1 : (useFixed ? (user?.settings?.defaultLeverage ?? 2) : signalLev);

    // Use live price as entry so trade reflects actual fill, not stale signal
    // If fetchLivePrice failed, do NOT fall back to stale cache - user would open at wrong price
    if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) {
      return res.redirect('/trades?error=' + encodeURIComponent('Live price unavailable. Please try again in a moment.'));
    }
    let entry = livePrice;
    let stopLoss = signal.stopLoss;
    let takeProfit1 = signal.takeProfit1;
    let takeProfit2 = signal.takeProfit2;
    let takeProfit3 = signal.takeProfit3;
    let usedStrategyType = signal.strategyType || 'manual';

    const levelStrat = selectedStrat || ((!strategyType && signal.signal === 'HOLD' && bestDisplayStrat) ? bestDisplayStrat : null);
    if (levelStrat && levelStrat.entry != null && levelStrat.stopLoss != null) {
      // Entry always uses live price; strategy provides SL/TP levels
      stopLoss = levelStrat.stopLoss;
      takeProfit1 = levelStrat.takeProfit1;
      takeProfit2 = levelStrat.takeProfit2;
      takeProfit3 = levelStrat.takeProfit3;
      usedStrategyType = levelStrat.id;
    } else if (!strategyType && signal.signal !== 'HOLD' && signalDir && signalDir !== direction) {
      return res.redirect('/trades?error=' + encodeURIComponent('Signal levels do not match requested direction'));
    }

    // Build strategy performance stats for Kelly criterion sizing
    const allStratWeights = await StrategyWeight.find({ active: true }).lean();
    const strategyStatsForKelly = {};
    allStratWeights.forEach(s => {
      strategyStatsForKelly[s.strategyId] = {
        totalTrades: s.performance.totalTrades || 0,
        winRate: s.performance.winRate || 0,
        avgRR: s.performance.avgRR || 0
      };
    });

    const tradeData = {
      coinId,
      symbol: getCoinMeta(coinId)?.symbol || coinData?.symbol || coinId.toUpperCase(),
      direction,
      entry,
      stopLoss,
      takeProfit1,
      takeProfit2,
      takeProfit3,
      leverage: lev,
      score: useScore,
      strategyType: usedStrategyType,
      regime: signal.regime || 'unknown',
      confidence: signal?.confidence ?? null,
      reasoning: signal.reasoning || [],
      indicators: signal.indicators || {},
      scoreBreakdown: signal.scoreBreakdown || {},
      stopType: signal.stopType || 'ATR_SR_FIB',
      stopLabel: signal.stopLabel || 'ATR + S/R + Fib',
      tpType: signal.tpType || 'R_multiple',
      tpLabel: signal.tpLabel || 'R multiples',
      strategyStats: strategyStatsForKelly,
      volume24h: coinData?.volume24h
    };

    await openTrade(req.session.userId, tradeData);
    res.redirect('/trades?success=' + encodeURIComponent(`Opened ${direction} on ${tradeData.symbol} at $${formatPrice(tradeData.entry)} with ${lev}x leverage`));
  } catch (err) {
    console.error('[OpenTrade] Error:', err);
    res.redirect('/trades?error=' + encodeURIComponent(err.message));
  }
});

app.post('/trades/close/:tradeId', requireLogin, async (req, res) => {
  try {
    const trade = await Trade.findOne({ _id: req.params.tradeId, userId: req.session.userId, status: 'OPEN' });
    if (!trade) {
      return res.redirect('/trades?error=' + encodeURIComponent('Trade not found'));
    }

    // Re-register scanner meta for non-tracked coins so fetchLivePrice can resolve
    if (!TRACKED_COINS.includes(trade.coinId) && !getCoinMeta(trade.coinId) && trade.symbol) {
      registerScannerCoinMeta(trade.coinId, trade.symbol);
    }

    // Use live price when closing so PnL matches reality (not stale cache)
    let currentPrice = await fetchLivePrice(trade.coinId);
    if (currentPrice == null || !Number.isFinite(currentPrice)) {
      const priceData = getCurrentPrice(trade.coinId);
      currentPrice = priceData ? priceData.price : trade.entryPrice;
    }

    const closed = await closeTrade(req.session.userId, trade._id, currentPrice, 'MANUAL');
    res.redirect('/trades?success=' + encodeURIComponent(`Closed ${trade.symbol} at $${Number(currentPrice).toFixed(4)} for ${closed.pnl >= 0 ? '+' : ''}$${closed.pnl.toFixed(2)}`));
  } catch (err) {
    console.error('[CloseTrade] Error:', err);
    res.redirect('/trades?error=' + encodeURIComponent(err.message));
  }
});

// ====================================================
// CRYPTO ALERTS (price alerts — new URL to avoid Safe Browsing flag)
// Old /alerts redirects to new URL (legacy bookmarks)
// ====================================================
app.get('/alerts', requireLogin, (req, res) => res.redirect(301, '/crypto-alerts'));

app.get('/crypto-alerts', requireLogin, async (req, res) => {
  try {
    const alerts = await Alert.find({ userId: req.session.userId }).sort({ createdAt: -1 }).lean();
    res.render('crypto-alerts', { activePage: 'crypto-alerts', alerts, TRACKED_COINS, COIN_META });
  } catch (err) {
    console.error('[CryptoAlerts] Error:', err);
    res.status(500).send('Error loading alerts');
  }
});

app.post('/crypto-alerts', requireLogin, async (req, res) => {
  try {
    const { coinId, condition, price } = req.body;
    if (!coinId || !TRACKED_COINS.includes(coinId) || !condition || !price) {
      return res.redirect('/crypto-alerts?error=' + encodeURIComponent('Invalid alert: coin, condition, and price required'));
    }
    const p = parseFloat(price);
    if (isNaN(p) || p <= 0) return res.redirect('/crypto-alerts?error=' + encodeURIComponent('Invalid price'));
    if (condition !== 'above' && condition !== 'below') return res.redirect('/crypto-alerts?error=' + encodeURIComponent('Condition must be above or below'));
    const meta = COIN_META[coinId];
    await Alert.create({
      userId: req.session.userId,
      coinId,
      symbol: meta?.symbol || coinId.toUpperCase(),
      condition,
      price: p
    });
    res.redirect('/crypto-alerts?success=Alert+created');
  } catch (err) {
    console.error('[CryptoAlerts Create] Error:', err);
    res.redirect('/crypto-alerts?error=' + encodeURIComponent(err.message));
  }
});

app.post('/crypto-alerts/:id/delete', requireLogin, async (req, res) => {
  try {
    await Alert.findOneAndDelete({ _id: req.params.id, userId: req.session.userId });
    res.redirect('/crypto-alerts?success=Alert+deleted');
  } catch (err) {
    console.error('[CryptoAlerts Delete] Error:', err);
    res.redirect('/crypto-alerts?error=' + encodeURIComponent(err.message));
  }
});

// ====================================================
// TRADE HISTORY
// ====================================================
app.get('/history', requireLogin, async (req, res) => {
  try {
    const trades = await getTradeHistory(req.session.userId, 100);
    res.render('history', { activePage: 'history', trades });
  } catch (err) {
    console.error('[History] Error:', err);
    res.status(500).send('Error loading history');
  }
});

// ====================================================
// PERFORMANCE
// ====================================================
app.get('/performance', requireLogin, async (req, res) => {
  try {
    const [stats, user, journalAnalytics] = await Promise.all([
      getPerformanceStats(req.session.userId),
      User.findById(req.session.userId).lean(),
      (async () => {
        const entriesWithTrade = await Journal.find({ userId: req.session.userId, tradeId: { $exists: true, $ne: null } }).lean();
        const tradeIds = [...new Set(entriesWithTrade.map(e => e.tradeId && e.tradeId.toString()).filter(Boolean))];
        const trades = tradeIds.length > 0 ? await Trade.find({ _id: { $in: tradeIds }, userId: req.session.userId }).lean() : [];
        const tradeMap = Object.fromEntries(trades.map(t => [t._id.toString(), t]));
        const byEmotion = {};
        const byRules = { followed: { wins: 0, total: 0 }, broke: { wins: 0, total: 0 } };
        for (const entry of entriesWithTrade) {
          const tid = entry.tradeId && entry.tradeId.toString();
          const trade = tid ? tradeMap[tid] : null;
          if (!trade || trade.pnl == null) continue;
          const isWin = trade.pnl > 0;
          if (entry.emotion) {
            byEmotion[entry.emotion] = byEmotion[entry.emotion] || { wins: 0, total: 0 };
            byEmotion[entry.emotion].total++;
            if (isWin) byEmotion[entry.emotion].wins++;
          }
          if (entry.followedRules !== undefined) {
            const bucket = entry.followedRules ? byRules.followed : byRules.broke;
            bucket.total++;
            if (isWin) bucket.wins++;
          }
        }
        return { byEmotion, byRules };
      })()
    ]);
    const safeStats = stats || {
      balance: 10000, initialBalance: 10000, totalPnl: 0, totalPnlPercent: '0', totalTrades: 0,
      openTrades: 0, wins: 0, losses: 0, winRate: '0', avgWin: 0, avgLoss: 0, profitFactor: '0',
      bestTrade: 0, worstTrade: 0, currentStreak: 0, bestStreak: 0, pnl7d: 0,
      byStrategy: {}, byCoin: {}, equityCurve: [],
      drawdownAnalysis: {}, riskByStrategyRegime: { byStrategy: {}, byRegime: {} }
    };

    // Auto-fix balance if discrepancy detected — no manual action needed
    let balanceAudit = null;
    try {
      const audit = await reconcileBalance(req.session.userId);
      if (audit && Math.abs(audit.discrepancy) >= 1) {
        await fixBalance(req.session.userId);
        // Re-fetch stats with corrected balance
        const freshStats = await getPerformanceStats(req.session.userId);
        Object.assign(safeStats, freshStats || {});
        balanceAudit = { ...audit, autoFixed: true };
      }
    } catch (e) { /* non-critical */ }

    res.render('performance', {
      activePage: 'performance',
      stats: safeStats,
      user: user || {},
      journalAnalytics: journalAnalytics || { byEmotion: {}, byRules: { followed: { wins: 0, total: 0 }, broke: { wins: 0, total: 0 } } },
      balanceAudit,
      useDeepSeek: !!process.env.DEEPSEEK_API_KEY,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (err) {
    console.error('[Performance] Error:', err);
    res.status(500).send('Error loading performance');
  }
});

// ====================================================
// MARKET THEMES (theme-detector skill inspired)
// ====================================================
app.get('/themes', cacheResponse('themes', 30), optionalUser, async (req, res) => {
  try {
    const { getCryptoThemes } = require('./services/crypto-themes');
    const themes = await getCryptoThemes(15);
    res.render('themes', { activePage: 'themes', themes });
  } catch (err) {
    console.error('[Themes] Error:', err);
    res.render('themes', { activePage: 'themes', themes: [] });
  }
});

// ====================================================
// LLM CHAT (interactive chat with full platform context)
// ====================================================
app.get('/llm-chat', requireLogin, (req, res) => {
  res.render('llm-chat', { activePage: 'llm-chat', pageTitle: 'LLM Chat' });
});

app.get('/llm-logs', requireLogin, async (req, res) => {
  try {
    const LlmAgentLog = require('./models/LlmAgentLog');
    const logs = await LlmAgentLog.find({ userId: req.session.userId })
      .sort({ at: -1 })
      .limit(100)
      .lean();
    res.render('llm-logs', { activePage: 'llm-logs', pageTitle: 'LLM Logs', logs });
  } catch (err) {
    console.error('[LLM-Logs] Error:', err);
    res.status(500).send('Error loading logs');
  }
});

// ====================================================
// MARKET PULSE (market-news-analyst skill inspired)
// ====================================================
app.get('/market-pulse', cacheResponse('market-pulse', 15), optionalUser, async (req, res) => {
  try {
    const { getMarketPulse } = require('./services/market-pulse');
    const pulse = await getMarketPulse();
    res.render('market-pulse', { activePage: 'market-pulse', pulse });
  } catch (err) {
    console.error('[MarketPulse] Error:', err);
    res.render('market-pulse', { activePage: 'market-pulse', pulse: null });
  }
});

// ====================================================
// ADVANCED ANALYTICS
// ====================================================
app.get('/analytics', requireLogin, async (req, res) => {
  try {
    const { getPerformanceStats } = require('./services/paper-trading');
    const { computeCorrelationMatrix } = require('./services/analytics');
    const { runMonteCarlo } = require('./services/monte-carlo');

    const [stats, allCandles, closedTrades] = await Promise.all([
      getPerformanceStats(req.session.userId),
      Promise.resolve(fetchAllCandles()),
      Trade.find({ userId: req.session.userId, status: { $ne: 'OPEN' } }).lean()
    ]);

    const correlation = computeCorrelationMatrix(allCandles);
    const regimeTimeline = getRegimeTimeline();

    let monteCarlo = null;
    const initialBalance = (await User.findById(req.session.userId).lean())?.initialBalance || 10000;
    if (closedTrades && closedTrades.length >= 5) {
      monteCarlo = runMonteCarlo(closedTrades, initialBalance, { paths: 500, horizonTrades: 50 });
    }

    const regimeDetails = {};
    if (closedTrades && closedTrades.length > 0) {
      const regimes = ['trending', 'ranging', 'volatile', 'compression', 'mixed'];
      for (const r of regimes) {
        const inRegime = closedTrades.filter(t => (t.regime || 'unknown') === r);
        if (inRegime.length > 0) {
          const wins = inRegime.filter(t => t.pnl > 0).length;
          const byCoin = {};
          inRegime.forEach(t => {
            if (!byCoin[t.symbol]) byCoin[t.symbol] = { trades: 0, pnl: 0, wins: 0 };
            byCoin[t.symbol].trades++;
            byCoin[t.symbol].pnl += t.pnl || 0;
            if (t.pnl > 0) byCoin[t.symbol].wins++;
          });
          regimeDetails[r] = {
            trades: inRegime.length,
            wins,
            winRate: ((wins / inRegime.length) * 100).toFixed(1),
            totalPnl: inRegime.reduce((s, t) => s + (t.pnl || 0), 0),
            byCoin: Object.entries(byCoin).map(([sym, d]) => ({ symbol: sym, ...d })).sort((a, b) => b.pnl - a.pnl)
          };
        }
      }
    }

    res.render('analytics', {
      activePage: 'analytics',
      stats: stats || {},
      correlation,
      regimeTimeline,
      monteCarlo,
      regimeDetails,
      user: await User.findById(req.session.userId).lean()
    });
  } catch (err) {
    console.error('[Analytics] Error:', err);
    res.status(500).send('Error loading analytics');
  }
});

// ====================================================
// ACCOUNT SETTINGS (risk, margin cap, etc.)
// ====================================================
app.post('/account/settings', requireLogin, async (req, res) => {
  try {
    const u = await User.findById(req.session.userId);
    if (!u) return res.redirect('/performance');
    const s = u.settings || {};
    if (req.body.maxBalancePercentPerTrade != null) {
      const v = Math.min(100, Math.max(5, parseInt(req.body.maxBalancePercentPerTrade, 10) || 25));
      s.maxBalancePercentPerTrade = v;
    }
    if (req.body.riskPerTrade != null) {
      const v = Math.min(10, Math.max(0.5, parseFloat(req.body.riskPerTrade) || 2));
      s.riskPerTrade = v;
    }
    if (req.body.riskMode === 'percent' || req.body.riskMode === 'dollar') {
      s.riskMode = req.body.riskMode;
    }
    if (req.body.riskDollarsPerTrade != null) {
      const v = Math.min(10000, Math.max(10, parseInt(req.body.riskDollarsPerTrade, 10) || 200));
      s.riskDollarsPerTrade = v;
    }
    if (req.body.maxOpenTrades != null) {
      const v = Math.min(10, Math.max(1, parseInt(req.body.maxOpenTrades, 10) || 3));
      s.maxOpenTrades = v;
    }
    if (req.body.defaultLeverage != null) {
      const v = Math.min(20, Math.max(1, parseInt(req.body.defaultLeverage, 10) || 1));
      s.defaultLeverage = v;
    }
    if (req.body.cooldownHours != null) {
      const v = Math.min(168, Math.max(0, parseInt(req.body.cooldownHours, 10) ?? 4));
      s.cooldownHours = v;
    }
    if (req.body.autoTrade !== undefined) {
      const val = req.body.autoTrade;
      s.autoTrade = val === 'true' || (Array.isArray(val) && val.includes('true'));
    }
    if (req.body.autoTradeMinScore != null) {
      const v = Math.min(95, Math.max(30, parseInt(req.body.autoTradeMinScore, 10) || 52));
      s.autoTradeMinScore = v;
    }
    if (req.body.autoTradeCoinsMode && ['tracked', 'tracked+top1', 'top1'].includes(req.body.autoTradeCoinsMode)) {
      s.autoTradeCoinsMode = req.body.autoTradeCoinsMode;
    }
    if (req.body.autoTradeSignalMode && ['original', 'setups', 'both'].includes(req.body.autoTradeSignalMode)) {
      s.autoTradeSignalMode = req.body.autoTradeSignalMode;
    }
    if (req.body.autoTradeBothLogic && ['or', 'and'].includes(req.body.autoTradeBothLogic)) {
      s.autoTradeBothLogic = req.body.autoTradeBothLogic;
    }
    if (req.body.autoTradeStrategyConfigId !== undefined) {
      s.autoTradeStrategyConfigId = req.body.autoTradeStrategyConfigId || null;
    }
    if (req.body.autoTradeSetupIds !== undefined) {
      s.autoTradeSetupIds = Array.isArray(req.body.autoTradeSetupIds) ? req.body.autoTradeSetupIds : [];
    }
    if (req.body.autoTradeUseSetups !== undefined) {
      const val = req.body.autoTradeUseSetups;
      s.autoTradeUseSetups = val === 'true' || (Array.isArray(val) && val.includes('true'));
    }
    if (req.body.llmEnabled !== undefined) {
      const val = req.body.llmEnabled;
      s.llmEnabled = val === 'true' || (Array.isArray(val) && val.includes('true'));
    }
    if (req.body.ollamaUrl != null && typeof req.body.ollamaUrl === 'string') {
      const url = req.body.ollamaUrl.trim();
      s.ollamaUrl = url || 'http://localhost:11434';
    }
    if (req.body.ollamaModel != null && typeof req.body.ollamaModel === 'string') {
      s.ollamaModel = req.body.ollamaModel.trim() || 'llama3.1:8b';
    }
    if (req.body.ollamaApiKey != null && typeof req.body.ollamaApiKey === 'string') {
      s.ollamaApiKey = req.body.ollamaApiKey.trim();
    }
    if (req.body.llmAgentEnabled !== undefined) {
      const val = req.body.llmAgentEnabled;
      s.llmAgentEnabled = val === 'true' || (Array.isArray(val) && val.includes('true'));
    }
    if (req.body.llmAgentIntervalMinutes != null) {
      const v = Math.min(1440, Math.max(5, parseInt(req.body.llmAgentIntervalMinutes, 10) || 15));
      s.llmAgentIntervalMinutes = v;
    }
    if (req.body.useFixedLeverage !== undefined) {
      const val = req.body.useFixedLeverage;
      s.useFixedLeverage = val === 'true' || (Array.isArray(val) && val.includes('true'));
    }
    if (req.body.disableLeverage !== undefined) {
      const val = req.body.disableLeverage;
      s.disableLeverage = val === 'true' || (Array.isArray(val) && val.includes('true'));
    }
    if (req.body.autoExecuteActions !== undefined) {
      const val = req.body.autoExecuteActions;
      s.autoExecuteActions = val === 'true' || (Array.isArray(val) && val.includes('true'));
    }
    if (req.body.autoMoveBreakeven !== undefined) {
      const val = req.body.autoMoveBreakeven;
      s.autoMoveBreakeven = val === 'true' || (Array.isArray(val) && val.includes('true'));
    }
    if (req.body.autoTrailingStop !== undefined) {
      const val = req.body.autoTrailingStop;
      s.autoTrailingStop = val === 'true' || (Array.isArray(val) && val.includes('true'));
    }
    if (req.body.paperLiveSync !== undefined) {
      const val = req.body.paperLiveSync;
      s.paperLiveSync = val === 'true' || (Array.isArray(val) && val.includes('true'));
    }
    if (req.body.scoreCheckGraceMinutes != null) {
      s.scoreCheckGraceMinutes = Math.min(60, Math.max(0, parseInt(req.body.scoreCheckGraceMinutes, 10) ?? 10));
    }
    if (req.body.stopCheckGraceMinutes != null) {
      s.stopCheckGraceMinutes = Math.min(30, Math.max(0, parseInt(req.body.stopCheckGraceMinutes, 10) ?? 2));
    }
    if (req.body.notifyTradeOpen !== undefined) {
      s.notifyTradeOpen = req.body.notifyTradeOpen === 'true' || (Array.isArray(req.body.notifyTradeOpen) && req.body.notifyTradeOpen.includes('true'));
    }
    if (req.body.notifyTradeClose !== undefined) {
      s.notifyTradeClose = req.body.notifyTradeClose === 'true' || (Array.isArray(req.body.notifyTradeClose) && req.body.notifyTradeClose.includes('true'));
    }
    if (req.body.notifyActionBadges !== undefined) {
      s.notifyActionBadges = req.body.notifyActionBadges === 'true' || (Array.isArray(req.body.notifyActionBadges) && req.body.notifyActionBadges.includes('true'));
    }
    if (req.body.phoneSmsEmail !== undefined) {
      u.phoneSmsEmail = (req.body.phoneSmsEmail || '').trim().toLowerCase();
    }
    if (req.body.makerFeePercent != null) {
      const v = parseFloat(req.body.makerFeePercent);
      s.makerFeePercent = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.1;
    }
    if (req.body.takerFeePercent != null) {
      const v = parseFloat(req.body.takerFeePercent);
      s.takerFeePercent = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.1;
    }
    u.settings = s;
    await u.save();
    res.redirect('/performance?success=Settings+saved');
  } catch (err) {
    res.redirect('/performance?error=' + encodeURIComponent(err.message || 'Failed to save'));
  }
});

// ====================================================
// FEATURE TOGGLES (separate form on performance page)
// ====================================================
app.post('/account/feature-toggles', requireLogin, async (req, res) => {
  try {
    const u = await User.findById(req.session.userId);
    if (!u) return res.redirect('/performance');
    const s = u.settings || {};
    const parseBool = (val) => val === 'true' || (Array.isArray(val) && val.includes('true'));

    // Feature toggle fields — unchecked checkboxes don't submit, so default to false
    s.featureBtcFilter = req.body.featureBtcFilter ? parseBool(req.body.featureBtcFilter) : false;
    s.featureBtcCorrelation = req.body.featureBtcCorrelation ? parseBool(req.body.featureBtcCorrelation) : false;
    s.featureSessionFilter = req.body.featureSessionFilter ? parseBool(req.body.featureSessionFilter) : false;
    s.featurePartialTP = req.body.featurePartialTP ? parseBool(req.body.featurePartialTP) : false;
    s.featureLockIn = req.body.featureLockIn ? parseBool(req.body.featureLockIn) : false;
    s.featureScoreRecheck = req.body.featureScoreRecheck ? parseBool(req.body.featureScoreRecheck) : false;
    s.featureSlCap = req.body.featureSlCap ? parseBool(req.body.featureSlCap) : false;
    s.featureMinSlDistance = req.body.featureMinSlDistance ? parseBool(req.body.featureMinSlDistance) : false;
    s.featureConfidenceSizing = req.body.featureConfidenceSizing ? parseBool(req.body.featureConfidenceSizing) : false;
    s.featureConfidenceFilterEnabled = req.body.featureConfidenceFilterEnabled ? parseBool(req.body.featureConfidenceFilterEnabled) : false;
    const minConf = parseFloat(req.body.minConfidence);
    s.minConfidence = !isNaN(minConf) && minConf >= 0 && minConf <= 100 ? minConf : 60;
    s.featureKellySizing = req.body.featureKellySizing ? parseBool(req.body.featureKellySizing) : false;
    s.featureThemeDetector = req.body.featureThemeDetector ? parseBool(req.body.featureThemeDetector) : false;
    s.featurePriceActionConfluence = req.body.featurePriceActionConfluence ? parseBool(req.body.featurePriceActionConfluence) : false;
    s.featureVolatilityFilter = req.body.featureVolatilityFilter ? parseBool(req.body.featureVolatilityFilter) : false;
    s.featureVolumeConfirmation = req.body.featureVolumeConfirmation ? parseBool(req.body.featureVolumeConfirmation) : false;
    s.featureFundingRateFilter = req.body.featureFundingRateFilter ? parseBool(req.body.featureFundingRateFilter) : false;
    s.minRiskRewardEnabled = req.body.minRiskRewardEnabled ? parseBool(req.body.minRiskRewardEnabled) : false;
    const minRr = parseFloat(req.body.minRiskReward);
    s.minRiskReward = !isNaN(minRr) && minRr >= 1 && minRr <= 5 ? minRr : 1.5;

    // BE and TS are shared with existing settings
    if (req.body.autoMoveBreakeven !== undefined) {
      s.autoMoveBreakeven = parseBool(req.body.autoMoveBreakeven);
    } else {
      s.autoMoveBreakeven = false;
    }
    if (req.body.autoTrailingStop !== undefined) {
      s.autoTrailingStop = parseBool(req.body.autoTrailingStop);
    } else {
      s.autoTrailingStop = false;
    }

    // TP Mode: fixed or trailing
    s.tpMode = req.body.tpMode === 'trailing' ? 'trailing' : 'fixed';
    s.trailingTpDistanceMode = req.body.trailingTpDistanceMode === 'fixed' ? 'fixed' : 'atr';
    const atrMult = parseFloat(req.body.trailingTpAtrMultiplier);
    s.trailingTpAtrMultiplier = !isNaN(atrMult) && atrMult >= 0.5 && atrMult <= 5 ? atrMult : 1.5;
    const fixedPct = parseFloat(req.body.trailingTpFixedPercent);
    s.trailingTpFixedPercent = !isNaN(fixedPct) && fixedPct >= 0.5 && fixedPct <= 10 ? fixedPct : 2;

    // DCA settings
    s.dcaEnabled = req.body.dcaEnabled ? parseBool(req.body.dcaEnabled) : false;
    const maxAdds = parseInt(req.body.dcaMaxAdds, 10);
    s.dcaMaxAdds = !isNaN(maxAdds) && maxAdds >= 1 && maxAdds <= 10 ? maxAdds : 3;
    const dipPct = parseFloat(req.body.dcaDipPercent);
    s.dcaDipPercent = !isNaN(dipPct) && dipPct >= 0.5 && dipPct <= 20 ? dipPct : 2;
    const addSizePct = parseFloat(req.body.dcaAddSizePercent);
    s.dcaAddSizePercent = !isNaN(addSizePct) && addSizePct >= 25 && addSizePct <= 200 ? addSizePct : 100;
    const dcaMinScr = parseInt(req.body.dcaMinScore, 10);
    s.dcaMinScore = !isNaN(dcaMinScr) && dcaMinScr >= 30 && dcaMinScr <= 95 ? dcaMinScr : 52;

    // Stop management distances
    const beRMult = parseFloat(req.body.breakevenRMult);
    s.breakevenRMult = !isNaN(beRMult) && beRMult >= 0.25 && beRMult <= 3 ? beRMult : 0.75;
    const trailStart = parseFloat(req.body.trailingStartR);
    s.trailingStartR = !isNaN(trailStart) && trailStart >= 0.5 && trailStart <= 5 ? trailStart : 1.5;
    const trailDist = parseFloat(req.body.trailingDistR);
    s.trailingDistR = !isNaN(trailDist) && trailDist >= 0.5 && trailDist <= 5 ? trailDist : 2.0;

    // Risk controls (defaults: max daily 5%, drawdown sizing ON)
    const maxDaily = parseFloat(req.body.maxDailyLossPercent);
    s.maxDailyLossPercent = !isNaN(maxDaily) && maxDaily >= 0 && maxDaily <= 20 ? maxDaily : 5;
    s.drawdownSizingEnabled = req.body.drawdownSizingEnabled ? parseBool(req.body.drawdownSizingEnabled) : false;
    const ddThresh = parseFloat(req.body.drawdownThresholdPercent);
    s.drawdownThresholdPercent = !isNaN(ddThresh) && ddThresh >= 5 && ddThresh <= 50 ? ddThresh : 10;
    const minVol = parseFloat(req.body.minVolume24hUsd);
    s.minVolume24hUsd = !isNaN(minVol) && minVol >= 0 ? minVol : 0;
    s.correlationFilterEnabled = req.body.correlationFilterEnabled ? parseBool(req.body.correlationFilterEnabled) : false;
    s.expectancyFilterEnabled = req.body.expectancyFilterEnabled ? parseBool(req.body.expectancyFilterEnabled) : false;
    const minExp = parseFloat(req.body.minExpectancy);
    s.minExpectancy = !isNaN(minExp) && minExp >= -1 && minExp <= 2 ? minExp : 0.15;

    // Entry gates moved into Feature Toggles panel
    const minScore = parseInt(req.body.autoTradeMinScore, 10);
    s.autoTradeMinScore = !isNaN(minScore) && minScore >= 30 && minScore <= 95 ? minScore : 56;
    const cooldownHrs = parseFloat(req.body.cooldownHours);
    s.cooldownHours = !isNaN(cooldownHrs) && cooldownHrs >= 0 && cooldownHrs <= 168 ? cooldownHrs : 6;

    u.settings = s;
    u.markModified('settings');
    await u.save();
    res.redirect('/performance?success=Feature+toggles+saved');
  } catch (err) {
    res.redirect('/performance?error=' + encodeURIComponent(err.message || 'Failed to save toggles'));
  }
});

// ====================================================
// COIN WEIGHT SETTINGS (enable + strength)
// ====================================================
app.post('/account/coin-weight-settings', requireLogin, async (req, res) => {
  try {
    const u = await User.findById(req.session.userId);
    if (!u) return res.redirect('/performance');
    const parseBool = (val) => val === 'true' || (Array.isArray(val) && val.includes('true'));
    u.coinWeightEnabled = req.body.coinWeightEnabled ? parseBool(req.body.coinWeightEnabled) : false;
    const strength = req.body.coinWeightStrength;
    if (['conservative', 'moderate', 'aggressive'].includes(strength)) {
      u.coinWeightStrength = strength;
    }
    await u.save();
    res.redirect('/performance?success=Coin+weight+settings+saved');
  } catch (err) {
    res.redirect('/performance?error=' + encodeURIComponent(err.message || 'Failed to save'));
  }
});

app.post('/account/legal-acknowledge', requireLogin, async (req, res) => {
  try {
    const u = await User.findById(req.session.userId);
    if (!u) return res.redirect('/login');
    if (!u.legal) u.legal = {};
    const now = new Date();
    u.legal.version = LEGAL_ACK_VERSION;
    u.legal.riskAcceptedAt = now;
    u.legal.termsAcceptedAt = now;
    u.legal.privacyAcceptedAt = now;
    u.legal.acceptedIp = req.ip || '';
    u.legal.acceptedUserAgent = (req.headers['user-agent'] || '').slice(0, 512);
    u.markModified('legal');
    await u.save();
    const nextUrl = (typeof req.body.next === 'string' && req.body.next.startsWith('/')) ? req.body.next : '/performance';
    res.redirect(nextUrl + (nextUrl.includes('?') ? '&' : '?') + 'success=Risk+acknowledged');
  } catch (err) {
    const nextUrl = (typeof req.body.next === 'string' && req.body.next.startsWith('/')) ? req.body.next : '/performance';
    res.redirect(nextUrl + (nextUrl.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(err.message || 'Failed to save acknowledgement'));
  }
});

// ====================================================
// TOGGLE COIN EXCLUSION (auto-trade skip list)
// ====================================================
app.post('/api/toggle-coin', requireLogin, async (req, res) => {
  try {
    const { coinId, excluded } = req.body;
    if (!coinId) return res.status(400).json({ success: false, error: 'Missing coinId' });
    const u = await User.findById(req.session.userId);
    if (!u) return res.status(404).json({ success: false, error: 'User not found' });

    if (!u.excludedCoins) u.excludedCoins = [];

    if (excluded) {
      // Add to excluded list
      if (!u.excludedCoins.includes(coinId)) {
        u.excludedCoins.push(coinId);
      }
    } else {
      // Remove from excluded list
      u.excludedCoins = u.excludedCoins.filter(c => c !== coinId);
    }

    await u.save();
    res.json({ success: true, excludedCoins: u.excludedCoins });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// COIN REGIME TOGGLES (disable specific regimes per coin)
// ====================================================
app.get('/api/coin/:coinId/regime-settings', requireLogin, async (req, res) => {
  try {
    const coinId = req.params.coinId;
    const u = await User.findById(req.session.userId).select('disabledRegimesByCoin').lean();
    if (!u) return res.status(404).json({ success: false, error: 'User not found' });
    const disabled = Array.isArray(u.disabledRegimesByCoin?.[coinId]) ? u.disabledRegimesByCoin[coinId] : [];
    res.json({ success: true, coinId, validRegimes: REGIME_KEYS, disabledRegimes: disabled });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/coin/:coinId/regime-settings', requireLogin, async (req, res) => {
  try {
    const coinId = req.params.coinId;
    const requested = Array.isArray(req.body?.disabledRegimes) ? req.body.disabledRegimes : [];
    const disabledRegimes = requested
      .map(r => String(r || '').toLowerCase())
      .filter(r => REGIME_KEYS.includes(r));
    const u = await User.findById(req.session.userId);
    if (!u) return res.status(404).json({ success: false, error: 'User not found' });
    if (!u.disabledRegimesByCoin || typeof u.disabledRegimesByCoin !== 'object') u.disabledRegimesByCoin = {};
    u.disabledRegimesByCoin[coinId] = Array.from(new Set(disabledRegimes));
    u.markModified('disabledRegimesByCoin');
    await u.save();
    res.json({ success: true, coinId, disabledRegimes: u.disabledRegimesByCoin[coinId] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/coin/:coinId/regime-suggestions', requireLogin, async (req, res) => {
  try {
    const coinId = req.params.coinId;
    const u = await User.findById(req.session.userId).select('disabledRegimesByCoin').lean();
    if (!u) return res.status(404).json({ success: false, error: 'User not found' });

    const regimeStats = await Trade.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(req.session.userId), coinId, status: { $ne: 'OPEN' }, regime: { $in: REGIME_KEYS } } },
      { $group: {
        _id: '$regime',
        trades: { $sum: 1 },
        wins: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } },
        pnl: { $sum: '$pnl' }
      } }
    ]);

    const byRegime = {};
    for (const r of REGIME_KEYS) byRegime[r] = { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0 };
    for (const row of regimeStats) {
      const trades = Number(row.trades || 0);
      const wins = Number(row.wins || 0);
      const pnl = Number(row.pnl || 0);
      const losses = Math.max(0, trades - wins);
      byRegime[row._id] = {
        trades,
        wins,
        losses,
        pnl,
        winRate: trades > 0 ? (wins / trades) * 100 : 0
      };
    }

    const suggestedDisable = [];
    const suggestedKeep = [];
    for (const r of REGIME_KEYS) {
      const s = byRegime[r];
      if (s.trades >= 6 && s.winRate < 45 && s.pnl < 0) suggestedDisable.push(r);
      else if (s.trades >= 6 && s.winRate >= 55 && s.pnl >= 0) suggestedKeep.push(r);
    }

    res.json({
      success: true,
      coinId,
      byRegime,
      suggestedDisable,
      suggestedKeep,
      disabledRegimes: Array.isArray(u.disabledRegimesByCoin?.[coinId]) ? u.disabledRegimesByCoin[coinId] : [],
      note: 'Suggestions are heuristic from your closed trades for this coin (>=6 trades/regime).'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// COIN WEIGHTS (from backtest - prioritizes better-performing coins in auto-trade)
// ====================================================
const fs = require('fs');
const SYMBOL_TO_COIN_ID = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', DOGE: 'dogecoin', XRP: 'ripple',
  ADA: 'cardano', DOT: 'polkadot', AVAX: 'avalanche-2', LINK: 'chainlink', POL: 'polygon',
  BNB: 'binancecoin', LTC: 'litecoin', UNI: 'uniswap', ATOM: 'cosmos'
};

app.post('/api/coin-weights', requireLogin, async (req, res) => {
  try {
    const { coinWeights } = req.body || {};
    const u = await User.findById(req.session.userId);
    if (!u) return res.status(404).json({ success: false, error: 'User not found' });
    if (coinWeights && typeof coinWeights === 'object') {
      u.coinWeights = coinWeights;
      await u.save();
    }
    res.json({ success: true, coinWeights: u.coinWeights || {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/load-coin-weights-from-backtest', requireLogin, async (req, res) => {
  try {
    const resultsDir = path.join(__dirname, 'data/backtest-results');
    if (!fs.existsSync(resultsDir)) {
      return res.status(404).json({ success: false, error: 'No backtest results. Run backtest-massive.js first.' });
    }
    const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('massive-') && f.endsWith('.json'));
    if (files.length === 0) {
      return res.status(404).json({ success: false, error: 'No massive backtest results found.' });
    }
    const latest = files.sort().reverse()[0];
    const data = JSON.parse(fs.readFileSync(path.join(resultsDir, latest), 'utf8'));
    const allCoins = data.allCoins || data.top10 || [];
    if (allCoins.length === 0) {
      return res.status(400).json({ success: false, error: 'No coin data in backtest results.' });
    }
    // Build weights: top 5 get 1.2x, next 5 get 1.1x, rest 1.0, bottom 3 get 0.8x
    const weights = {};
    allCoins.forEach((c, i) => {
      const coinId = SYMBOL_TO_COIN_ID[c.symbol] || Object.keys(COIN_META).find(k => COIN_META[k]?.symbol === c.symbol) || c.coinId;
      if (!coinId) return;
      if (i < 5) weights[coinId] = 1.2;
      else if (i < 10) weights[coinId] = 1.1;
      else if (i >= allCoins.length - 3) weights[coinId] = 0.8;
      else weights[coinId] = 1.0;
    });
    const u = await User.findById(req.session.userId);
    if (!u) return res.status(404).json({ success: false, error: 'User not found' });
    u.coinWeights = weights;
    u.coinWeightEnabled = true;
    await u.save();
    res.json({ success: true, coinWeights: weights, message: `Loaded weights from ${latest}. Coin weights enabled.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// SYNC PAPER BALANCE FROM BITGET
// ====================================================
app.post('/account/sync-balance-from-bitget', requireLogin, async (req, res) => {
  try {
    const u = await User.findById(req.session.userId);
    if (!u || !u.bitget || !u.bitget.connected) {
      return res.redirect('/performance?error=' + encodeURIComponent('Connect Bitget first'));
    }
    const result = await bitget.getAccountBalance(u);
    if (!result.success || !result.balances) {
      return res.redirect('/performance?error=' + encodeURIComponent(result.error || 'Failed to fetch Bitget balance'));
    }
    const tradingType = u.liveTrading?.tradingType || 'futures';
    let balance = 0;
    if (tradingType === 'spot' && result.balances.spot) {
      balance = result.balances.spot.available || 0;
    } else if (result.balances.futures) {
      balance = result.balances.futures.available ?? result.balances.futures.equity ?? 0;
    } else if (result.balances.spot) {
      balance = result.balances.spot.available || 0;
    }
    if (balance <= 0) {
      return res.redirect('/performance?error=' + encodeURIComponent('Bitget balance is zero or unavailable'));
    }
    u.paperBalance = Math.round(balance * 100) / 100;
    u.initialBalance = u.paperBalance;
    await u.save();
    res.redirect('/performance?success=' + encodeURIComponent(`Paper balance synced from Bitget: $${u.paperBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}`));
  } catch (err) {
    console.error('[SyncBalance] Error:', err.message);
    res.redirect('/performance?error=' + encodeURIComponent(err.message || 'Sync failed'));
  }
});

// ====================================================
// SET PAPER BALANCE
// ====================================================
app.post('/account/set-balance', requireLogin, async (req, res) => {
  try {
    const u = await User.findById(req.session.userId);
    if (!u) return res.redirect('/performance');
    const newBalance = parseFloat(req.body.paperBalance);
    if (!Number.isFinite(newBalance) || newBalance < 100 || newBalance > 1000000) {
      return res.redirect('/performance?error=' + encodeURIComponent('Balance must be between $100 and $1,000,000'));
    }
    u.paperBalance = newBalance;
    u.initialBalance = newBalance;
    await u.save();
    res.redirect('/performance');
  } catch (err) {
    console.error('[SetBalance] Error:', err.message);
    res.redirect('/performance');
  }
});

// ====================================================
// BALANCE RECONCILIATION — audit & fix corrupted balance
// ====================================================
app.get('/account/reconcile', requireLogin, async (req, res) => {
  try {
    const result = await reconcileBalance(req.session.userId);
    res.json(result);
  } catch (err) {
    console.error('[Reconcile] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/account/reconcile', requireLogin, async (req, res) => {
  try {
    const result = await fixBalance(req.session.userId);
    if (result.fixed) {
      res.redirect('/performance?success=' + encodeURIComponent(`Balance reconciled: $${result.currentBalance.toFixed(2)} → $${result.newBalance.toFixed(2)} (recovered $${Math.abs(result.discrepancy).toFixed(2)})`));
    } else {
      res.redirect('/performance?success=' + encodeURIComponent('Balance is already correct — no adjustment needed'));
    }
  } catch (err) {
    console.error('[Reconcile] Error:', err.message);
    res.redirect('/performance?error=' + encodeURIComponent('Reconciliation failed: ' + err.message));
  }
});

// ====================================================
// ACCOUNT RESET
// ====================================================
app.post('/account/reset', requireLogin, async (req, res) => {
  try {
    if (req.body.confirm !== 'RESET') {
      return res.redirect('/performance?error=' + encodeURIComponent('Reset not confirmed'));
    }
    await resetAccount(req.session.userId);
    res.redirect('/performance');
  } catch (err) {
    res.redirect('/performance');
  }
});

// ====================================================
// FULL PLATFORM RESET (keeps accounts, wipes everything else)
// ====================================================
app.post('/account/full-platform-reset', requireLogin, async (req, res) => {
  try {
    if (req.body.confirm !== 'RESET PLATFORM') {
      return res.redirect('/performance?error=' + encodeURIComponent('Type RESET PLATFORM to confirm'));
    }
    await Trade.deleteMany({});
    await Journal.deleteMany({});
    const users = await User.find({});
    for (const u of users) {
      u.paperBalance = 10000;
      u.initialBalance = 10000;
      u.stats = {
        totalTrades: 0, wins: 0, losses: 0, totalPnl: 0,
        bestTrade: 0, worstTrade: 0, currentStreak: 0, bestStreak: 0
      };
      await u.save();
    }
    await resetStrategyWeights();
    console.log('[FullReset] Platform reset complete: trades, journals, user stats, learning engine');
    res.redirect('/performance?success=' + encodeURIComponent('Full platform reset complete. Accounts kept.'));
  } catch (err) {
    console.error('[FullReset] Error:', err);
    res.redirect('/performance?error=' + encodeURIComponent(err.message || 'Reset failed'));
  }
});

// ====================================================
// ACCOUNT DELETION
// ====================================================
app.post('/account/delete', requireLogin, async (req, res) => {
  try {
    if (req.body.confirm !== 'DELETE') {
      return res.redirect('/performance?error=' + encodeURIComponent('Type DELETE to confirm'));
    }
    const userId = req.session.userId;
    await Trade.deleteMany({ userId });
    await Journal.deleteMany({ userId });
    const user = await User.findByIdAndDelete(userId);
    if (!user) return res.redirect('/performance');
    req.session.destroy(() => res.redirect('/?deleted=1'));
  } catch (err) {
    console.error('[AccountDelete]', err);
    res.redirect('/performance?error=' + encodeURIComponent(err.message || 'Failed to delete'));
  }
});

// ====================================================
// EXCHANGE (Bitget Integration)
// ====================================================
app.get('/exchange', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.redirect('/login');
    res.render('exchange', {
      activePage: 'exchange',
      user,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (err) {
    console.error('[Exchange] Error:', err);
    res.status(500).send('Error loading exchange page');
  }
});

app.post('/exchange/connect', requireLogin, async (req, res) => {
  try {
    const { apiKey, secretKey, passphrase } = req.body;
    if (!apiKey || !secretKey || !passphrase) {
      return res.redirect('/exchange?error=' + encodeURIComponent('All three fields are required: API Key, Secret Key, and Passphrase'));
    }
    if (apiKey.startsWith('••')) {
      return res.redirect('/exchange?error=' + encodeURIComponent('Please enter your full API key, not the masked value'));
    }

    const user = await User.findById(req.session.userId);
    if (!user) return res.redirect('/login');

    user.bitget = {
      apiKey,
      secretKey,
      passphrase,
      connected: false,
      lastVerified: null
    };

    const testResult = await bitget.testConnection(user);
    if (testResult.success) {
      user.bitget.connected = true;
      user.bitget.lastVerified = new Date();
      await user.save();
      res.redirect('/exchange?success=' + encodeURIComponent('Connected to Bitget successfully!'));
    } else {
      user.bitget = { apiKey: '', secretKey: '', passphrase: '', connected: false };
      await user.save();
      res.redirect('/exchange?error=' + encodeURIComponent('Connection failed: ' + testResult.message));
    }
  } catch (err) {
    console.error('[Exchange] Connect error:', err);
    res.redirect('/exchange?error=' + encodeURIComponent(err.message));
  }
});

app.post('/exchange/disconnect', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.redirect('/login');
    user.bitget = { apiKey: '', secretKey: '', passphrase: '', connected: false };
    user.liveTrading = {
      enabled: false,
      dryRun: false,
      mode: 'manual',
      tradingType: 'futures',
      liveLeverage: 1,
      maxLiveTradesOpen: 3,
      riskPerLiveTrade: 1,
      autoOpenMinScore: 52
    };
    await user.save();
    res.redirect('/exchange?success=' + encodeURIComponent('Disconnected from Bitget. Live trading disabled.'));
  } catch (err) {
    res.redirect('/exchange?error=' + encodeURIComponent(err.message));
  }
});

app.post('/exchange/settings', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.redirect('/exchange');

    if (!user.liveTrading) user.liveTrading = {};

    // Handle live toggle
    if (req.body.toggleLive === 'true') {
      const newState = req.body.newState === 'true';
      if (newState && (!user.bitget || !user.bitget.connected)) {
        return res.redirect('/exchange?error=' + encodeURIComponent('Connect Bitget API first before enabling live trading'));
      }
      user.liveTrading.enabled = newState;
      await user.save();
      return res.redirect('/exchange?success=' + encodeURIComponent(newState ? 'Live trading ENABLED' : 'Live trading disabled'));
    }

    // Handle dry-run toggle
    if (req.body.toggleDryRun === 'true') {
      user.liveTrading.dryRun = req.body.dryRunState === 'true';
      await user.save();
      return res.redirect('/exchange?success=' + encodeURIComponent(user.liveTrading.dryRun ? 'Dry-run mode ENABLED — orders will be logged but not sent to Bitget' : 'Dry-run mode disabled — orders will execute on Bitget'));
    }

    // Save other settings
    if (req.body.mode) {
      user.liveTrading.mode = ['manual', 'auto'].includes(req.body.mode) ? req.body.mode : 'manual';
    }
    if (req.body.tradingType) {
      user.liveTrading.tradingType = ['spot', 'futures', 'both'].includes(req.body.tradingType) ? req.body.tradingType : 'futures';
    }
    if (req.body.liveLeverage != null) {
      user.liveTrading.liveLeverage = Math.min(50, Math.max(1, parseInt(req.body.liveLeverage, 10) || 1));
    }
    if (req.body.maxLiveTradesOpen != null) {
      user.liveTrading.maxLiveTradesOpen = Math.min(10, Math.max(1, parseInt(req.body.maxLiveTradesOpen, 10) || 3));
    }
    if (req.body.riskPerLiveTrade != null) {
      user.liveTrading.riskPerLiveTrade = Math.min(5, Math.max(0.5, parseFloat(req.body.riskPerLiveTrade) || 1));
    }
    if (req.body.autoOpenMinScore != null) {
      user.liveTrading.autoOpenMinScore = Math.min(95, Math.max(50, parseInt(req.body.autoOpenMinScore, 10) || 52));
    }
    await user.save();
    res.redirect('/exchange?success=' + encodeURIComponent('Live trading settings saved'));
  } catch (err) {
    res.redirect('/exchange?error=' + encodeURIComponent(err.message));
  }
});

app.post('/exchange/kill', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user || !user.bitget || !user.bitget.connected) {
      return res.redirect('/exchange?error=' + encodeURIComponent('Not connected to Bitget'));
    }

    const result = await bitget.closeAllPositions(user);
    if (result.success) {
      // Disable live trading after kill switch
      user.liveTrading.enabled = false;
      await user.save();
      res.redirect('/exchange?success=' + encodeURIComponent('All positions closed. Live trading disabled.'));
    } else {
      res.redirect('/exchange?error=' + encodeURIComponent('Kill switch error: ' + (result.error || 'Some positions may not have closed')));
    }
  } catch (err) {
    res.redirect('/exchange?error=' + encodeURIComponent(err.message));
  }
});

// Exchange API endpoints (JSON)
app.get('/api/exchange/balance', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user || !user.bitget || !user.bitget.connected) {
      return res.json({ success: false, error: 'Not connected' });
    }
    const result = await bitget.getAccountBalance(user);
    res.json(result);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/exchange/positions', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user || !user.bitget || !user.bitget.connected) {
      return res.json({ success: false, error: 'Not connected', positions: [] });
    }
    const result = await bitget.getOpenPositions(user);
    res.json(result);
  } catch (err) {
    res.json({ success: false, error: err.message, positions: [] });
  }
});

// ====================================================
// JOURNAL
// ====================================================
app.get('/journal', requireLogin, async (req, res) => {
  try {
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;

    const baseQuery = { userId: req.session.userId };
    const dateFilter = {};
    if (startDate) {
      const d = new Date(startDate);
      if (!isNaN(d.getTime())) dateFilter.$gte = d;
    }
    if (endDate) {
      const d = new Date(endDate + 'T23:59:59.999Z');
      if (!isNaN(d.getTime())) dateFilter.$lte = d;
    }
    if (Object.keys(dateFilter).length > 0) {
      baseQuery.createdAt = dateFilter;
    }

    const entries = await Journal.find(baseQuery)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Load trade if coming from "Journal this trade" link
    let linkedTrade = null;
    const tradeId = req.query.tradeId;
    if (tradeId) {
      linkedTrade = await Trade.findOne({ _id: tradeId, userId: req.session.userId }).lean();
    }

    // Discipline stats (same date range)
    const allEntries = await Journal.find(baseQuery).lean();
    const withRules = allEntries.filter(e => e.followedRules !== undefined);
    const ruleStats = {
      total: withRules.length,
      followed: withRules.filter(e => e.followedRules).length,
      avgRating: allEntries.length > 0
        ? (allEntries.filter(e => e.rating).reduce((s, e) => s + e.rating, 0) / (allEntries.filter(e => e.rating).length || 1)).toFixed(1)
        : '0'
    };

    // Analytics: win rate by emotion, win rate by rules followed (from trade-linked entries, same date range)
    const entriesWithTrade = await Journal.find({ ...baseQuery, tradeId: { $exists: true, $ne: null } }).lean();
    const tradeIds = [...new Set(entriesWithTrade.map(e => e.tradeId && e.tradeId.toString()).filter(Boolean))];
    const trades = tradeIds.length > 0 ? await Trade.find({ _id: { $in: tradeIds }, userId: req.session.userId }).lean() : [];
    const tradeMap = Object.fromEntries(trades.map(t => [t._id.toString(), t]));

    const byEmotion = {};
    const byRules = { followed: { wins: 0, total: 0 }, broke: { wins: 0, total: 0 } };
    const bySetupQuality = {};
    const byExecutionQuality = {};
    for (const entry of entriesWithTrade) {
      const tid = entry.tradeId && entry.tradeId.toString();
      const trade = tid ? tradeMap[tid] : null;
      if (!trade || trade.pnl == null) continue;
      const isWin = trade.pnl > 0;
      if (entry.emotion) {
        byEmotion[entry.emotion] = byEmotion[entry.emotion] || { wins: 0, total: 0 };
        byEmotion[entry.emotion].total++;
        if (isWin) byEmotion[entry.emotion].wins++;
      }
      if (entry.followedRules !== undefined) {
        const bucket = entry.followedRules ? byRules.followed : byRules.broke;
        bucket.total++;
        if (isWin) bucket.wins++;
      }
      if (entry.setupQuality != null && entry.setupQuality >= 1 && entry.setupQuality <= 10) {
        const key = String(entry.setupQuality);
        bySetupQuality[key] = bySetupQuality[key] || { wins: 0, total: 0 };
        bySetupQuality[key].total++;
        if (isWin) bySetupQuality[key].wins++;
      }
      if (entry.executionQuality != null && entry.executionQuality >= 1 && entry.executionQuality <= 10) {
        const key = String(entry.executionQuality);
        byExecutionQuality[key] = byExecutionQuality[key] || { wins: 0, total: 0 };
        byExecutionQuality[key].total++;
        if (isWin) byExecutionQuality[key].wins++;
      }
    }

    res.render('journal', {
      activePage: 'journal',
      entries,
      ruleStats,
      linkedTrade,
      analytics: { byEmotion, byRules, bySetupQuality, byExecutionQuality },
      startDate: startDate || '',
      endDate: endDate || '',
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    console.error('[Journal] Error:', err);
    res.status(500).send('Error loading journal');
  }
});

app.post('/journal', requireLogin, async (req, res) => {
  try {
    const {
      type, emotion, followedRules, content, rating, tradeId,
      setupQuality, executionQuality, whatWentRight, whatWentWrong, keyLesson, nextAction,
      revengeTrade, fomoEntry, overtrading, positionSizeCorrect,
      lessonsLearned, tags
    } = req.body;
    if (!content || !content.trim()) {
      return res.redirect('/journal?error=' + encodeURIComponent('Content is required'));
    }

    const entryData = {
      userId: req.session.userId,
      type: type || 'trade_note',
      emotion: emotion || 'neutral',
      followedRules: followedRules === 'true',
      content: content.trim(),
      rating: parseInt(rating) || undefined,
      lessonsLearned: lessonsLearned ? lessonsLearned.trim() : undefined,
      tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
      setupQuality: setupQuality ? parseInt(setupQuality) : undefined,
      executionQuality: executionQuality ? parseInt(executionQuality) : undefined,
      whatWentRight: whatWentRight ? whatWentRight.trim() : undefined,
      whatWentWrong: whatWentWrong ? whatWentWrong.trim() : undefined,
      keyLesson: keyLesson ? keyLesson.trim() : undefined,
      nextAction: nextAction ? nextAction.trim() : undefined,
      revengeTrade: revengeTrade === 'true',
      fomoEntry: fomoEntry === 'true',
      overtrading: overtrading === 'true',
      positionSizeCorrect: positionSizeCorrect === 'true' ? true : positionSizeCorrect === 'false' ? false : undefined
    };
    let trade = null;
    if (tradeId && mongoose.Types.ObjectId.isValid(tradeId)) {
      trade = await Trade.findOne({ _id: tradeId, userId: req.session.userId });
      if (trade) {
        entryData.tradeId = trade._id;
        entryData.tradeContext = {
          symbol: trade.symbol,
          direction: trade.direction,
          entryPrice: trade.entryPrice,
          exitPrice: trade.exitPrice,
          pnl: trade.pnl,
          pnlPercent: trade.pnlPercent,
          score: trade.score,
          strategyType: trade.strategyType,
          status: trade.status
        };
      }
    }

    const entry = new Journal(entryData);
    await entry.save();

    const redirectUrl = trade ? '/journal?success=' + encodeURIComponent('Journal entry saved') + '&tradeId=' + trade._id : '/journal?success=' + encodeURIComponent('Journal entry saved');
    res.redirect(redirectUrl);
  } catch (err) {
    const tid = req.body.tradeId;
    const errUrl = tid && mongoose.Types.ObjectId.isValid(tid)
      ? '/journal?error=' + encodeURIComponent(err.message) + '&tradeId=' + tid
      : '/journal?error=' + encodeURIComponent(err.message);
    res.redirect(errUrl);
  }
});

// ====================================================
// LEARN PAGE
// ====================================================
app.get('/learn', (req, res) => {
  res.render('learn', { activePage: 'learn' });
});

// ====================================================
// BACKTEST PAGE (historical simulation)
// ====================================================
app.get('/backtest', async (req, res) => {
  const btUser = req.session?.userId ? await User.findById(req.session.userId).select('settings disabledRegimesByCoin').lean() : null;
  const adminDiscordConfig = res.locals.isAdmin ? await getAdminDiscordConfig() : null;
  res.render('backtest', { activePage: 'backtest', results: null, TRACKED_COINS, user: btUser, adminDiscordConfig });
});

async function getCacheStatusPayload() {
  const rows = await buildCacheStatusMatrix();
  const storage = await getCacheStorageStats();
  const readyCoins = new Set(rows.filter((r) => r.totalCandles > 0).map((r) => r.coinId)).size;
  return {
    rows,
    stats: {
      totalCandles: storage.totalCandles || 0,
      storageUsed: formatBytes(storage.storageBytes || 0),
      readyCoins,
      totalCoins: TRACKED_COINS.length
    }
  };
}

app.get('/admin/cache-status', requireAdmin, async (req, res) => {
  try {
    const payload = await getCacheStatusPayload();
    res.render('cache-status', {
      activePage: 'cache-status',
      rows: payload.rows,
      stats: payload.stats,
      totalCoins: TRACKED_COINS.length
    });
  } catch (err) {
    console.error('[CacheStatus] Render error:', err.message);
    res.status(500).send('Failed to load cache status');
  }
});

app.get('/api/admin/cache-status', requireAdmin, async (req, res) => {
  try {
    const payload = await getCacheStatusPayload();
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load cache status' });
  }
});

app.post('/api/admin/cache-status/refresh-all', requireAdmin, async (req, res) => {
  try {
    const out = await syncAllCandles({ coins: TRACKED_COINS, timeframes: CACHE_TIMEFRAMES });
    res.json({
      success: true,
      message: `Candle cache updated: ${(out.newCandles || 0).toLocaleString()} new candles added across ${TRACKED_COINS.length} coins`,
      failed: out.failed || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Refresh failed' });
  }
});

app.post('/api/admin/cache-status/populate-missing', requireAdmin, async (req, res) => {
  try {
    const out = await populateMissingCandles({ coins: TRACKED_COINS, timeframes: CACHE_TIMEFRAMES });
    res.json({
      success: true,
      message: `Populate missing complete: ${(out.totalStored || 0).toLocaleString()} candles stored across ${out.populatedPairs || 0} empty coin/timeframe pairs`,
      failed: out.failed || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Populate failed' });
  }
});

function loadLatestMassiveBacktestResult() {
  const resultsDir = path.join(__dirname, 'data/backtest-results');
  if (!fs.existsSync(resultsDir)) throw new Error('No backtest results directory.');
  const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('massive-') && f.endsWith('.json'));
  if (files.length === 0) throw new Error('No massive backtest results found.');
  const latest = files.sort().reverse()[0];
  return JSON.parse(fs.readFileSync(path.join(resultsDir, latest), 'utf8'));
}

// TEMPORARILY DISABLED (backtest-results page hidden)
// app.post('/admin/backtest-discord-settings', requireAdmin, async (req, res) => {
//   try {
//     const enabled = req.body.backtestDiscordEnabled === 'true' || (Array.isArray(req.body.backtestDiscordEnabled) && req.body.backtestDiscordEnabled.includes('true'));
//     await saveAdminDiscordConfig({
//       backtest: {
//         enabled,
//         webhookUrl: String(req.body.backtestDiscordWebhook || '').trim()
//       }
//     });
//     res.redirect('/backtest-results?success=' + encodeURIComponent('Backtest Discord settings saved.'));
//   } catch (err) {
//     res.redirect('/backtest-results?error=' + encodeURIComponent(err.message || 'Failed to save backtest Discord settings'));
//   }
// });

app.post('/admin/trades-wins-discord-settings', requireAdmin, async (req, res) => {
  try {
    const enabled = req.body.winsDiscordEnabled === 'true' || (Array.isArray(req.body.winsDiscordEnabled) && req.body.winsDiscordEnabled.includes('true'));
    const onlyUserEmail = String(req.body.winsOnlyUserEmail || '').trim().toLowerCase();
    const onlyUser = onlyUserEmail ? await resolveAdminDiscordUserByEmail(onlyUserEmail) : null;
    if (onlyUserEmail && !onlyUser) {
      return res.redirect('/trades?error=' + encodeURIComponent('Wins webhook user email not found.'));
    }
    await saveAdminDiscordConfig({
      wins: {
        enabled,
        webhookUrl: String(req.body.winsDiscordWebhook || '').trim(),
        minPnlUsd: Number(req.body.winsMinPnlUsd || 0),
        onlyUserId: onlyUser ? String(onlyUser._id) : '',
        onlyUserEmail: onlyUser ? String(onlyUser.email || '') : ''
      }
    });
    res.redirect('/trades?success=' + encodeURIComponent('Wins Discord settings saved.'));
  } catch (err) {
    res.redirect('/trades?error=' + encodeURIComponent(err.message || 'Failed to save wins Discord settings'));
  }
});

// TEMPORARILY DISABLED (backtest-results page hidden)
// app.post('/api/admin/backtest-results/post-discord', requireAdmin, async (req, res) => {
//   try {
//     const latestResult = loadLatestMassiveBacktestResult();
//     const out = await postMassiveBacktestToDiscord(latestResult);
//     if (out && out.skipped) {
//       return res.status(400).json({ success: false, error: out.reason || 'Backtest Discord is disabled.' });
//     }
//     res.json({ success: true });
//   } catch (err) {
//     res.status(500).json({ success: false, error: err.message || 'Failed to post results to Discord' });
//   }
// });

app.post('/api/admin/backtest/post-discord', requireAdmin, async (req, res) => {
  try {
    let runData = req.body || {};
    const missingDetail = !Array.isArray(runData.results) || runData.results.length === 0;
    if (missingDetail) {
      const cached = latestBacktestResultByUser.get(String(req.session.userId));
      if (cached && cached.result) runData = cached.result;
    }
    const out = await postBacktestRunToDiscord(runData);
    if (out && out.skipped) {
      return res.status(400).json({ success: false, error: out.reason || 'Backtest Discord is disabled.' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Failed to post backtest run to Discord' });
  }
});

app.get('/admin/free-signal', requireAdmin, async (req, res) => {
  try {
    const config = await getFreeSignalConfig();
    let paperUserDisplay = '';
    let paperUserEmail = '';
    if (config.paperUserId) {
      const u = await User.findById(config.paperUserId).select('username email').lean();
      if (u) {
        paperUserDisplay = `${u.username} (${u.email})`;
        paperUserEmail = u.email;
      }
    }
    const coinOptions = TRACKED_COINS.map(id => ({
      id,
      label: COIN_META[id] ? `${COIN_META[id].name} (${COIN_META[id].symbol})` : id
    })).sort((a, b) => a.label.localeCompare(b.label));

    res.render('admin-free-signal', {
      activePage: 'free-signal',
      config,
      paperUserDisplay,
      paperUserEmail,
      coinOptions,
      errorMsg: req.query.error || null,
      successMsg: req.query.success || null
    });
  } catch (err) {
    res.status(500).send('Failed to load free signal admin page');
  }
});

app.post('/admin/free-signal', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const paperUserEmail = String(body.paperUserEmail || '').trim().toLowerCase();
    const paperUser = paperUserEmail ? await lookupFreeSignalUserByEmail(paperUserEmail) : null;
    if (paperUserEmail && !paperUser) {
      return res.redirect('/admin/free-signal?error=' + encodeURIComponent('Paper user email not found.'));
    }

    await saveFreeSignalConfig({
      enabled: body.enabled === 'true' || (Array.isArray(body.enabled) && body.enabled.includes('true')),
      webhookUrl: String(body.webhookUrl || '').trim(),
      coinId: String(body.coinId || 'fantom').trim().toLowerCase(),
      paperUserId: paperUser ? String(paperUser._id) : '',
      cooldownMinutes: Number(body.cooldownMinutes || 60),
      updateIntervalMinutes: Number(body.updateIntervalMinutes || 15),
      includeActionBadges: body.includeActionBadges === 'true' || (Array.isArray(body.includeActionBadges) && body.includeActionBadges.includes('true')),
      positionFirstMode: body.positionFirstMode === 'true' || (Array.isArray(body.positionFirstMode) && body.positionFirstMode.includes('true')),
      postWhenNoOpenTrade: body.postWhenNoOpenTrade === 'true' || (Array.isArray(body.postWhenNoOpenTrade) && body.postWhenNoOpenTrade.includes('true'))
    });

    res.redirect('/admin/free-signal?success=' + encodeURIComponent('Free signal settings saved.'));
  } catch (err) {
    res.redirect('/admin/free-signal?error=' + encodeURIComponent(err.message || 'Failed to save free signal config'));
  }
});

app.get('/admin/referrals', requireAdmin, async (req, res) => {
  try {
    const partners = await Referral.find({}).sort({ createdAt: -1 }).lean();
    const users = await User.find({ referredBy: { $ne: '' } })
      .select('email username referredBy subscriptionTier createdAt')
      .lean();
    const byCode = new Map();
    users.forEach((u) => {
      const code = normalizeReferralCode(u.referredBy);
      if (!code) return;
      if (!byCode.has(code)) byCode.set(code, { totalSignups: 0, activeSubscribers: 0 });
      const row = byCode.get(code);
      row.totalSignups += 1;
      if (['trial', 'pro', 'elite', 'partner'].includes(u.subscriptionTier)) row.activeSubscribers += 1;
    });
    const rows = partners.map((p) => {
      const metrics = byCode.get(normalizeReferralCode(p.referralCode)) || { totalSignups: 0, activeSubscribers: 0 };
      return { ...p, totalSignups: metrics.totalSignups, activeSubscribers: metrics.activeSubscribers };
    });
    res.render('admin-referrals', {
      activePage: 'admin-referrals',
      pageTitle: 'Referrals',
      partners: rows,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (err) {
    res.status(500).send(err.message || 'Failed to load referrals');
  }
});

app.post('/admin/referrals/create', requireAdmin, async (req, res) => {
  try {
    const codeCandidate = normalizeReferralCode(req.body.referralCode || req.body.name || 'PARTNER');
    const referralCode = codeCandidate || `PARTNER${Math.floor(1000 + Math.random() * 9000)}`;
    const existing = await Referral.findOne({ referralCode }).lean();
    if (existing) {
      return res.redirect('/admin/referrals?error=' + encodeURIComponent('Referral code already exists'));
    }
    const partner = await Referral.create({
      name: String(req.body.name || '').trim(),
      email: String(req.body.email || '').trim().toLowerCase(),
      twitterHandle: String(req.body.twitterHandle || '').trim(),
      discordUsername: String(req.body.discordUsername || '').trim(),
      referralCode,
      commissionRate: Number(req.body.commissionRate || 10),
      status: 'active',
      tier: 'partner'
    });
    const linkedUser = await User.findOne({ email: partner.email });
    if (linkedUser) {
      linkedUser.subscriptionTier = 'partner';
      linkedUser.isPartner = true;
      linkedUser.partnerCommissionRate = partner.commissionRate;
      linkedUser.referralCode = partner.referralCode;
      await linkedUser.save();
    }
    return res.redirect('/admin/referrals?success=' + encodeURIComponent('Partner created successfully'));
  } catch (err) {
    return res.redirect('/admin/referrals?error=' + encodeURIComponent(err.message || 'Failed to create partner'));
  }
});

app.post('/admin/referrals/:id/status', requireAdmin, async (req, res) => {
  try {
    const status = String(req.body.status || '').toLowerCase();
    if (!['active', 'paused', 'cancelled'].includes(status)) {
      return res.redirect('/admin/referrals?error=' + encodeURIComponent('Invalid status'));
    }
    await Referral.updateOne({ _id: req.params.id }, { $set: { status } });
    return res.redirect('/admin/referrals?success=' + encodeURIComponent('Partner status updated'));
  } catch (err) {
    return res.redirect('/admin/referrals?error=' + encodeURIComponent(err.message || 'Update failed'));
  }
});

app.get('/admin/referrals/:id', requireAdmin, async (req, res) => {
  try {
    const partner = await Referral.findById(req.params.id).lean();
    if (!partner) return res.status(404).send('Partner not found');
    const referredUsers = await User.find({ referredBy: normalizeReferralCode(partner.referralCode) })
      .select('email username createdAt subscriptionTier stripeSubscriptionId stripeCustomerId')
      .sort({ createdAt: -1 })
      .lean();
    const commissions = await CommissionTransaction.find({ partnerId: partner._id }).sort({ createdAt: -1 }).lean();
    res.render('admin-referral-detail', {
      activePage: 'admin-referrals',
      pageTitle: `Partner ${partner.referralCode}`,
      partner,
      referredUsers,
      commissions,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (err) {
    res.status(500).send(err.message || 'Failed to load partner');
  }
});

app.post('/admin/referrals/:id/mark-paid', requireAdmin, async (req, res) => {
  try {
    const partner = await Referral.findById(req.params.id);
    if (!partner) return res.redirect('/admin/referrals?error=' + encodeURIComponent('Partner not found'));
    await CommissionTransaction.updateMany({ partnerId: partner._id, status: 'pending' }, { $set: { status: 'paid', paidAt: new Date() } });
    partner.totalEarnings = (partner.totalEarnings || 0) + (partner.pendingEarnings || 0);
    partner.pendingEarnings = 0;
    await partner.save();
    return res.redirect(`/admin/referrals/${partner._id}?success=` + encodeURIComponent('Partner marked as paid'));
  } catch (err) {
    return res.redirect('/admin/referrals?error=' + encodeURIComponent(err.message || 'Failed to mark paid'));
  }
});

// ====================================================
// BETA MANAGEMENT (admin)
// ====================================================
app.get('/admin/beta', requireAdmin, async (req, res) => {
  try {
    const betaConfig = await getBetaConfig();
    const codes = await BetaCode.find().sort({ createdAt: -1 }).lean();
    res.render('admin-beta', {
      activePage: 'admin-beta',
      pageTitle: 'Beta Management',
      betaConfig,
      codes,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (err) {
    res.status(500).send(err.message || 'Failed to load beta management');
  }
});

app.post('/admin/beta/toggle', requireAdmin, async (req, res) => {
  try {
    const { setting, value } = req.body;
    const boolVal = value === 'true';
    const field = setting === 'betaEnabled' ? 'enabled' : setting === 'referralsEnabled' ? 'referralsEnabled' : null;
    if (!field) return res.redirect('/admin/beta?error=' + encodeURIComponent('Invalid setting'));
    const doc = await SystemConfig.findOneAndUpdate(
      { key: 'beta_config' },
      { $set: { [`value.${field}`]: boolVal, updatedAt: new Date() } },
      { upsert: true, new: true }
    );
    _betaConfigCache.data = null;
    const label = field === 'enabled' ? 'Closed Beta' : 'Referrals';
    res.redirect('/admin/beta?success=' + encodeURIComponent(`${label} ${boolVal ? 'enabled' : 'disabled'}`));
  } catch (err) {
    res.redirect('/admin/beta?error=' + encodeURIComponent(err.message || 'Toggle failed'));
  }
});

app.post('/admin/beta/generate', requireAdmin, async (req, res) => {
  try {
    const count = Math.min(50, Math.max(1, parseInt(req.body.count) || 5));
    const label = String(req.body.label || '').trim();
    const customCode = normalizeReferralCode(req.body.customCode || '');
    const generated = [];

    if (customCode) {
      const exists = await BetaCode.findOne({ code: customCode }).lean();
      if (exists) return res.redirect('/admin/beta?error=' + encodeURIComponent(`Code "${customCode}" already exists`));
      await BetaCode.create({ code: customCode, label });
      generated.push(customCode);
    } else {
      for (let i = 0; i < count; i++) {
        const code = 'BETA-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        try {
          await BetaCode.create({ code, label });
          generated.push(code);
        } catch { /* duplicate, skip */ }
      }
    }
    res.redirect('/admin/beta?success=' + encodeURIComponent(`Generated ${generated.length} code(s): ${generated.join(', ')}`));
  } catch (err) {
    res.redirect('/admin/beta?error=' + encodeURIComponent(err.message || 'Generation failed'));
  }
});

app.post('/admin/beta/toggle-code', requireAdmin, async (req, res) => {
  try {
    const { codeId, active } = req.body;
    await BetaCode.findByIdAndUpdate(codeId, { active: active === 'true' });
    res.redirect('/admin/beta');
  } catch (err) {
    res.redirect('/admin/beta?error=' + encodeURIComponent(err.message || 'Failed'));
  }
});

app.get('/partner-dashboard', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).lean();
    const referralCode = normalizeReferralCode(user?.referralCode || user?.referredBy);
    const partner = referralCode ? await Referral.findOne({ referralCode }).lean() : null;
    if (!partner) return res.status(403).send('Partner access required');
    const commissions = await CommissionTransaction.find({ partnerId: partner._id }).sort({ createdAt: -1 }).limit(100).lean();
    const referredUsers = await User.find({ referredBy: referralCode }).select('email username subscriptionTier createdAt').lean();
    const activeSubscribers = referredUsers.filter((u) => ['trial', 'pro', 'elite', 'partner'].includes(u.subscriptionTier)).length;
    const betaConfig = await getBetaConfig();
    res.render('partner-dashboard', {
      activePage: 'partner-dashboard',
      pageTitle: 'Partner Dashboard',
      partner,
      referralLink: `${APP_BASE_URL}/register?ref=${partner.referralCode}`,
      totalSignups: referredUsers.length,
      activeSubscribers,
      commissions,
      referralsEnabled: betaConfig.referralsEnabled
    });
  } catch (err) {
    res.status(500).send(err.message || 'Failed to load partner dashboard');
  }
});

// ====================================================
// SETUPS (SMC trade scenarios)
// ====================================================
app.get('/setups', optionalUser, async (req, res) => {
  const { getAllScenarios } = require('./services/smc-scenarios/scenario-definitions');
  const setups = getAllScenarios();
  let setupStats = {};
  let user = null;
  if (req.session?.userId) {
    user = await User.findById(req.session.userId).lean();
    const SetupBacktestResult = require('./models/SetupBacktestResult');
    const results = await SetupBacktestResult.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(req.session.userId) } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$setupId', doc: { $first: '$$ROOT' } } }
    ]);
    results.forEach(r => {
      const d = r.doc;
      setupStats[d.setupId] = {
        winRate: d.winRate,
        totalPnlPercent: d.totalPnlPercent,
        maxDrawdownPct: d.maxDrawdownPct,
        totalTrades: d.totalTrades
      };
    });
  }
  let setupNotifications = [];
  if (req.session?.userId) {
    try {
      const SetupNotification = require('./models/SetupNotification');
      setupNotifications = await SetupNotification.find({ userId: req.session.userId })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean();
    } catch (e) {
      setupNotifications = [];
    }
  }
  res.render('setups', {
    activePage: 'setups',
    setups,
    setupStats,
    setupNotifications,
    TRACKED_COINS,
    user
  });
});

app.post('/api/setups/backtest', requireLogin, heavyJobLimiter, async (req, res) => {
  try {
    const { coinId, setupId, startDate, endDate, timeframe, multiCoin, minScore, partialTP, fees, minRR, breakeven, breakevenAtr, trailingSL, trailingSLAtr, trailingTP, trailingTPAtr, htfFilter } = req.body || {};
    if (!setupId) return res.status(400).json({ error: 'Setup ID required' });
    const startMs = startDate ? new Date(startDate).getTime() : Date.now() - 90 * 24 * 3600000;
    const endMs = endDate ? new Date(endDate).getTime() : Date.now();
    const tf = ['15m', '1h', '4h', '1d', '1w'].includes(timeframe) ? timeframe : '1h';
    const btOpts = {
      initialBalance: 10000,
      leverage: 2,
      timeframe: tf,
      minScore: Number(minScore) || 0,
      partialTP: partialTP === true || partialTP === 'true',
      fees: fees !== false && fees !== 'false',
      minRR: Number(minRR) || 0,
      breakeven: breakeven === true || breakeven === 'true',
      breakevenAtr: Number(breakevenAtr) || 1.0,
      trailingSL: trailingSL === true || trailingSL === 'true',
      trailingSLAtr: Number(trailingSLAtr) || 1.5,
      trailingTP: trailingTP === true || trailingTP === 'true',
      trailingTPAtr: Number(trailingTPAtr) || 1.5,
      htfFilter: htfFilter !== false && htfFilter !== 'false'
    };
    const { runSetupBacktest } = require('./services/smc-backtest');

    if (multiCoin === true || multiCoin === 'true') {
      const coins = TRACKED_COINS.slice(0, MAX_SMC_BACKTEST_COINS);
      if (backtestQueueEnabled) {
        const [activeCount, waitingCount] = await Promise.all([
          backtestQueue.getActiveCount(), backtestQueue.getWaitingCount()
        ]);
        if ((activeCount + waitingCount) >= BACKTEST_QUEUE_MAX_WAITING) {
          return res.status(429).json({ error: 'Backtest queue is busy. Please try again later.' });
        }
        const queueJob = await backtestQueue.add({
          type: 'smc_multi',
          ownerId: String(req.session.userId),
          setupId, startMs, endMs, btOpts, coins
        }, { timeout: 600000, attempts: 1 });
        return res.json({ jobId: String(queueJob.id), status: 'running', coins });
      }
      if (countRunningBacktestJobs() >= MAX_RUNNING_BACKTEST_JOBS) {
        return res.status(429).json({ error: 'Backtest queue is busy. Please wait for current run to finish.' });
      }
      const SMC_BATCH_SIZE = 3;
      const SMC_PER_COIN_TIMEOUT = 120000;

      const jobId = crypto.randomBytes(12).toString('hex');
      const job = {
        id: jobId,
        ownerId: String(req.session.userId),
        status: 'running',
        progress: `Starting SMC backtest for ${coins.length} coin(s)...`,
        coins,
        createdAt: Date.now(),
        result: null,
        error: null
      };
      backtestJobs.set(jobId, job);

      (async () => {
        try {
          const allTrades = [];
          const perCoin = [];
          const totalEquity = 10000 * coins.length;
          let totalPnl = 0;
          let completed = 0;

          for (let i = 0; i < coins.length; i += SMC_BATCH_SIZE) {
            const batch = coins.slice(i, i + SMC_BATCH_SIZE);
            const batchResults = await Promise.allSettled(
              batch.map(cid =>
                Promise.race([
                  runSetupBacktest(cid, setupId, startMs, endMs, { ...btOpts }),
                  new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout: ${cid}`)), SMC_PER_COIN_TIMEOUT))
                ])
              )
            );

            for (let j = 0; j < batchResults.length; j++) {
              completed++;
              const r = batchResults[j];
              const cid = batch[j];
              if (r.status === 'rejected' || r.value?.error) continue;
              const v = r.value;
              const s = v.summary || {};
              if (s.totalTrades > 0) {
                allTrades.push(...(v.trades || []).map(t => ({ ...t, coinId: cid })));
                totalPnl += s.totalPnl || 0;
                perCoin.push({ coinId: cid, ...s });
              }
            }
            job.progress = `Processed ${completed}/${coins.length} coins...`;
            if (i + SMC_BATCH_SIZE < coins.length) await new Promise(r => setTimeout(r, 300));
          }

          const wins = allTrades.filter(t => t.pnl > 0).length;
          const losses = allTrades.filter(t => t.pnl <= 0).length;
          const grossProfit = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
          const grossLoss = Math.abs(allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
          const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
          const finalBalance = totalEquity + totalPnl;

          const { computeMaxDrawdownPct } = require('./services/backtest/analytics');
          const sortedByExit = [...allTrades].sort((a, b) => (a.exitTime || 0) - (b.exitTime || 0));
          const equityCurve = [{ equity: totalEquity, date: 0 }];
          let eq = totalEquity;
          for (const t of sortedByExit) {
            eq += t.pnl || 0;
            equityCurve.push({ equity: Math.max(0, eq), date: t.exitTime || 0 });
          }
          const maxDrawdownPct = equityCurve.length > 1 ? computeMaxDrawdownPct(equityCurve) : 0;

          job.status = 'done';
          job.progress = 'Complete';
          job.result = {
            success: true,
            summary: {
              totalTrades: allTrades.length, wins, losses,
              winRate: allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0,
              totalPnl, totalPnlPercent: (totalPnl / totalEquity) * 100,
              profitFactor, maxDrawdownPct,
              initialBalance: totalEquity, finalBalance,
              setupId, coinsRun: coins.length, coinsWithTrades: perCoin.length
            },
            trades: allTrades.slice(0, 500), perCoin, multiCoin: true
          };
          job.finishedAt = Date.now();
          console.log(`[SMC-Backtest] Job ${jobId} completed in ${((job.finishedAt - job.createdAt) / 1000).toFixed(1)}s`);
        } catch (err) {
          job.status = 'error';
          job.error = err.message || 'SMC backtest failed';
          job.finishedAt = Date.now();
          console.error(`[SMC-Backtest] Job ${jobId} failed:`, err.message);
        }
      })();

      return res.json({ jobId, status: 'running', coins });
    }

    // Single coin — fast enough to run inline
    const cid = coinId || 'bitcoin';
    const result = await runSetupBacktest(cid, setupId, startMs, endMs, btOpts);
    if (result.error) return res.status(400).json({ error: result.error });

    if (req.session?.userId && result.summary) {
      const SetupBacktestResult = require('./models/SetupBacktestResult');
      await SetupBacktestResult.create({
        userId: req.session.userId,
        setupId,
        coinId: cid,
        startDate: new Date(startMs),
        endDate: new Date(endMs),
        ...result.summary,
        trades: result.trades || [],
        equityCurve: result.equityCurve || []
      });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Setups] Backtest error:', err);
    res.status(500).json({ error: err.message || 'Backtest failed' });
  }
});

app.get('/api/setups/scan', async (req, res) => {
  try {
    const setupId = req.query.setupId || null;
    const { scanMarketForSetups } = require('./services/smc-scanner');
    const candles = fetchAllCandles();
    const prices = await fetchAllPrices();
    if (!candles || Object.keys(candles).length === 0) {
      return res.json({ results: [], message: 'No candle data. Wait for refresh or try again.' });
    }
    const results = scanMarketForSetups(candles, Array.isArray(prices) ? prices : [], setupId ? [setupId] : null);
    res.json({ results });
  } catch (err) {
    console.error('[Setups] Scan error:', err);
    res.status(500).json({ error: err.message || 'Scan failed', results: [] });
  }
});

app.post('/api/setups/enable', requireLogin, async (req, res) => {
  try {
    const { setupId, enabled } = req.body || {};
    if (!setupId) return res.status(400).json({ error: 'Setup ID required' });
    const u = await User.findById(req.session.userId);
    if (!u) return res.status(401).json({ error: 'User not found' });
    const s = u.settings || {};
    let ids = Array.isArray(s.autoTradeSetupIds) ? [...s.autoTradeSetupIds] : [];
    if (enabled) {
      if (!ids.includes(setupId)) ids.push(setupId);
    } else {
      ids = ids.filter(id => id !== setupId);
    }
    s.autoTradeSetupIds = ids;
    u.settings = s;
    await u.save();
    res.json({ success: true, autoTradeSetupIds: ids });
  } catch (err) {
    console.error('[Setups] Enable error:', err);
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

app.post('/api/setups/use-for-autotrade', requireLogin, async (req, res) => {
  try {
    const { enabled } = req.body || {};
    const u = await User.findById(req.session.userId);
    if (!u) return res.status(401).json({ error: 'User not found' });
    const s = u.settings || {};
    s.autoTradeUseSetups = enabled === true || enabled === 'true';
    u.settings = s;
    await u.save();
    res.json({ success: true, autoTradeUseSetups: s.autoTradeUseSetups });
  } catch (err) {
    console.error('[Setups] Use-for-autotrade error:', err);
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

// ====================================================
// SETUP NOTIFICATIONS (LLM finds setups → push-style alerts)
// ====================================================
app.get('/api/setup-notifications', requireLogin, async (req, res) => {
  try {
    const SetupNotification = require('./models/SetupNotification');
    const filter = { userId: req.session.userId, seenAt: null };
    const [unread, unreadCount] = await Promise.all([
      SetupNotification.find(filter).sort({ createdAt: -1 }).limit(20).lean(),
      SetupNotification.countDocuments(filter)
    ]);
    res.json({ success: true, count: unreadCount, items: unread });
  } catch (err) {
    console.error('[SetupNotifications] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/setup-notifications/:id/seen', requireLogin, async (req, res) => {
  try {
    const SetupNotification = require('./models/SetupNotification');
    await SetupNotification.updateOne({ _id: req.params.id, userId: req.session.userId }, { seenAt: new Date() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/setup-notifications/seen-all', requireLogin, async (req, res) => {
  try {
    const SetupNotification = require('./models/SetupNotification');
    await SetupNotification.updateMany({ userId: req.session.userId, seenAt: null }, { seenAt: new Date() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// PUSH NOTIFICATIONS (trades & action badges)
// ====================================================
app.get('/api/push/vapid-public', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push notifications not configured' });
  res.json({ publicKey: key });
});

app.post('/api/push/subscribe', requireLogin, async (req, res) => {
  try {
    const subscription = req.body?.subscription;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ success: false, error: 'Invalid subscription' });
    }
    const sub = {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      userAgent: req.headers['user-agent'] || ''
    };
    await User.updateOne(
      { _id: req.session.userId },
      { $pull: { pushSubscriptions: { endpoint: subscription.endpoint } } }
    );
    await User.updateOne(
      { _id: req.session.userId },
      { $push: { pushSubscriptions: sub } }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Push] Subscribe error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/push/unsubscribe', requireLogin, async (req, res) => {
  try {
    const endpoint = req.body?.endpoint;
    if (endpoint) {
      await User.updateOne(
        { _id: req.session.userId },
        { $pull: { pushSubscriptions: { endpoint } } }
      );
    } else {
      await User.updateOne({ _id: req.session.userId }, { $set: { pushSubscriptions: [] } });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// BACKTEST RESULTS (latest massive backtest) — TEMPORARILY DISABLED
// ====================================================
// app.get('/backtest-results', async (req, res) => {
//   try {
//     const data = loadLatestMassiveBacktestResult();
//     const adminDiscordConfig = res.locals.isAdmin ? await getAdminDiscordConfig() : null;
//     res.render('backtest-results', {
//       activePage: 'backtest-results',
//       result: data,
//       adminDiscordConfig,
//       successMsg: req.query.success || null,
//       errorMsg: req.query.error || null
//     });
//   } catch (err) {
//     console.error('[BacktestResults] Error:', err);
//     res.render('backtest-results', {
//       activePage: 'backtest-results',
//       error: err.message,
//       errorMsg: req.query.error || null,
//       successMsg: req.query.success || null
//     });
//   }
// });

// ====================================================
// TRENCH WARFARE - ADMIN ONLY (hidden from public, available for dev)
// ====================================================
app.get('/trench-warfare', requireAdmin, async (req, res) => {
  const ScalpTrade = require('./models/ScalpTrade');
  let openPositions = [];
  const user = req.session?.userId ? await User.findById(req.session.userId).lean() : null;
  const trenchAccess = !!(user && (user.subscriptionTier === 'elite' || user.subscriptionTier === 'partner' || user.trenchWarfareEnabled));
  if (user) {
    openPositions = await ScalpTrade.find({ userId: user._id, status: 'OPEN' }).sort({ createdAt: -1 }).lean();
  }
  let botRunning = false;
  if (user) {
    botRunning = !!(user.trenchAuto?.enabled && !user.trenchAuto?.lastPausedAt);
    const trenchAutoService = require('./services/trench-auto-trading');
    const localStatus = trenchAutoService.getBotStatus(user._id);
    if (localStatus.running) botRunning = true;
  }
  res.render('trench-warfare', {
    activePage: 'trench-warfare',
    pageTitle: 'Trench Warfare',
    trendings: [],
    user,
    trenchPaperBalance: user ? (user.trenchPaperBalance ?? 1000) : 0,
    openPositions,
    trenchBot: user?.trenchBot || {},
    trenchAuto: user?.trenchAuto || {},
    botRunning,
    trenchAccess
  });
});

app.get('/trench-chart/:tokenAddress', requireAdmin, (req, res) => {
  const tokenAddress = (req.params.tokenAddress || '').trim();
  if (!tokenAddress || tokenAddress.length < 20) {
    return res.status(400).send('Invalid token address. <a href="/trench-warfare">Back to Trench Warfare</a>');
  }
  const dexUrl = 'https://dexscreener.com/solana/' + encodeURIComponent(tokenAddress);
  const birdeyeUrl = 'https://birdeye.so/token/' + encodeURIComponent(tokenAddress);
  res.render('trench-chart', {
    activePage: 'trench-warfare',
    pageTitle: 'Token Chart',
    tokenAddress,
    dexUrl,
    birdeyeUrl
  });
});

app.get('/api/trench-warfare/trendings', requireAdmin, async (req, res) => {
  const mobula = require('./services/mobula-api');
  try {
    const data = await (mobula.fetchMetaTrendingsMulti || mobula.fetchMetaTrendings)(req.query.blockchain || 'solana');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trench-warfare/market-categories', requireAdmin, async (req, res) => {
  const dexscreener = require('./services/dexscreener-api');
  try {
    const limit = parseInt(req.query.limit, 10);
    const categories = await dexscreener.fetchMarketCategories(isNaN(limit) ? 10 : limit);
    res.json({ success: true, categories });
  } catch (e) {
    console.warn('[Trench] Market categories error:', e.message);
    res.status(500).json({ success: false, error: e.message, categories: {} });
  }
});

app.post('/api/trench-warfare/swap/quote', requireAdmin, heavyJobLimiter, async (req, res) => {
  const mobula = require('./services/mobula-api');
  try {
    const { tokenOut, amount, walletAddress, slippage } = req.body || {};
    if (!tokenOut || !amount || !walletAddress) {
      return res.status(400).json({ error: 'Missing tokenOut, amount, or walletAddress' });
    }
    const quote = await mobula.getSwapQuote(
      'solana',
      mobula.SOL_MINT,
      tokenOut,
      amount,
      walletAddress,
      { slippage: slippage ?? 5 }
    );
    res.json(quote);
  } catch (e) {
    console.error('[TrenchWarfare] Swap quote failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/paper/buy', requireAdmin, async (req, res) => {
  const ScalpTrade = require('./models/ScalpTrade');
  try {
    const { tokenAddress, tokenSymbol, tokenName, amountUsd, price } = req.body || {};
    if (!tokenAddress || !tokenSymbol || !amountUsd || !price || price <= 0) {
      return res.status(400).json({ error: 'Missing tokenAddress, tokenSymbol, amountUsd, or price' });
    }
    const amount = parseFloat(amountUsd);
    const tokenPrice = parseFloat(price);
    if (amount <= 0 || !Number.isFinite(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!tokenPrice || tokenPrice <= 0 || !Number.isFinite(tokenPrice)) {
      return res.status(400).json({ error: 'Invalid token price. Refresh the page.' });
    }
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const balance = user.trenchPaperBalance ?? 1000;
    if (amount > balance) {
      return res.status(400).json({ error: 'Insufficient trench paper balance. Need $' + amount.toFixed(2) + ', have $' + balance.toFixed(2) });
    }
    const tokenAmount = amount / tokenPrice;
    user.trenchPaperBalance = Math.round((balance - amount) * 100) / 100;
    await user.save();
    await ScalpTrade.create({
      userId: user._id,
      walletAddress: 'paper',
      isPaper: true,
      tokenAddress,
      tokenSymbol,
      tokenName,
      side: 'BUY',
      amountIn: amount,
      tokenAmount,
      entryPrice: tokenPrice,
      status: 'OPEN'
    });
    res.json({ success: true, trenchPaperBalance: user.trenchPaperBalance });
  } catch (e) {
    console.error('[TrenchWarfare] Paper buy failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/paper/sell', requireAdmin, async (req, res) => {
  const ScalpTrade = require('./models/ScalpTrade');
  try {
    const { positionId, currentPrice } = req.body || {};
    if (!positionId || !currentPrice || currentPrice <= 0) {
      return res.status(400).json({ error: 'Missing positionId or currentPrice' });
    }
    const pos = await ScalpTrade.findOne({ _id: positionId, userId: req.session.userId, isPaper: true, status: 'OPEN' });
    if (!pos) return res.status(404).json({ error: 'Position not found' });
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const exitPrice = parseFloat(currentPrice);
    const valueOut = pos.tokenAmount * exitPrice;
    const pnl = Math.round((valueOut - pos.amountIn) * 100) / 100;
    const pnlPct = pos.entryPrice > 0 ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    user.trenchPaperBalance = Math.round(((user.trenchPaperBalance ?? 1000) + valueOut) * 100) / 100;
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
    await user.save();
    pos.exitPrice = exitPrice;
    pos.amountOut = valueOut;
    pos.pnl = pnl;
    pos.pnlPercent = pnlPct;
    pos.status = 'CLOSED';
    pos.exitTime = new Date();
    pos.exitReason = 'manual';
    await pos.save();
    res.json({ success: true, trenchPaperBalance: user.trenchPaperBalance, pnl });
  } catch (e) {
    console.error('[TrenchWarfare] Paper sell failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/paper/reset', requireAdmin, async (req, res) => {
  const ScalpTrade = require('./models/ScalpTrade');
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });

    // Stop the bot if running
    try {
      const trenchAuto = require('./services/trench-auto-trading');
      trenchAuto.stopBot(user._id);
    } catch (e) { /* ignore */ }

    // Force-close all open paper positions
    await ScalpTrade.updateMany(
      { userId: user._id, isPaper: true, status: 'OPEN' },
      { $set: { status: 'CLOSED', exitTime: new Date(), exitReason: 'reset', pnl: 0, pnlPercent: 0 } }
    );

    // Reset balance and stats
    user.trenchPaperBalance = 1000;
    user.trenchPaperBalanceInitial = 1000;
    user.trenchStats = { wins: 0, losses: 0, totalPnl: 0, totalPnlPercent: 0, bestTrade: 0, worstTrade: 0, consecutiveLosses: 0, dailyPnlStart: 1000, dailyPnlStartAt: new Date() };
    user.trenchAuto = user.trenchAuto || {};
    user.trenchAuto.lastPausedAt = undefined;
    user.trenchAuto.pausedReason = '';
    await user.save({ validateBeforeSave: false });

    res.json({ success: true, trenchPaperBalance: 1000 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/bot/connect', requireAdmin, async (req, res) => {
  const { encrypt } = require('./services/trench-auto-trading');
  try {
    const { privateKeyBase58 } = req.body || {};
    if (!privateKeyBase58 || typeof privateKeyBase58 !== 'string') {
      return res.status(400).json({ error: 'Provide privateKeyBase58 (export from Phantom)' });
    }
    const bs58 = require('bs58');
    const { Keypair } = require('@solana/web3.js');
    const secretKey = bs58.decode(privateKeyBase58.trim());
    const kp = Keypair.fromSecretKey(secretKey);
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    user.trenchBot = {
      privateKeyEncrypted: encrypt(privateKeyBase58.trim()),
      publicKey: kp.publicKey.toBase58(),
      connected: true
    };
    await user.save();
    res.json({ success: true, publicKey: user.trenchBot.publicKey });
  } catch (e) {
    console.error('[TrenchWarfare] Bot connect failed:', e.message);
    res.status(400).json({ error: 'Invalid private key. Export base58 from Phantom.' });
  }
});

app.post('/api/trench-warfare/bot/disconnect', requireAdmin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  user.trenchBot = { privateKeyEncrypted: '', publicKey: '', connected: false };
  await user.save();
  res.json({ success: true });
});

app.post('/api/trench-warfare/auto/settings', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const b = req.body || {};
    if (b.enabled !== undefined) user.trenchAuto.enabled = !!b.enabled;
    if (b.strategy !== undefined) user.trenchAuto.strategy = b.strategy === 'memecoin' ? 'memecoin' : 'scalping';
    if (b.mode !== undefined) user.trenchAuto.mode = b.mode === 'live' ? 'live' : 'paper';
    if (b.maxOpenPositions !== undefined) user.trenchAuto.maxOpenPositions = Math.max(1, Math.min(15, Number(b.maxOpenPositions)));
    if (b.amountPerTradeUsd !== undefined) user.trenchAuto.amountPerTradeUsd = Math.max(5, Math.min(500, Number(b.amountPerTradeUsd)));
    if (b.amountPerTradeSol !== undefined) user.trenchAuto.amountPerTradeSol = Math.max(0.01, Math.min(1, Number(b.amountPerTradeSol)));
    const memecoin = (b.strategy || user.trenchAuto?.strategy) === 'memecoin';
    if (b.tpPercent !== undefined) user.trenchAuto.tpPercent = memecoin ? Math.max(1, Math.min(5, Number(b.tpPercent))) : Math.max(5, Math.min(50, Number(b.tpPercent)));
    if (b.slPercent !== undefined) user.trenchAuto.slPercent = memecoin ? Math.max(1, Math.min(5, Number(b.slPercent))) : Math.max(3, Math.min(30, Number(b.slPercent)));
    if (b.trailingStopPercent !== undefined) user.trenchAuto.trailingStopPercent = Math.max(1, Math.min(20, Number(b.trailingStopPercent)));
    if (b.useTrailingStop !== undefined) user.trenchAuto.useTrailingStop = !!b.useTrailingStop;
    if (b.useTrailingTP !== undefined) user.trenchAuto.useTrailingTP = !!b.useTrailingTP;
    if (b.breakevenAtPercent !== undefined) user.trenchAuto.breakevenAtPercent = Math.max(1, Math.min(15, Number(b.breakevenAtPercent)));
    if (b.useBreakevenStop !== undefined) user.trenchAuto.useBreakevenStop = !!b.useBreakevenStop;
    if (b.maxHoldMinutes !== undefined) user.trenchAuto.maxHoldMinutes = memecoin ? Math.max(2, Math.min(5, Number(b.maxHoldMinutes))) : Math.max(5, Math.min(15, Number(b.maxHoldMinutes)));
    if (b.minLiquidityUsd !== undefined) user.trenchAuto.minLiquidityUsd = Math.max(5000, Math.min(100000, Number(b.minLiquidityUsd)));
    if (b.maxTop10HoldersPercent !== undefined) user.trenchAuto.maxTop10HoldersPercent = Math.max(50, Math.min(100, Number(b.maxTop10HoldersPercent)));
    if (b.maxPriceChange24hPercent !== undefined) user.trenchAuto.maxPriceChange24hPercent = Math.max(100, Math.min(1000, Number(b.maxPriceChange24hPercent)));
    if (b.cooldownHours !== undefined) user.trenchAuto.cooldownHours = Math.max(0.25, Math.min(4, Number(b.cooldownHours)));
    if (b.useEntryFilters !== undefined) user.trenchAuto.useEntryFilters = !!b.useEntryFilters;
    if (b.maxDailyLossPercent !== undefined) user.trenchAuto.maxDailyLossPercent = Math.max(5, Math.min(50, Number(b.maxDailyLossPercent)));
    if (b.consecutiveLossesToPause !== undefined) user.trenchAuto.consecutiveLossesToPause = Math.max(2, Math.min(10, Number(b.consecutiveLossesToPause)));
    if (b.minSolBalance !== undefined) user.trenchAuto.minSolBalance = Math.max(0.01, Math.min(1, Number(b.minSolBalance)));
    if (b.profitPayoutAddress !== undefined) user.trenchAuto.profitPayoutAddress = String(b.profitPayoutAddress || '').trim();
    if (b.profitPayoutPercent !== undefined) user.trenchAuto.profitPayoutPercent = Math.max(0, Math.min(100, Number(b.profitPayoutPercent)));
    if (b.profitPayoutMinSol !== undefined) user.trenchAuto.profitPayoutMinSol = Math.max(0.01, Math.min(10, Number(b.profitPayoutMinSol)));
    if (b.trenchNotifyTradeOpen !== undefined) user.trenchAuto.trenchNotifyTradeOpen = !!b.trenchNotifyTradeOpen;
    if (b.trenchNotifyTradeClose !== undefined) user.trenchAuto.trenchNotifyTradeClose = !!b.trenchNotifyTradeClose;
    if (b.useKellySizing !== undefined) user.trenchAuto.useKellySizing = !!b.useKellySizing;
    if (b.themeFilterEnabled !== undefined) user.trenchAuto.themeFilterEnabled = !!b.themeFilterEnabled;
    if (b.marketSource !== undefined) {
      user.trenchAuto.marketSource = ['explorer', 'launches', 'trendings'].includes(b.marketSource) ? b.marketSource : 'trendings';
    }
    if (b.explorerCategoryId !== undefined) {
      user.trenchAuto.explorerCategoryId = String(b.explorerCategoryId || 'auto').trim() || 'auto';
    }
    if (b.useEngineConfirmation !== undefined) user.trenchAuto.useEngineConfirmation = !!b.useEngineConfirmation;
    if (b.engineMinScore !== undefined) user.trenchAuto.engineMinScore = Math.max(45, Math.min(95, Number(b.engineMinScore) || 58));
    if (b.enginePatternStrictness !== undefined) {
      const strict = String(b.enginePatternStrictness || 'light');
      user.trenchAuto.enginePatternStrictness = ['off', 'light', 'strict'].includes(strict) ? strict : 'light';
    }
    if (b.engineTopCandidates !== undefined) user.trenchAuto.engineTopCandidates = Math.max(5, Math.min(60, Number(b.engineTopCandidates) || 20));
    if (b.useTrailingTP !== undefined) user.trenchAuto.useTrailingTP = !!b.useTrailingTP;
    if (b.volumeFilterEnabled !== undefined) user.trenchAuto.volumeFilterEnabled = !!b.volumeFilterEnabled;
    if (b.volatilityFilterEnabled !== undefined) user.trenchAuto.volatilityFilterEnabled = !!b.volatilityFilterEnabled;
    if (b.minVolume24hUsd !== undefined) user.trenchAuto.minVolume24hUsd = Math.max(5000, Math.min(500000, Number(b.minVolume24hUsd) || 25000));
    if (b.maxVolatility24hPercent !== undefined) user.trenchAuto.maxVolatility24hPercent = Math.max(100, Math.min(1000, Number(b.maxVolatility24hPercent) || 400));
    if (b.minVolatility24hPercent !== undefined) user.trenchAuto.minVolatility24hPercent = Math.max(-80, Math.min(50, Number(b.minVolatility24hPercent) || -30));
    if (b.minOrganicScore !== undefined) user.trenchAuto.minOrganicScore = Math.max(0, Math.min(100, Number(b.minOrganicScore) || 0));
    if (b.minPoolAgeMinutes !== undefined) user.trenchAuto.minPoolAgeMinutes = Math.max(0, Math.min(60, Number(b.minPoolAgeMinutes) || 0));
    if (b.tradingHoursStartUTC !== undefined) user.trenchAuto.tradingHoursStartUTC = Math.max(0, Math.min(23, Number(b.tradingHoursStartUTC) || 0));
    if (b.tradingHoursEndUTC !== undefined) user.trenchAuto.tradingHoursEndUTC = Math.max(0, Math.min(24, Number(b.tradingHoursEndUTC) || 24));
    if (b.minProfitToActivateTrail !== undefined) user.trenchAuto.minProfitToActivateTrail = Math.max(0, Math.min(10, Number(b.minProfitToActivateTrail) || 0));
    if (b.minBuyPressure !== undefined) user.trenchAuto.minBuyPressure = Math.max(0.45, Math.min(0.65, Number(b.minBuyPressure) || 0.5));
    if (b.usePartialTP !== undefined) user.trenchAuto.usePartialTP = !!b.usePartialTP;
    if (b.requireSocials !== undefined) user.trenchAuto.requireSocials = !!b.requireSocials;
    await user.save();
    res.json({ success: true, trenchAuto: user.trenchAuto });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/blacklist/add', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const { tokenAddress } = req.body || {};
    if (!tokenAddress || typeof tokenAddress !== 'string') return res.status(400).json({ error: 'Missing tokenAddress' });
    const addr = tokenAddress.trim();
    if (!user.trenchBlacklist) user.trenchBlacklist = [];
    if (!user.trenchBlacklist.includes(addr)) {
      user.trenchBlacklist.push(addr);
      await user.save();
    }
    res.json({ success: true, trenchBlacklist: user.trenchBlacklist });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/blacklist/remove', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const { tokenAddress } = req.body || {};
    if (!tokenAddress || typeof tokenAddress !== 'string') return res.status(400).json({ error: 'Missing tokenAddress' });
    if (user.trenchBlacklist) {
      user.trenchBlacklist = user.trenchBlacklist.filter(a => a !== tokenAddress.trim());
      await user.save();
    }
    res.json({ success: true, trenchBlacklist: user.trenchBlacklist || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trench-warfare/analytics', requireAdmin, async (req, res) => {
  try {
    const ScalpTrade = require('./models/ScalpTrade');
    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const closed = await ScalpTrade.find({ userId: user._id, status: 'CLOSED' }).sort({ exitTime: -1 }).limit(100).lean();
    const stats = user.trenchStats || {};
    const initial = user.trenchPaperBalanceInitial ?? 1000;
    const current = user.trenchPaperBalance ?? 1000;
    const pnlPercent = initial > 0 ? (((current - initial) / initial) * 100).toFixed(2) : 0;

    // Compute real PnL from trade data (handles old trades with broken partial PnL)
    const closedAsc = [...closed].reverse().filter(t => t.exitTime);
    const computedTrades = closedAsc.map(t => {
      let realPnl = t.pnl || 0;
      if ((t.partialSoldAmount || 0) > 0 && (t.partialPnl || 0) === 0 && t.entryPrice > 0 && t.exitPrice > 0) {
        realPnl = ((t.exitPrice - t.entryPrice) / t.entryPrice) * (t.amountIn || 0);
      }
      return { ...t, _realPnl: realPnl };
    });

    const wins = computedTrades.filter(t => t._realPnl > 0);
    const losses = computedTrades.filter(t => t._realPnl <= 0);
    const totalTrades = computedTrades.length;
    const computedWinRate = totalTrades > 0 ? ((wins.length / totalTrades) * 100).toFixed(1) : 0;
    const grossProfit = wins.reduce((s, t) => s + t._realPnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t._realPnl, 0));
    const totalPnlComputed = grossProfit - grossLoss;

    const startDate = closedAsc.length > 0 ? new Date(closedAsc[0].createdAt || closedAsc[0].exitTime).toISOString() : new Date().toISOString();
    const equityCurve = [{ equity: initial, date: startDate, drawdown: 0, drawdownPct: 0 }];
    let peak = initial;
    let maxDrawdownPct = 0;
    for (const t of computedTrades) {
      const prev = equityCurve[equityCurve.length - 1].equity;
      const next = prev + t._realPnl;
      if (next > peak) peak = next;
      const dd = Math.max(0, peak - next);
      const ddPct = peak > 0 ? (dd / peak * 100) : 0;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
      equityCurve.push({
        equity: next,
        date: t.exitTime,
        drawdown: dd,
        drawdownPct: Math.round(ddPct * 10) / 10
      });
    }
    if (equityCurve.length > 1) {
      equityCurve[equityCurve.length - 1].drawdownPct = Math.round(maxDrawdownPct * 10) / 10;
    }

    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? '∞' : '0');
    const avgWin = wins.length > 0 ? (grossProfit / wins.length).toFixed(2) : 0;
    const avgLoss = losses.length > 0 ? (grossLoss / losses.length).toFixed(2) : 0;
    const expectancy = totalTrades > 0 ? ((wins.length * parseFloat(avgWin) - losses.length * parseFloat(avgLoss)) / totalTrades) : 0;

    res.json({
      trenchStats: stats,
      winRate: parseFloat(computedWinRate),
      totalTrades,
      totalPnl: totalPnlComputed,
      pnlPercent: parseFloat(pnlPercent),
      bestTrade: Math.max(stats.bestTrade || 0, wins.length > 0 ? Math.max(...wins.map(w => w._realPnl)) : 0),
      worstTrade: Math.min(stats.worstTrade || 0, losses.length > 0 ? Math.min(...losses.map(l => l._realPnl)) : 0),
      consecutiveLosses: stats.consecutiveLosses || 0,
      closedTrades: closed,
      equityCurve: equityCurve.length > 1 ? equityCurve : [],
      profitFactor,
      avgWin: parseFloat(avgWin),
      avgLoss: parseFloat(avgLoss),
      expectancy: Math.round(expectancy * 100) / 100,
      maxDrawdownPct: equityCurve.length > 1 ? (equityCurve[equityCurve.length - 1].drawdownPct || 0) : 0,
      paused: !!user.trenchAuto?.lastPausedAt,
      pausedReason: user.trenchAuto?.pausedReason || ''
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trench-warfare/positions', requireAdmin, async (req, res) => {
  try {
    const ScalpTrade = require('./models/ScalpTrade');
    const dexscreener = require('./services/dexscreener-api');
    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const open = await ScalpTrade.find({ userId: user._id, status: 'OPEN' }).lean();
    if (open.length === 0) return res.json({ positions: [] });

    const addresses = open.map(p => p.tokenAddress);
    let prices = {};
    try {
      const pairs = await dexscreener.fetchTokensBulk('solana', addresses);
      for (const p of pairs) {
        if (p.tokenAddress && p.price > 0) prices[p.tokenAddress] = p.price;
      }
    } catch (e) { /* ignore */ }

    const hasLive = open.some(p => !p.isPaper);
    let solPriceUsd = 0;
    if (hasLive) {
      const sol = getCurrentPrice('solana');
      solPriceUsd = sol && Number.isFinite(sol.price) && sol.price > 0 ? sol.price : 0;
    }
    const positions = open.map(p => {
      const currentPrice = prices[p.tokenAddress] || 0;
      const pnlPct = currentPrice > 0 && p.entryPrice > 0 ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      const currentValue = (p.tokenAmount || 0) * currentPrice;
      let pnl;
      let costDisplay = p.amountIn;
      if (p.isPaper) {
        pnl = currentValue - (p.amountIn || 0);
      } else {
        const costUsd = solPriceUsd > 0 ? (p.amountIn || 0) * solPriceUsd : 0;
        pnl = costUsd > 0 ? currentValue - costUsd : 0;
        costDisplay = solPriceUsd > 0 ? costUsd : p.amountIn;
      }
      const holdMinutes = (Date.now() - new Date(p.createdAt).getTime()) / 60000;
      return {
        _id: p._id,
        tokenAddress: p.tokenAddress,
        tokenSymbol: p.tokenSymbol,
        tokenAmount: p.tokenAmount,
        entryPrice: p.entryPrice,
        currentPrice,
        amountIn: p.amountIn,
        costUsd: costDisplay,
        currentValue,
        pnl,
        pnlPct,
        holdMinutes: Math.round(holdMinutes),
        isPaper: p.isPaper,
        peakPrice: p.peakPrice || p.entryPrice
      };
    });
    res.json({ positions, paperBalance: user.trenchPaperBalance ?? 1000 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/unpause', requireAdmin, async (req, res) => {
  try {
    await User.updateOne({ _id: req.session.userId }, {
      $set: {
        'trenchAuto.pausedReason': '',
        'trenchStats.consecutiveLosses': 0
      },
      $unset: {
        'trenchAuto.lastPausedAt': 1
      }
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/auto/start', requireAdmin, async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Not logged in' });
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.trenchAuto) user.trenchAuto = {};
    user.trenchAuto.enabled = true;
    user.trenchAuto.mode = (req.body?.mode || user.trenchAuto.mode || 'paper');
    if (req.body?.strategy) user.trenchAuto.strategy = req.body.strategy === 'memecoin' ? 'memecoin' : 'scalping';
    user.trenchAuto.lastPausedAt = null;
    user.trenchAuto.pausedReason = '';
    user.trenchAuto.lastStartedAt = new Date();
    await user.save({ validateBeforeSave: false });
    const trenchAuto = require('./services/trench-auto-trading');
    if (IS_PRIMARY_WORKER) {
      const result = await trenchAuto.startBot(userId);
      res.json({ success: true, ...result });
    } else {
      res.json({ success: true, started: true, message: 'Bot enabled — starting on primary worker' });
    }
  } catch (e) {
    console.error('[TrenchBot] Start error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/auto/stop', requireAdmin, async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Not logged in' });
    const user = await User.findById(userId);
    if (user) {
      user.trenchAuto.enabled = false;
      await user.save({ validateBeforeSave: false });
    }
    const trenchAuto = require('./services/trench-auto-trading');
    const result = trenchAuto.stopBot(userId);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trench-warfare/auto/status', requireAdmin, async (req, res) => {
  try {
    const trenchAuto = require('./services/trench-auto-trading');
    const status = await trenchAuto.getBotStatusWithDb(req.session.userId);
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/auto/run-now', requireAdmin, async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Not logged in' });
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.trenchAuto) user.trenchAuto = {};
    user.trenchAuto.enabled = true;
    user.trenchAuto.mode = (req.body?.mode || user.trenchAuto.mode || 'paper');
    await user.save({ validateBeforeSave: false });
    const trenchAuto = require('./services/trench-auto-trading');
    if (IS_PRIMARY_WORKER) {
      const result = await trenchAuto.startBot(userId);
      res.json({ success: true, ...result });
    } else {
      res.json({ success: true, started: true, message: 'Bot enabled — starting on primary worker' });
    }
  } catch (e) {
    console.error('[TrenchBot] Run-now error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trench-warfare/auto/debug', requireAdmin, async (req, res) => {
  try {
    const dexscreener = require('./services/dexscreener-api');
    const User = require('./models/User');
    const ScalpTrade = require('./models/ScalpTrade');
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const trendings = await dexscreener.fetchSolanaTrendings(500);
    const openCount = await ScalpTrade.countDocuments({ userId: user._id, status: 'OPEN' });
    const balance = user.trenchPaperBalance ?? 1000;
    const settings = user.trenchAuto || {};
    const amountPerTrade = settings.amountPerTradeUsd ?? 50;
    const maxPos = settings.maxOpenPositions ?? 3;
    const canBuy = balance >= amountPerTrade && openCount < maxPos;
    const trenchAuto = require('./services/trench-auto-trading');
    const botStatus = trenchAuto.getBotStatus(req.session.userId);
    res.json({
      trendings: trendings.length,
      sample: trendings[0],
      balance,
      openCount,
      maxPositions: maxPos,
      amountPerTrade,
      canBuy,
      autoEnabled: !!settings.enabled,
      mode: settings.mode,
      botRunning: botStatus.running
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trench/live', requireAdmin, async (req, res) => {
  try {
    const dexscreener = require('./services/dexscreener-api');
    const trendings = await dexscreener.fetchSolanaTrendings(150);
    res.json({ success: true, count: trendings.length, data: trendings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Failed to fetch live trench data' });
  }
});

async function handleTrenchSwapSend(req, res) {
  const mobula = require('./services/mobula-api');
  const ScalpTrade = require('./models/ScalpTrade');
  try {
    const { signedTransaction, tokenAddress, tokenSymbol, tokenName, amountIn, side, walletAddress } = req.body || {};
    if (!signedTransaction) {
      return res.status(400).json({ error: 'Missing signedTransaction' });
    }
    const result = await mobula.sendSwapTransaction('solana', signedTransaction);
    const data = result.data || result;
    if (data.success && data.transactionHash && (tokenAddress || tokenSymbol)) {
      try {
        await ScalpTrade.create({
          userId: req.session?.userId || null,
          walletAddress: walletAddress || '',
          tokenAddress: tokenAddress || '',
          tokenSymbol: tokenSymbol || '',
          tokenName: tokenName || '',
          side: side || 'BUY',
          amountIn: amountIn || 0,
          amountOut: 0,
          txHash: data.transactionHash,
          status: 'CONFIRMED'
        });
      } catch (logErr) {
        console.warn('[TrenchWarfare] ScalpTrade log failed:', logErr.message);
      }
    }
    return res.json(result);
  } catch (e) {
    console.error('[TrenchWarfare] Swap send failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

app.post('/api/trench-warfare/swap/send', requireAdmin, heavyJobLimiter, handleTrenchSwapSend);
app.post('/api/trench/buy', requireAdmin, heavyJobLimiter, handleTrenchSwapSend);
app.post('/api/trench/sell', requireAdmin, heavyJobLimiter, handleTrenchSwapSend);
app.get('/api/trench/positions', requireAdmin, async (req, res) => {
  try {
    const ScalpTrade = require('./models/ScalpTrade');
    const open = await ScalpTrade.find({ userId: req.session.userId, status: 'OPEN', isPaper: { $ne: true } }).lean();
    return res.json({ positions: open });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ====================================================
// LEARNING ENGINE - Optimize weights (optional, apply only if improved)
// ====================================================
app.post('/api/learning/optimize/:strategyId', requireLogin, async (req, res) => {
  try {
    const { strategyId } = req.params;
    const { apply } = req.body || {};
    const closedTrades = await Trade.find({ userId: req.session.userId, status: { $ne: 'OPEN' } }).lean();
    const strategy = await StrategyWeight.findOne({ strategyId }).lean();
    if (!strategy) return res.json({ success: false, error: 'Strategy not found' });

    const { optimizeWeights } = require('./services/weight-optimizer');
    const result = optimizeWeights(strategyId, closedTrades, strategy.weights || {}, { maxIterations: 30 });

    if (result.error) return res.json({ success: false, error: result.error });

    if (result.improved && apply === 'true') {
      await StrategyWeight.updateOne(
        { strategyId },
        { $set: { weights: result.weights, updatedAt: new Date() } }
      );
    }

    res.json({
      success: true,
      weights: result.weights,
      fitness: result.fitness,
      baseFitness: result.baseFitness,
      improved: result.improved,
      applied: result.improved && apply === 'true'
    });
  } catch (err) {
    console.error('[Learning Optimize] Error:', err);
    res.json({ success: false, error: err.message });
  }
});

// ====================================================
// LEARNING ENGINE DASHBOARD (public - shows strategy performance)
// ====================================================
app.get('/learning', async (req, res) => {
  try {
    const allStrategies = await StrategyWeight.find({}).lean();
    const strategies = allStrategies.map(s => {
      const perf = s.performance || {};
      return {
        id: s.strategyId,
        name: s.name,
        description: s.description || '',
        winRate: (perf.winRate ?? 0).toFixed(1),
        avgRR: (perf.avgRR ?? 0).toFixed(2),
        totalTrades: perf.totalTrades || 0,
        wins: perf.wins || 0,
        losses: perf.losses || 0,
        weights: s.weights || {},
        byRegime: perf.byRegime || {},
        active: s.active,
        updatedAt: s.updatedAt
      };
    });

    // User-specific trade counts: Optimize button needs 10+ trades for THIS user's strategy
    let userTradeCounts = {};
    if (req.session?.userId) {
      const closedTrades = await Trade.find({ userId: req.session.userId, status: { $ne: 'OPEN' } })
        .select('strategyType').lean();
      const STRATEGY_ALIAS = { mean_reversion: 'mean_revert' };
      closedTrades.forEach(t => {
        const sid = STRATEGY_ALIAS[t.strategyType] || t.strategyType;
        if (sid) userTradeCounts[sid] = (userTradeCounts[sid] || 0) + 1;
      });
    }

    const user = req.session?.userId ? await User.findById(req.session.userId).lean() : null;
    res.render('learning', { activePage: 'learning', strategies, user, userTradeCounts });
  } catch (err) {
    console.error('[Learning] Error:', err);
    res.render('learning', { activePage: 'learning', strategies: [], user: null, userTradeCounts: {} });
  }
});

// ====================================================
// JSON API ENDPOINTS
// ====================================================
app.get('/api/signals', async (req, res) => {
  try {
    const [prices, allCandles, allHistory] = await Promise.all([
      fetchAllPrices(),
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory()
    ]);
    const pricesMerged = mergeWebSocketPrices(prices);
    const options = await buildEngineOptions(pricesMerged, allCandles, allHistory);
    const signals = analyzeAllCoins(pricesMerged, allCandles, allHistory, options);
    res.json({ success: true, generated: new Date().toISOString(), count: signals.length, signals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/signals/all', requireLogin, requirePro, async (req, res) => {
  try {
    const [prices, allCandles, allHistory] = await Promise.all([
      fetchAllPrices(),
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory()
    ]);
    const pricesMerged = mergeWebSocketPrices(prices);
    const options = await buildEngineOptions(pricesMerged, allCandles, allHistory, req.subscriptionUser || null);
    const signals = analyzeAllCoins(pricesMerged, allCandles, allHistory, options);
    res.json({ success: true, generated: new Date().toISOString(), count: signals.length, signals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/signals/elite', requireLogin, requireElite, async (req, res) => {
  try {
    const [prices, allCandles, allHistory] = await Promise.all([
      fetchAllPrices(),
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory()
    ]);
    const pricesMerged = mergeWebSocketPrices(prices);
    const options = await buildEngineOptions(pricesMerged, allCandles, allHistory, req.subscriptionUser || null);
    const signals = analyzeAllCoins(pricesMerged, allCandles, allHistory, options)
      .filter((s) => Number(s.score || 0) >= 70);
    res.json({ success: true, generated: new Date().toISOString(), count: signals.length, signals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/prices', async (req, res) => {
  try {
    let prices = await fetchAllPrices();
    prices = mergeWebSocketPrices(prices);
    // Overlay live exchange prices for coins with open trades so PnL doesn't flash stale values
    if (req.session && req.session.userId) {
      try {
        const openTrades = await getOpenTrades(req.session.userId);
        if (openTrades.length > 0) {
          const coinIds = [...new Set(openTrades.map(t => t.coinId))];
          // Re-register scanner meta for non-tracked coins so fetchLivePrice works
          for (const t of openTrades) {
            if (!TRACKED_COINS.includes(t.coinId) && !getCoinMeta(t.coinId) && t.symbol) {
              registerScannerCoinMeta(t.coinId, t.symbol);
            }
          }
          const livePrices = await Promise.all(coinIds.map(id => fetchLivePrice(id)));
          for (let i = 0; i < coinIds.length; i++) {
            if (livePrices[i] != null && Number.isFinite(livePrices[i]) && livePrices[i] > 0) {
              const idx = prices.findIndex(p => p.id === coinIds[i]);
              if (idx >= 0) {
                prices[idx] = { ...prices[idx], price: livePrices[i] };
              } else {
                const trade = openTrades.find(t => t.coinId === coinIds[i]);
                prices.push({ id: coinIds[i], symbol: trade?.symbol || coinIds[i].toUpperCase(), price: livePrices[i] });
              }
            }
          }
        }
      } catch (e) { /* fall through with cached prices */ }
    }
    res.json({ success: true, data: prices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/trades/active', requireLogin, async (req, res) => {
  try {
    const trades = await Trade.find({ userId: req.session.userId, status: 'OPEN' })
      .select('_id coinId direction entryPrice stopLoss originalStopLoss actions positionSize originalPositionSize margin partialPnl leverage isLive executionStatus bitgetSymbol')
      .lean();
    const map = {};
    trades.forEach(t => { map[t._id.toString()] = t; });
    res.json({ success: true, trades: map });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/trade/execute', requireLogin, requirePro, async (req, res) => {
  try {
    const coinId = String(req.body?.coinId || '').trim();
    const symbol = String(req.body?.symbol || coinId || '').trim().toUpperCase();
    const direction = String(req.body?.direction || '').toUpperCase();
    if (!coinId || !['LONG', 'SHORT'].includes(direction)) {
      return res.status(400).json({ success: false, error: 'coinId and direction (LONG/SHORT) are required' });
    }
    const entryPrice = Number(req.body?.entryPrice);
    const stopLoss = Number(req.body?.stopLoss);
    const takeProfit1 = Number(req.body?.takeProfit1);
    if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit1)) {
      return res.status(400).json({ success: false, error: 'entryPrice, stopLoss, takeProfit1 are required numbers' });
    }
    const tradeData = {
      coinId,
      symbol,
      direction,
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2: Number.isFinite(Number(req.body?.takeProfit2)) ? Number(req.body.takeProfit2) : undefined,
      takeProfit3: Number.isFinite(Number(req.body?.takeProfit3)) ? Number(req.body.takeProfit3) : undefined,
      margin: Number(req.body?.margin) || undefined,
      leverage: Number(req.body?.leverage) || undefined,
      score: Number(req.body?.score) || undefined,
      strategyType: String(req.body?.strategyType || '').trim() || undefined,
      signal: String(req.body?.signal || '').trim() || undefined
    };
    const trade = await openTrade(req.session.userId, tradeData);
    return res.json({ success: true, trade });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || 'Trade execution failed' });
  }
});

// PATCH /api/trades/:tradeId/levels — update SL, TP1, TP2, TP3 (chart live modify)
app.patch('/api/trades/:tradeId/levels', requireLogin, async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { stopLoss, takeProfit1, takeProfit2, takeProfit3 } = req.body || {};
    const trade = await Trade.findOne({ _id: tradeId, userId: req.session.userId, status: 'OPEN' });
    if (!trade) {
      return res.status(404).json({ success: false, error: 'Trade not found' });
    }
    const update = {};
    const entry = trade.entryPrice;
    const isLong = trade.direction === 'LONG';
    if (stopLoss != null && Number.isFinite(stopLoss)) {
      if (isLong && stopLoss >= entry) return res.status(400).json({ success: false, error: 'SL must be below entry for LONG' });
      if (!isLong && stopLoss <= entry) return res.status(400).json({ success: false, error: 'SL must be above entry for SHORT' });
      update.stopLoss = stopLoss;
    }
    if (takeProfit1 != null && Number.isFinite(takeProfit1)) {
      if (isLong && takeProfit1 <= entry) return res.status(400).json({ success: false, error: 'TP1 must be above entry for LONG' });
      if (!isLong && takeProfit1 >= entry) return res.status(400).json({ success: false, error: 'TP1 must be below entry for SHORT' });
      update.takeProfit1 = takeProfit1;
    }
    if (takeProfit2 != null && Number.isFinite(takeProfit2)) {
      if (isLong && takeProfit2 <= entry) return res.status(400).json({ success: false, error: 'TP2 must be above entry for LONG' });
      if (!isLong && takeProfit2 >= entry) return res.status(400).json({ success: false, error: 'TP2 must be below entry for SHORT' });
      update.takeProfit2 = takeProfit2;
    }
    if (takeProfit3 != null && Number.isFinite(takeProfit3)) {
      if (isLong && takeProfit3 <= entry) return res.status(400).json({ success: false, error: 'TP3 must be above entry for LONG' });
      if (!isLong && takeProfit3 >= entry) return res.status(400).json({ success: false, error: 'TP3 must be below entry for SHORT' });
      update.takeProfit3 = takeProfit3;
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid levels to update' });
    }
    update.updatedAt = new Date();
    await Trade.updateOne({ _id: tradeId, userId: req.session.userId }, { $set: update });
    res.json({ success: true, updated: update });
  } catch (err) {
    console.error('[PatchTradeLevels] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/trade-scores', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.json({ success: true, scoreChecks: {} });
    }
    const trades = await Trade.find({ userId: req.session.userId, status: 'OPEN' }).lean();
    const scoreChecks = {};
    const scoreHistories = {};
    trades.forEach(t => {
      scoreChecks[t._id.toString()] = t.scoreCheck || null;
      scoreHistories[t._id.toString()] = t.scoreHistory || [];
    });
    res.json({ success: true, scoreChecks, scoreHistories });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    dataReady: isDataReady(),
    coins: TRACKED_COINS.length,
    version: '3.0.0'
  });
});

// Diagnostic: test API connectivity from this server (GET /api/connectivity-test)
app.get('/api/connectivity-test', async (req, res) => {
  const fetch = require('node-fetch');
  const results = { nodeVersion: process.version, env: process.env.NODE_ENV || 'development', timestamp: new Date().toISOString() };

  // Test Bitget HTTP API
  try {
    const t = Date.now();
    const r = await fetch('https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1H&limit=3', {
      headers: { 'Accept': 'application/json' }, timeout: 10000
    });
    const body = await r.text();
    results.bitget = {
      ok: r.ok, status: r.status, latencyMs: Date.now() - t,
      bodyLength: body.length, bodyPreview: body.substring(0, 200)
    };
    try { const j = JSON.parse(body); results.bitget.code = j.code; results.bitget.candles = j.data?.length || 0; } catch(e) {}
  } catch (err) {
    results.bitget = { ok: false, error: err.message, code: err.code, type: err.type };
  }

  // Test Kraken HTTP API
  try {
    const t = Date.now();
    const r = await fetch('https://api.kraken.com/0/public/OHLC?pair=XXBTZUSD&interval=60', {
      headers: { 'Accept': 'application/json' }, timeout: 10000
    });
    const body = await r.text();
    results.kraken = {
      ok: r.ok, status: r.status, latencyMs: Date.now() - t,
      bodyLength: body.length, bodyPreview: body.substring(0, 200)
    };
    try { const j = JSON.parse(body); results.kraken.errors = j.error; const keys = Object.keys(j.result||{}).filter(k=>k!=='last'); results.kraken.candles = keys.length > 0 ? j.result[keys[0]]?.length : 0; } catch(e) {}
  } catch (err) {
    results.kraken = { ok: false, error: err.message, code: err.code, type: err.type };
  }

  // Test DNS resolution
  const dns = require('dns');
  await new Promise(resolve => {
    dns.resolve4('api.bitget.com', (err, addresses) => {
      results.dns_bitget = err ? { error: err.message, code: err.code } : { resolved: addresses };
      resolve();
    });
  });
  await new Promise(resolve => {
    dns.resolve4('api.kraken.com', (err, addresses) => {
      results.dns_kraken = err ? { error: err.message, code: err.code } : { resolved: addresses };
      resolve();
    });
  });

  console.log('[Connectivity-Test]', JSON.stringify(results));
  res.json(results);
});
// Keep old route as alias
app.get('/api/bitget-test', (req, res) => res.redirect('/api/connectivity-test'));

// Backtest job queue — runs backtests in background to avoid gateway timeouts
const backtestJobs = new Map();
const latestBacktestResultByUser = new Map();
const BACKTEST_JOB_TTL = 30 * 60 * 1000; // keep results for 30 min
const MAX_RUNNING_BACKTEST_JOBS = Number(process.env.MAX_RUNNING_BACKTEST_JOBS || 1);
const MAX_BACKTEST_COINS = Number(process.env.MAX_BACKTEST_COINS || 10);
const MAX_SMC_BACKTEST_COINS = Number(process.env.MAX_SMC_BACKTEST_COINS || 12);
const BACKTEST_QUEUE_CONCURRENCY = Number(process.env.BACKTEST_QUEUE_CONCURRENCY || 10);
const BACKTEST_QUEUE_MAX_WAITING = Number(process.env.BACKTEST_QUEUE_MAX_WAITING || 50);
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
let backtestQueue = null;
let backtestQueueEnabled = false;

function buildBacktestOptions(payload) {
  return {
    coins: payload.coinsToRun,
    primaryTf: payload.safePrimaryTf,
    minScore: payload.minScore,
    leverage: payload.leverage,
    initialBalance: payload.initialBalance,
    riskMode: payload.riskMode,
    riskPerTrade: payload.riskPerTrade,
    riskDollarsPerTrade: payload.riskDollarsPerTrade,
    capitalMode: payload.capitalMode,
    features: payload.features || {},
    strategyWeights: payload.strategyWeights || [],
    strategyStats: payload.strategyStats || {},
    coinWeights: payload.coinWeights || {},
    disabledRegimesByCoin: payload.disabledRegimesByCoin || {},
    maxOpenTrades: payload.maxOpenTrades,
    coinWeightStrength: payload.coinWeightStrength
  };
}

async function runSmcMultiBacktestJob(job) {
  const payload = job.data || {};
  const { setupId, startMs, endMs, btOpts, coins } = payload;
  const { runSetupBacktest } = require('./services/smc-backtest');
  const SMC_BATCH_SIZE = 3;
  const SMC_PER_COIN_TIMEOUT = 120000;

  const allTrades = [];
  const perCoin = [];
  const totalEquity = 10000 * coins.length;
  let totalPnl = 0;
  let completed = 0;

  for (let i = 0; i < coins.length; i += SMC_BATCH_SIZE) {
    const batch = coins.slice(i, i + SMC_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(cid =>
        Promise.race([
          runSetupBacktest(cid, setupId, startMs, endMs, { ...btOpts }),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout: ${cid}`)), SMC_PER_COIN_TIMEOUT))
        ])
      )
    );
    for (let j = 0; j < batchResults.length; j++) {
      completed++;
      const r = batchResults[j];
      const cid = batch[j];
      if (r.status === 'rejected' || r.value?.error) continue;
      const v = r.value;
      const s = v.summary || {};
      if (s.totalTrades > 0) {
        allTrades.push(...(v.trades || []).map(t => ({ ...t, coinId: cid })));
        totalPnl += s.totalPnl || 0;
        perCoin.push({ coinId: cid, ...s });
      }
    }
    try { job.progress({ message: `Processed ${completed}/${coins.length} coins...` }); } catch (_) {}
    if (i + SMC_BATCH_SIZE < coins.length) await new Promise(r => setTimeout(r, 300));
  }

  const wins = allTrades.filter(t => t.pnl > 0).length;
  const losses = allTrades.filter(t => t.pnl <= 0).length;
  const grossProfit = allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const finalBalance = totalEquity + totalPnl;
  const { computeMaxDrawdownPct } = require('./services/backtest/analytics');
  const sortedByExit = [...allTrades].sort((a, b) => (a.exitTime || 0) - (b.exitTime || 0));
  const equityCurve = [{ equity: totalEquity, date: 0 }];
  let eq = totalEquity;
  for (const t of sortedByExit) {
    eq += t.pnl || 0;
    equityCurve.push({ equity: Math.max(0, eq), date: t.exitTime || 0 });
  }
  const maxDrawdownPct = equityCurve.length > 1 ? computeMaxDrawdownPct(equityCurve) : 0;

  return {
    success: true,
    summary: {
      totalTrades: allTrades.length, wins, losses,
      winRate: allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0,
      totalPnl, totalPnlPercent: (totalPnl / totalEquity) * 100,
      profitFactor, maxDrawdownPct,
      initialBalance: totalEquity, finalBalance,
      setupId, coinsRun: coins.length, coinsWithTrades: perCoin.length
    },
    trades: allTrades.slice(0, 500), perCoin, multiCoin: true
  };
}

async function runBacktestQueueJob(job) {
  const payload = job.data || {};
  if (payload.type === 'smc_multi') {
    return runSmcMultiBacktestJob(job);
  }
  const options = buildBacktestOptions(payload);
  options.onProgress = (msg) => {
    try {
      job.progress({ message: String(msg || '') });
    } catch (_) {}
  };
  const result = await runBacktest(payload.startMs, payload.endMs, options);
  return { success: true, ...result };
}

try {
  backtestQueue = new Queue('backtests', {
    redis: { host: REDIS_HOST, port: REDIS_PORT },
    settings: {
      stalledInterval: 60000,
      maxStalledCount: 2
    }
  });
  backtestQueueEnabled = true;
  backtestQueue.on('error', (err) => {
    console.error('[BacktestQueue] Redis queue error:', err.message);
  });
  backtestQueue.on('stalled', (jobId) => {
    console.warn(`[BacktestQueue] Job ${jobId} stalled and will be retried`);
  });
  if (IS_PRIMARY_WORKER) {
    backtestQueue.process(BACKTEST_QUEUE_CONCURRENCY, runBacktestQueueJob);
  }
  console.log(`[BacktestQueue] Enabled (primary=${IS_PRIMARY_WORKER}) concurrency=${BACKTEST_QUEUE_CONCURRENCY} redis=${REDIS_HOST}:${REDIS_PORT}`);
} catch (err) {
  backtestQueueEnabled = false;
  console.warn('[BacktestQueue] Disabled, falling back to in-process jobs:', err.message);
}

function countRunningBacktestJobs() {
  let n = 0;
  for (const [, job] of backtestJobs) {
    if (job?.status === 'running') n++;
  }
  return n;
}

trackInterval(() => {
  const now = Date.now();
  for (const [id, job] of backtestJobs) {
    if (now - job.createdAt > BACKTEST_JOB_TTL) backtestJobs.delete(id);
  }
  for (const [uid, snap] of latestBacktestResultByUser) {
    if (!snap || !snap.at || (now - snap.at) > BACKTEST_JOB_TTL) latestBacktestResultByUser.delete(uid);
  }
}, 5 * 60 * 1000);

// Backtest API (historical simulation) — async background job pattern
// POST starts the job and returns a jobId; client polls GET /api/backtest/status/:jobId
app.post('/api/backtest', requireLogin, requireProForLargeBacktest, heavyJobLimiter, backtestLimiter, async (req, res) => {
  try {
    if (!backtestQueueEnabled) {
      if (countRunningBacktestJobs() >= MAX_RUNNING_BACKTEST_JOBS) {
        return res.status(429).json({ error: 'Backtest queue is busy. Please wait for current run to finish.' });
      }
    } else {
      const [activeCount, waitingCount] = await Promise.all([
        backtestQueue.getActiveCount(),
        backtestQueue.getWaitingCount()
      ]);
      if ((activeCount + waitingCount) >= BACKTEST_QUEUE_MAX_WAITING) {
        return res.status(429).json({
          error: 'Server busy',
          message: 'Too many backtests queued, try again in a few minutes'
        });
      }
    }
    const { coinId, startDate, endDate, coins, minScore, leverage, features, primaryTf } = req.body || {};
    const VALID_TFS = ['15m', '1h', '4h', '1d', '1w'];
    const safePrimaryTf = VALID_TFS.includes(primaryTf) ? primaryTf : '1h';
    const startMs = startDate ? new Date(startDate).getTime() : Date.now() - 90 * 24 * 60 * 60 * 1000;
    const endMs = endDate ? new Date(endDate).getTime() : Date.now();
    if (isNaN(startMs) || isNaN(endMs)) {
      return res.status(400).json({ error: 'Invalid date range. Please select valid start and end dates.' });
    }
    if (startMs >= endMs) {
      return res.status(400).json({ error: 'Start date must be before end date' });
    }
    let coinsToRun = coins && Array.isArray(coins) ? coins : (coinId ? [coinId] : undefined);
    if (!coinsToRun && TRACKED_COINS) {
      coinsToRun = TRACKED_COINS.slice(0, 3);
    }
    coinsToRun = Array.isArray(coinsToRun) ? [...new Set(coinsToRun)].slice(0, MAX_BACKTEST_COINS) : [];

    let strategyWeights = [];
    let strategyStats = {};
    let excludedCoins = [];
    let coinWeights = {};
    let disabledRegimesByCoin = {};
    let maxOpenTrades = 3;
    let coinWeightStrength = 'moderate';
    const DB_TIMEOUT_MS = 5000;
    const dbTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), DB_TIMEOUT_MS));
    const userPromise = req.session?.userId
      ? User.findById(req.session.userId).select('excludedCoins coinWeights coinWeightEnabled coinWeightStrength settings disabledRegimesByCoin').lean()
      : Promise.resolve(null);
    const swPromise = StrategyWeight.find({ active: true }).lean();
    try {
      const [user, sw] = await Promise.race([
        Promise.all([userPromise, swPromise]),
        dbTimeout.then(() => [null, null])
      ]);
      if (user) {
        excludedCoins = user.excludedCoins || [];
        coinWeights = user.coinWeights || {};
        disabledRegimesByCoin = user.disabledRegimesByCoin || {};
        maxOpenTrades = user.settings?.maxOpenTrades ?? 3;
        coinWeightStrength = user.coinWeightStrength || 'moderate';
      }
      if (sw) {
        strategyWeights = sw;
        strategyStats = {};
        strategyWeights.forEach(s => {
          strategyStats[s.strategyId] = { totalTrades: s.performance?.totalTrades || 0 };
        });
      }
    } catch (e) { /* non-fatal: use defaults */ }

    if (excludedCoins.length > 0) {
      const excludeSet = new Set(excludedCoins);
      coinsToRun = coinsToRun.filter(c => !excludeSet.has(c));
    }
    if (coinsToRun.length === 0) {
      return res.status(400).json({ error: 'All selected coins are excluded. Add coins in Performance settings.' });
    }

    const payload = {
      ownerId: String(req.session.userId),
      startMs,
      endMs,
      coinsToRun,
      safePrimaryTf,
      coins: coinsToRun,
      minScore: minScore != null ? Number(minScore) : undefined,
      leverage: leverage != null ? Number(leverage) : undefined,
      initialBalance: req.body.initialBalance != null ? Number(req.body.initialBalance) : undefined,
      riskMode: req.body.riskMode === 'dollar' ? 'dollar' : 'percent',
      riskPerTrade: req.body.riskPerTrade != null ? Number(req.body.riskPerTrade) : undefined,
      riskDollarsPerTrade: req.body.riskDollarsPerTrade != null ? Number(req.body.riskDollarsPerTrade) : undefined,
      capitalMode: req.body.capitalMode === 'shared' ? 'shared' : 'perCoin',
      features: features || {},
      strategyWeights,
      strategyStats,
      coinWeights,
      disabledRegimesByCoin,
      maxOpenTrades,
      coinWeightStrength
    };
    if (backtestQueueEnabled) {
      const [activeCount, waitingCount] = await Promise.all([
        backtestQueue.getActiveCount(),
        backtestQueue.getWaitingCount()
      ]);
      const position = activeCount + waitingCount + 1;
      const queueJob = await backtestQueue.add(payload, {
        timeout: 300000,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false
      });
      return res.json({
        jobId: String(queueJob.id),
        status: 'queued',
        position,
        message: position === 1 ? 'Starting now...' : `Position ${position} in queue - est. ${Math.max(1, position - 1) * 30}s wait`
      });
    }

    const jobId = crypto.randomBytes(12).toString('hex');
    const job = {
      id: jobId,
      ownerId: String(req.session.userId),
      status: 'running',
      progress: `Starting backtest for ${coinsToRun.length} coin(s)...`,
      coins: coinsToRun,
      createdAt: Date.now(),
      result: null,
      error: null
    };
    backtestJobs.set(jobId, job);
    const options = buildBacktestOptions(payload);
    options.onProgress = (msg) => { job.progress = msg; };
    runBacktest(startMs, endMs, options)
      .then(result => {
        job.status = 'done';
        job.progress = 'Complete';
        job.result = { success: true, ...result };
        job.finishedAt = Date.now();
        console.log(`[Backtest] Job ${jobId} completed in ${((job.finishedAt - job.createdAt) / 1000).toFixed(1)}s`);
      })
      .catch(err => {
        job.status = 'error';
        job.error = err.message || 'Backtest failed';
        job.finishedAt = Date.now();
        console.error(`[Backtest] Job ${jobId} failed:`, err.message);
      });
    return res.json({ jobId, status: 'running', coins: coinsToRun });
  } catch (err) {
    console.error('[Backtest] Error starting job:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backtest/run', (req, res, next) => {
  req.url = '/api/backtest';
  return app._router.handle(req, res, next);
});

app.get('/api/backtest/status/:jobId', requireLogin, (req, res) => {
  const localJob = backtestJobs.get(req.params.jobId);
  if (!localJob && backtestQueueEnabled) {
    return backtestQueue.getJob(req.params.jobId)
      .then(async (queuedJob) => {
        if (!queuedJob) return res.status(404).json({ error: 'Job not found or expired' });
        const ownerId = String(queuedJob.data?.ownerId || '');
        if (ownerId && ownerId !== String(req.session.userId)) {
          return res.status(404).json({ error: 'Job not found or expired' });
        }
        const state = await queuedJob.getState();
        const progressRaw = queuedJob.progress();
        const progress = typeof progressRaw === 'object' ? progressRaw.message : progressRaw;
        if (state === 'completed') {
          const result = queuedJob.returnvalue || { success: true };
          latestBacktestResultByUser.set(String(req.session.userId), { at: Date.now(), result });
          return res.json(result);
        }
        if (state === 'failed') {
          return res.status(500).json({ error: queuedJob.failedReason || 'Backtest failed' });
        }
        const elapsed = queuedJob.processedOn
          ? ((Date.now() - queuedJob.processedOn) / 1000).toFixed(0)
          : ((Date.now() - (queuedJob.timestamp || Date.now())) / 1000).toFixed(0);
        return res.json({ status: 'running', progress: progress || 'Queued', elapsed: Number(elapsed) });
      })
      .catch((err) => res.status(500).json({ error: err.message || 'Status lookup failed' }));
  }

  const job = localJob;
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  if (job.ownerId && String(job.ownerId) !== String(req.session.userId)) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }

  if (job.status === 'done') {
    const result = job.result;
    latestBacktestResultByUser.set(String(req.session.userId), { at: Date.now(), result });
    backtestJobs.delete(job.id);
    return res.json(result);
  }
  if (job.status === 'error') {
    const error = job.error;
    backtestJobs.delete(job.id);
    return res.status(500).json({ error });
  }

  const elapsed = ((Date.now() - job.createdAt) / 1000).toFixed(0);
  res.json({ status: 'running', progress: job.progress, elapsed: Number(elapsed), coins: job.coins });
});

// ====================================================
// BACKTEST APPLY TRAINING — write train-phase regime data to StrategyWeight
// ====================================================
app.post('/api/backtest/apply-training', requireLogin, async (req, res) => {
  try {
    const { allTrades } = req.body || {};
    if (!allTrades || !Array.isArray(allTrades) || allTrades.length === 0) {
      return res.status(400).json({ error: 'No trades provided' });
    }

    const allStrategies = await StrategyWeight.find({ active: true }).lean();
    const strategyIds = new Set(allStrategies.map(s => s.strategyId));

    // Group trades by strategy+regime
    const byKey = {};
    for (const trade of allTrades) {
      const rawStrat = (trade.strategy || '').toLowerCase().replace(/[\s\-]+/g, '_');
      const regime = (trade.regime || 'unknown').toLowerCase();
      if (!rawStrat || !strategyIds.has(rawStrat)) continue;
      const key = `${rawStrat}::${regime}`;
      if (!byKey[key]) byKey[key] = { stratId: rawStrat, regime, wins: 0, losses: 0 };
      if ((trade.pnl || 0) > 0) byKey[key].wins++;
      else byKey[key].losses++;
    }

    let updated = 0;
    const summary = [];
    for (const { stratId, regime, wins, losses } of Object.values(byKey)) {
      const existing = allStrategies.find(s => s.strategyId === stratId);
      const prev = existing?.performance?.byRegime?.[regime] || { wins: 0, losses: 0 };
      const newWins = (prev.wins || 0) + wins;
      const newLosses = (prev.losses || 0) + losses;
      await StrategyWeight.updateOne(
        { strategyId: stratId },
        { $set: { [`performance.byRegime.${regime}`]: { wins: newWins, losses: newLosses }, updatedAt: new Date() } }
      );
      summary.push({ stratId, regime, wins, losses, totalWins: newWins, totalLosses: newLosses });
      updated++;
    }

    console.log(`[ApplyTraining] Updated ${updated} strategy+regime combos from ${allTrades.length} trades`);
    res.json({ success: true, updated, summary });
  } catch (err) {
    console.error('[ApplyTraining] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/backtest/walk-forward', requireLogin, requireElite, async (req, res) => {
  try {
    const cached = latestBacktestResultByUser.get(String(req.session.userId));
    if (!cached?.result) {
      return res.status(404).json({ success: false, error: 'Run a backtest first to generate walk-forward data' });
    }
    return res.json({
      success: true,
      mode: 'walk-forward',
      note: 'Baseline endpoint ready. Add segmented train/test windows to enrich this output.',
      latestBacktestAt: cached.at
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/backtest/parameter-sweep', requireLogin, requireElite, async (req, res) => {
  try {
    return res.json({
      success: true,
      mode: 'parameter-sweep',
      note: 'Endpoint is gated and available for Elite/Partner users.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Candles for chart (Lightweight Charts format)
app.get('/api/candles/:coinId', async (req, res) => {
  try {
    const { coinId } = req.params;
    const interval = String(req.query.interval || '1h').toLowerCase();
    const cacheTf = ['15m', '1h', '4h', '1d', '1w'].includes(interval) ? interval : null;
    const pageLimit = Math.max(200, Math.min(5000, Number(req.query.limit) || 1200));
    const beforeMs = Number(req.query.before || 0);
    const beforeTs = Number.isFinite(beforeMs) && beforeMs > 0 ? Math.floor(beforeMs) : null;
    if (!TRACKED_COINS.includes(coinId)) {
      return res.status(404).json({ error: 'Coin not found' });
    }
    // Prefer Mongo candle cache (paged) for chart history and back-scroll loading.
    let raw = null;
    let responseSource = 'cache';
    let pageHasMore = false;
    let pageNextBefore = null;
    if (cacheTf && mongoose.connection && mongoose.connection.readyState === 1) {
      const cacheQuery = { coinId, timeframe: cacheTf };
      if (beforeTs) cacheQuery.timestamp = { $lt: beforeTs };
      const rowsDesc = await CandleCache.find(cacheQuery)
        .sort({ timestamp: -1 })
        .limit(pageLimit)
        .lean();

      if (rowsDesc.length > 0 || beforeTs) {
        const rows = rowsDesc.slice().reverse();
        raw = rows.map((r) => ({
          openTime: Number(r.timestamp),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: Number(r.volume || 0)
        })).filter(c =>
          c.openTime > 0 &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          c.high >= c.low
        );

        const candles = raw.map(c => ({
          time: Math.floor(c.openTime / 1000),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close
        }));
        const volume = raw.map(c => {
          const t = Math.floor(c.openTime / 1000);
          const isUp = c.close >= c.open;
          return { time: t, value: c.volume || 0, color: isUp ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)' };
        });

        // Older-page requests only need candles/volume metadata.
        if (beforeTs) {
          let hasMore = false;
          let nextBefore = null;
          if (rowsDesc.length > 0) {
            const oldestTs = Number(rowsDesc[rowsDesc.length - 1].timestamp);
            nextBefore = oldestTs;
            const older = await CandleCache.findOne({ coinId, timeframe: cacheTf, timestamp: { $lt: oldestTs } })
              .select({ _id: 1 })
              .lean();
            hasMore = !!older;
          }
          return res.json({ success: true, candles, volume, hasMore, nextBefore, source: 'cache' });
        }

        if (rowsDesc.length > 0) {
          const oldestTs = Number(rowsDesc[rowsDesc.length - 1].timestamp);
          pageNextBefore = oldestTs;
          const older = await CandleCache.findOne({ coinId, timeframe: cacheTf, timestamp: { $lt: oldestTs } })
            .select({ _id: 1 })
            .lean();
          pageHasMore = !!older;
        }
      }
    }

    // Fallback for uncached timeframes (e.g. 1w) or when DB is unavailable.
    if (!raw) {
      responseSource = 'live';
      let allCandles = fetchCandles(coinId);
      if (!allCandles) {
        allCandles = await fetchAllCandlesForCoin(coinId);
        if (!allCandles && !isDataReady()) {
          await new Promise(r => setTimeout(r, 2000));
          allCandles = await fetchAllCandlesForCoin(coinId);
        }
      }
      if (!allCandles || !allCandles[interval]) {
        return res.json({ success: true, candles: [], volume: [], patterns: [], chartPatterns: [], hasMore: false, nextBefore: null });
      }
      raw = allCandles[interval].filter(c =>
        c.openTime > 0 && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) && c.high >= c.low
      ).sort((a, b) => a.openTime - b.openTime); // ascending for Lightweight Charts
    }

    // Live-fill: if cache is stale, append in-memory candles for the gap (non-blocking)
    if (responseSource === 'cache' && cacheTf && raw && raw.length > 0 && !beforeTs) {
      const tfMs = MS_PER_TIMEFRAME[cacheTf] || 3600000;
      const newestCacheTs = raw[raw.length - 1].openTime;
      const gapMs = Date.now() - newestCacheTs;
      if (gapMs > tfMs * 1.5) {
        try {
          const memCandles = fetchCandles(coinId);
          if (memCandles && memCandles[interval]) {
            const fillCandles = memCandles[interval]
              .filter(c => c.openTime > newestCacheTs && c.openTime > 0 &&
                Number.isFinite(c.open) && Number.isFinite(c.high) &&
                Number.isFinite(c.low) && Number.isFinite(c.close) && c.high >= c.low)
              .sort((a, b) => a.openTime - b.openTime);
            if (fillCandles.length > 0) {
              raw = raw.concat(fillCandles.map(c => ({
                openTime: c.openTime, open: c.open, high: c.high,
                low: c.low, close: c.close, volume: c.volume || 0
              })));
              responseSource = 'cache+mem';
            }
          }
        } catch (e) { /* live-fill failed, serve cached data */ }
        // Background sync for next request (non-blocking)
        syncCoinTimeframe(coinId, cacheTf).catch(() => {});
      }
    }

    const candles = raw.map(c => ({
      time: Math.floor(c.openTime / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }));
    const volume = raw.map(c => {
      const t = Math.floor(c.openTime / 1000);
      const isUp = c.close >= c.open;
      return { time: t, value: c.volume || 0, color: isUp ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)' };
    });

    // Support/Resistance with role reversal (break above R→S, break below S→R, new levels drawn)
    let support = null;
    let resistance = null;
    let poc = null;
    let volumeProfile = null;
    let orderBlocks = [];
    let fvgs = [];
    let liquidityClusters = {};
    let vwap = null;
    let swingPoints = { swingLows: [], swingHighs: [] };
    let marketStructure = null;
    let pivotPoints = null;
    try {
      const {
        findSRWithRoleReversal, calculatePOC, calculateVolumeProfile,
        detectOrderBlocks, detectFVGs, detectLiquidityClusters, calculateVWAP,
        getSwingPoints, detectMarketStructure, ATR_OHLC
      } = require('./services/trading-engine');
      const highs = raw.map(c => c.high);
      const lows = raw.map(c => c.low);
      const closes = raw.map(c => c.close);
      const opens = raw.map(c => c.open);
      const currentPrice = closes.length > 0 ? closes[closes.length - 1] : 0;
      const sr = findSRWithRoleReversal(highs, lows, closes);
      if (sr.support > 0 && sr.resistance > 0) {
        support = sr.support;
        resistance = sr.resistance;
      }
      const pocVal = calculatePOC(raw);
      if (pocVal > 0) poc = Math.round(pocVal * 1000000) / 1000000;
      const vp = calculateVolumeProfile(raw, 40);
      if (vp.buckets && vp.buckets.length > 0) volumeProfile = { buckets: vp.buckets, poc: vp.poc };
      if (raw.length >= 5) {
        const atr = ATR_OHLC(highs, lows, closes, 14);
        orderBlocks = detectOrderBlocks(opens, highs, lows, closes, atr) || [];
        fvgs = detectFVGs(highs, lows) || [];
        liquidityClusters = detectLiquidityClusters(highs, lows, currentPrice) || {};
        vwap = calculateVWAP(raw);
        if (Number.isFinite(vwap) && vwap > 0) vwap = Math.round(vwap * 1000000) / 1000000;
        else vwap = null;
        const lookback = Math.min(48, highs.length);
        const sp = getSwingPoints(lows, highs, lookback);
        swingPoints = {
          swingLows: (sp.swingLows || []).map(s => ({ time: candles[s.idx]?.time, price: s.val })).filter(x => x.time != null),
          swingHighs: (sp.swingHighs || []).map(s => ({ time: candles[s.idx]?.time, price: s.val })).filter(x => x.time != null)
        };
        marketStructure = detectMarketStructure(highs, lows);
      }
      if (raw.length >= 1) {
        const last = raw[raw.length - 1];
        const p = (last.high + last.low + last.close) / 3;
        const r1 = 2 * p - last.low;
        const r2 = p + (last.high - last.low);
        const s1 = 2 * p - last.high;
        const s2 = p - (last.high - last.low);
        pivotPoints = { p, r1, r2, s1, s2 };
      }
    } catch (srErr) {
      console.warn('S/R/SMC calc error:', srErr.message);
    }

    // Detect candlestick patterns on these candles (v4.1)
    let patterns = [];
    try {
      const { detectAllPatterns } = require('./services/candlestick-patterns');
      if (raw.length >= 6) {
        const detected = detectAllPatterns(raw);
        // Attach the timestamp of the last candle for marker placement
        if (detected.length > 0) {
          const lastTime = candles[candles.length - 1].time;
          patterns = detected.map(p => ({
            time: lastTime,
            name: p.name,
            direction: p.direction,
            type: p.type,
            strength: p.strength,
            description: p.description
          }));
        }
      }
    } catch (patErr) {
      // Pattern detection is non-critical — don't fail the candle response
      console.warn('Pattern detection error:', patErr.message);
    }

    // Detect chart patterns (v4.2) — geometric formations (flags, wedges, H&S, etc.)
    let chartPatterns = [];
    try {
      const { detectChartPatterns } = require('./services/chart-patterns');
      if (raw.length >= 20) {
        const detected = detectChartPatterns(raw);
        if (detected.length > 0) {
          chartPatterns = detected.map(p => ({
            id: p.id,
            name: p.name,
            direction: p.direction,
            type: p.type,
            bias: p.bias,
            strength: p.strength,
            completion: p.completion,
            target: p.target,
            description: p.description,
            reliability: p.reliability,
            volumeConfirm: p.volumeConfirm,
            breakoutVolumeConfirm: p.breakoutVolumeConfirm,
            breakoutCloseConfirm: p.breakoutCloseConfirm,
            trendlines: p.trendlines ? Object.keys(p.trendlines).map(key => {
              const tl = p.trendlines[key];
              return {
                label: key,
                startIdx: tl.startIdx,
                startPrice: tl.startPrice,
                startTime: tl.startIdx < candles.length ? candles[tl.startIdx].time : null,
                endIdx: tl.endIdx,
                endPrice: tl.endPrice,
                endTime: tl.endIdx < candles.length ? candles[tl.endIdx].time : null
              };
            }) : []
          }));
        }
      }
    } catch (cpErr) {
      console.warn('Chart pattern detection error:', cpErr.message);
    }

    res.json({
      success: true, candles, volume, support, resistance, poc, patterns, chartPatterns,
      orderBlocks, fvgs, liquidityClusters, vwap, swingPoints, marketStructure, pivotPoints,
      volumeProfile, hasMore: pageHasMore, nextBefore: pageNextBefore, source: responseSource
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// AUTO-CHECK STOPS & TPs (runs every 30 seconds)
// Uses live exchange prices so TPs/SLs aren't missed due to stale cache
// ====================================================
async function runStopTPCheck() {
  if (!dbConnected) return; // Skip if no database
  try {
    const openTrades = await Trade.find({ status: 'OPEN' }).select('coinId symbol userId').lean();
    if (openTrades.length === 0) return;

    // Re-register scanner meta for non-tracked coins (top 3 market scan coins).
    // scannerCoinMeta is in-memory and lost on restart, so we reconstruct it
    // from the trade's stored symbol. Without this, fetchLivePrice can't find
    // the Bitget ticker symbol, prices return null, and SL/TP/badges never fire.
    const coinIds = [...new Set(openTrades.map(t => t.coinId))];
    for (const cid of coinIds) {
      if (!TRACKED_COINS.includes(cid) && !getCoinMeta(cid)) {
        const trade = openTrades.find(t => t.coinId === cid);
        if (trade?.symbol) {
          registerScannerCoinMeta(cid, trade.symbol);
        }
      }
    }

    // Fetch live prices from Bitget/Kraken for all coins with open trades
    const livePrices = await Promise.all(coinIds.map(id => fetchLivePrice(id)));
    const priceMap = {};
    coinIds.forEach((id, i) => {
      if (livePrices[i] != null && Number.isFinite(livePrices[i]) && livePrices[i] > 0) {
        priceMap[id] = { id, price: livePrices[i] };
      }
    });
    // Fall back to cached price if live fetch failed for a coin
    const getLivePrice = (coinId) => priceMap[coinId] || getCurrentPrice(coinId);

    // Build signal getter for DCA (lazy — only fetches data if DCA is actually triggered)
    let _dcaSignalCache = {};
    let _dcaDataLoaded = false;
    let _dcaPrices, _dcaCandles, _dcaHistory, _dcaOptions;
    const getSignalForCoin = async (coinId) => {
      if (_dcaSignalCache[coinId]) return _dcaSignalCache[coinId];
      if (!_dcaDataLoaded) {
        _dcaPrices = await fetchAllPrices();
        _dcaCandles = fetchAllCandles();
        _dcaHistory = await fetchAllHistory();
        _dcaOptions = await buildEngineOptions(_dcaPrices, _dcaCandles, _dcaHistory);
        _dcaDataLoaded = true;
      }
      const coinData = _dcaPrices.find(p => p.id === coinId);
      if (!coinData) return null;
      const candles = _dcaCandles[coinId] || null;
      const history = _dcaHistory[coinId] || { prices: [], volumes: [] };
      _dcaSignalCache[coinId] = analyzeCoin(coinData, candles, history, _dcaOptions);
      return _dcaSignalCache[coinId];
    };

    await checkStopsAndTPs(getLivePrice, getSignalForCoin);
  } catch (err) {
    console.error('[AutoCheck] Error:', err.message);
  }
}
if (IS_PRIMARY_WORKER) {
  trackInterval(() => runNonOverlapping('runStopTPCheck', runStopTPCheck), 10 * 1000);
  trackTimeout(() => runNonOverlapping('runStopTPCheck', runStopTPCheck), 5 * 1000);
}

// ====================================================
// PRICE ALERT CHECK (runs every 60 seconds)
// ====================================================
async function checkPriceAlerts() {
  if (!dbConnected) return;
  try {
    const activeAlerts = await Alert.find({ active: true, triggeredAt: null }).lean();
    if (activeAlerts.length === 0) return;
    const coinIds = [...new Set(activeAlerts.map(a => a.coinId))];
    const prices = await fetchAllPrices();
    const priceMap = {};
    (prices || []).forEach(p => {
      if (p && p.id && Number.isFinite(p.price) && p.price > 0) priceMap[p.id] = p.price;
    });
    for (const alert of activeAlerts) {
      const price = priceMap[alert.coinId];
      if (price == null) continue;
      const triggered = (alert.condition === 'above' && price >= alert.price) ||
        (alert.condition === 'below' && price <= alert.price);
      if (triggered) {
        await Alert.updateOne({ _id: alert._id }, { triggeredAt: new Date(), active: false });
      }
    }
  } catch (err) {
    console.error('[AlertCheck] Error:', err.message);
  }
}
if (IS_PRIMARY_WORKER) {
  trackInterval(() => runNonOverlapping('checkPriceAlerts', checkPriceAlerts), 60 * 1000);
  trackTimeout(() => runNonOverlapping('checkPriceAlerts', checkPriceAlerts), 20 * 1000);
}

// ====================================================
// WHOLE-MARKET SCANNER (runs every 10 min)
// Scans top 80 coins by market cap, scores with same engine as 20 tracked.
// Caches top 3 for dashboard display.
// ====================================================
try {
  const { scanMarket } = require('./services/market-scanner');
  const runMarketScanner = async () => { await scanMarket(); };
  if (IS_PRIMARY_WORKER) {
    trackInterval(() => runNonOverlapping('scanMarket', runMarketScanner), 10 * 60 * 1000);
    trackTimeout(() => runNonOverlapping('scanMarket', runMarketScanner), 30 * 1000);
  }
  console.log('[MarketScanner] Whole-market scan every 10 min');
} catch (e) { console.warn('[MarketScanner] Not loaded:', e.message); }

// ====================================================
// TRADE SCORE RE-CHECK (runs every SCORE_RECHECK_MINUTES)
// Re-analyzes each open trade's coin and generates
// status messages: confidence, momentum, structure, etc.
// ====================================================
async function runScoreRecheck() {
  if (!dbConnected) return; // Skip if no database
  try {
    let prices = await fetchAllPrices();
    // On cold start (e.g. Render wake), prices may be empty. Wait for first load.
    if (!prices || prices.length === 0) {
      try {
        await Promise.race([pricesReadyPromise, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 45000))]);
        prices = await fetchAllPrices();
      } catch (e) { /* fall through */ }
      if (!prices || prices.length === 0) return;
    }
    const [allCandles, allHistory] = await Promise.all([
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory()
    ]);

    // Re-register scanner meta for non-tracked coins with open trades
    // so recheckTradeScores can fetch live prices for them
    try {
      const openTrades = await Trade.find({ status: 'OPEN' }).select('coinId symbol').lean();
      for (const t of openTrades) {
        if (!TRACKED_COINS.includes(t.coinId) && !getCoinMeta(t.coinId) && t.symbol) {
          registerScannerCoinMeta(t.coinId, t.symbol);
        }
        // For non-tracked coins, try to fetch their data so score recheck works
        if (!prices.find(p => p.id === t.coinId)) {
          try {
            const lp = await fetchLivePrice(t.coinId);
            if (lp && Number.isFinite(lp) && lp > 0) {
              prices.push({ id: t.coinId, symbol: t.symbol || t.coinId.toUpperCase(), price: lp });
            }
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }

    const options = await buildEngineOptions(prices, allCandles, allHistory);

    const signalCache = {};
    const getSignalForCoin = async (coinId) => {
      if (signalCache[coinId]) return signalCache[coinId];
      const coinData = prices.find(p => p.id === coinId);
      if (!coinData) return null;
      const candles = allCandles[coinId] || null;
      const history = allHistory[coinId] || { prices: [], volumes: [] };
      signalCache[coinId] = analyzeCoin(coinData, candles, history, options);
      return signalCache[coinId];
    };

    await recheckTradeScores(getSignalForCoin, getCurrentPrice);
  } catch (err) {
    console.error('[ScoreCheck] Interval error:', err.message);
  }
}
if (IS_PRIMARY_WORKER) {
  trackInterval(() => runNonOverlapping('runScoreRecheck', runScoreRecheck), SCORE_RECHECK_MINUTES * 60 * 1000);
  trackTimeout(() => runNonOverlapping('runScoreRecheck', runScoreRecheck), 30 * 1000);
}

// On-demand trigger: when user visits trades page with open trades (helps cold start)
let _lastScoreCheckTrigger = 0;
const SCORE_CHECK_TRIGGER_DEBOUNCE_MS = 60000; // max 1 manual trigger per minute
app.post('/api/trigger-score-check', requireLogin, async (req, res) => {
  try {
    const now = Date.now();
    if (now - _lastScoreCheckTrigger < SCORE_CHECK_TRIGGER_DEBOUNCE_MS) {
      return res.json({ success: true, message: 'Check already run recently. Wait ~1 min.' });
    }
    _lastScoreCheckTrigger = now;
    runNonOverlapping('runScoreRecheck', runScoreRecheck);
    res.json({ success: true, message: 'Score check triggered. Refresh in 10–15 seconds.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// CHART COPILOT API
// ====================================================
const CHART_COPILOT_INDICATOR_CATALOG = [
  { id: 'volume', label: 'Volume', category: 'overlays', useCase: 'confirm breakout participation' },
  { id: 'bollingerBands', label: 'Bollinger Bands', category: 'overlays', useCase: 'volatility expansion/compression' },
  { id: 'movingAverages', label: 'Moving Averages', category: 'overlays', useCase: 'trend direction and pullbacks' },
  { id: 'keltnerChannel', label: 'Keltner Channel', category: 'overlays', useCase: 'ATR-based trend envelope' },
  { id: 'donchianChannel', label: 'Donchian Channel', category: 'overlays', useCase: 'breakout highs/lows' },
  { id: 'fibonacciLevels', label: 'Fibonacci Levels', category: 'overlays', useCase: 'retracement reaction zones' },
  { id: 'supportResistance', label: 'Support/Resistance', category: 'levels', useCase: 'key reaction levels' },
  { id: 'pointOfControl', label: 'POC', category: 'levels', useCase: 'high-volume price acceptance' },
  { id: 'pivotPoints', label: 'Pivot Points', category: 'levels', useCase: 'session-based levels' },
  { id: 'chartPatterns', label: 'Chart Patterns', category: 'patterns', useCase: 'continuation/reversal structures' },
  { id: 'candlestickPatterns', label: 'Candlestick Patterns', category: 'patterns', useCase: 'short-term reversal clues' },
  { id: 'orderBlocks', label: 'Order Blocks', category: 'advanced', useCase: 'institutional footprint zones' },
  { id: 'fairValueGaps', label: 'Fair Value Gaps', category: 'advanced', useCase: 'imbalance fill opportunities' },
  { id: 'liquidityClusters', label: 'Liquidity Clusters', category: 'advanced', useCase: 'sweep and trap zones' },
  { id: 'vwap', label: 'VWAP', category: 'advanced', useCase: 'mean-reversion and trend bias' },
  { id: 'premiumDiscountZone', label: 'Premium/Discount', category: 'advanced', useCase: 'relative value zone framing' },
  { id: 'swingPoints', label: 'Swing Points', category: 'advanced', useCase: 'market structure anchors' },
  { id: 'marketStructure', label: 'Market Structure', category: 'advanced', useCase: 'trend state transitions' },
  { id: 'sessionMarkers', label: 'Session Markers', category: 'advanced', useCase: 'session volatility windows' },
  { id: 'gapMarkers', label: 'Gap Markers', category: 'advanced', useCase: 'inefficiency and fill behavior' },
  { id: 'volumeProfile', label: 'Volume Profile', category: 'advanced', useCase: 'distribution and value areas' },
  { id: 'rsi', label: 'RSI', category: 'oscillator', useCase: 'momentum extremes and divergence' },
  { id: 'macd', label: 'MACD', category: 'oscillator', useCase: 'trend momentum confirmation' }
];

function formatMaybeNumber(v, digits = 4) {
  if (!Number.isFinite(v)) return null;
  return Number(v.toFixed(digits));
}

function deriveChartIndicatorData(rawCandles) {
  const rows = Array.isArray(rawCandles) ? rawCandles.filter(c =>
    Number.isFinite(c?.open) && Number.isFinite(c?.high) && Number.isFinite(c?.low) && Number.isFinite(c?.close)
  ) : [];
  if (rows.length === 0) return {};

  const highs = rows.map(c => c.high);
  const lows = rows.map(c => c.low);
  const closes = rows.map(c => c.close);
  const opens = rows.map(c => c.open);
  const currentPrice = closes[closes.length - 1];
  const chartData = {};

  const sma = (arr, len) => {
    if (!Array.isArray(arr) || arr.length < len) return null;
    const slice = arr.slice(-len);
    const sum = slice.reduce((s, v) => s + v, 0);
    return sum / len;
  };

  chartData.ma20 = formatMaybeNumber(sma(closes, 20), 6);
  chartData.ma50 = formatMaybeNumber(sma(closes, 50), 6);

  // Donchian channel (20)
  if (highs.length >= 20 && lows.length >= 20) {
    chartData.donchianUpper = formatMaybeNumber(Math.max(...highs.slice(-20)), 6);
    chartData.donchianLower = formatMaybeNumber(Math.min(...lows.slice(-20)), 6);
  }

  try {
    const {
      findSRWithRoleReversal,
      calculatePOC,
      calculateVolumeProfile,
      detectOrderBlocks,
      detectFVGs,
      detectLiquidityClusters,
      calculateVWAP,
      getSwingPoints,
      detectMarketStructure,
      ATR_OHLC
    } = require('./services/trading-engine');

    const sr = findSRWithRoleReversal(highs, lows, closes);
    if (Number.isFinite(sr.support) && Number.isFinite(sr.resistance) && sr.support > 0 && sr.resistance > 0) {
      chartData.support = formatMaybeNumber(sr.support, 6);
      chartData.resistance = formatMaybeNumber(sr.resistance, 6);
    }

    const poc = calculatePOC(rows);
    if (Number.isFinite(poc) && poc > 0) chartData.poc = formatMaybeNumber(poc, 6);

    const vp = calculateVolumeProfile(rows, 40);
    if (vp?.buckets?.length) chartData.volumeProfile = { buckets: vp.buckets.length, poc: formatMaybeNumber(vp.poc, 6) };

    const vwap = calculateVWAP(rows);
    if (Number.isFinite(vwap) && vwap > 0) chartData.vwap = formatMaybeNumber(vwap, 6);

    if (rows.length >= 5) {
      const atr = ATR_OHLC(highs, lows, closes, 14);
      chartData.orderBlocksCount = (detectOrderBlocks(opens, highs, lows, closes, atr) || []).length;
      chartData.fvgsCount = (detectFVGs(highs, lows) || []).length;
      const liq = detectLiquidityClusters(highs, lows, currentPrice) || {};
      chartData.liquidityClustersCount = (liq.below?.length || 0) + (liq.above?.length || 0);
      const sp = getSwingPoints(lows, highs, Math.min(48, highs.length));
      chartData.swingPointsCount = (sp.swingLows?.length || 0) + (sp.swingHighs?.length || 0);
      chartData.marketStructure = detectMarketStructure(highs, lows) || null;
    }

    const last = rows[rows.length - 1];
    if (last) {
      const p = (last.high + last.low + last.close) / 3;
      chartData.pivots = {
        p: formatMaybeNumber(p, 6),
        r1: formatMaybeNumber(2 * p - last.low, 6),
        r2: formatMaybeNumber(p + (last.high - last.low), 6),
        s1: formatMaybeNumber(2 * p - last.high, 6),
        s2: formatMaybeNumber(p - (last.high - last.low), 6)
      };
    }
  } catch (err) {
    console.warn('[ChartCopilot] chart indicator calc warning:', err.message);
  }

  try {
    const { detectAllPatterns } = require('./services/candlestick-patterns');
    const cPatterns = rows.length >= 6 ? (detectAllPatterns(rows) || []) : [];
    chartData.candlestickPatternsCount = cPatterns.length;
  } catch (err) {
    /* non-critical */
  }

  try {
    const { detectChartPatterns } = require('./services/chart-patterns');
    const gPatterns = rows.length >= 20 ? (detectChartPatterns(rows) || []) : [];
    chartData.chartPatternsCount = gPatterns.length;
  } catch (err) {
    /* non-critical */
  }

  return chartData;
}

function buildActiveIndicatorSnapshot(sig, activeIds, chartData) {
  const ind = sig?.indicators || {};
  const lookup = {
    volume: ind.relativeVolume != null ? `${formatMaybeNumber(ind.relativeVolume, 2)}x rel vol` : ind.volumeTrend || null,
    bollingerBands: (ind.bollingerLower != null && ind.bollingerUpper != null) ? `${formatMaybeNumber(ind.bollingerLower, 4)} - ${formatMaybeNumber(ind.bollingerUpper, 4)}` : null,
    movingAverages: chartData?.ma20 != null || chartData?.ma50 != null ? { ma20: chartData.ma20, ma50: chartData.ma50 } : (ind.trend || ind.trendDirection || null),
    keltnerChannel: ind.atr != null ? { atr: formatMaybeNumber(ind.atr, 6) } : null,
    donchianChannel: (chartData?.donchianUpper != null || chartData?.donchianLower != null) ? { upper: chartData.donchianUpper, lower: chartData.donchianLower } : null,
    fibonacciLevels: ind.fibLevels || null,
    supportResistance: (chartData?.support != null || chartData?.resistance != null || ind.support != null || ind.resistance != null) ? {
      support: formatMaybeNumber(chartData?.support ?? ind.support, 4),
      resistance: formatMaybeNumber(chartData?.resistance ?? ind.resistance, 4)
    } : null,
    pointOfControl: formatMaybeNumber(chartData?.poc ?? ind.poc, 4),
    pivotPoints: chartData?.pivots || null,
    chartPatterns: Number.isFinite(chartData?.chartPatternsCount) ? `${chartData.chartPatternsCount} detected` : null,
    candlestickPatterns: Number.isFinite(chartData?.candlestickPatternsCount) ? `${chartData.candlestickPatternsCount} detected` : (ind.candlestickPatterns ? 'detected' : null),
    orderBlocks: Number.isFinite(chartData?.orderBlocksCount) ? `${chartData.orderBlocksCount} zones` : (ind.orderBlocks ? 'detected' : null),
    fairValueGaps: Number.isFinite(chartData?.fvgsCount) ? `${chartData.fvgsCount} gaps` : (ind.fvgs ? 'detected' : null),
    liquidityClusters: Number.isFinite(chartData?.liquidityClustersCount) ? `${chartData.liquidityClustersCount} clusters` : (ind.liquidityClusters ? 'detected' : null),
    vwap: formatMaybeNumber(chartData?.vwap ?? ind.vwap, 4),
    premiumDiscountZone: ind.fibLevels?.fib500 != null ? { equilibrium: formatMaybeNumber(ind.fibLevels.fib500, 4) } : null,
    swingPoints: Number.isFinite(chartData?.swingPointsCount) ? `${chartData.swingPointsCount} pivots` : null,
    marketStructure: chartData?.marketStructure || ind.structure || ind.marketStructure || null,
    sessionMarkers: 'chart-time overlays',
    gapMarkers: Number.isFinite(chartData?.fvgsCount) ? `${chartData.fvgsCount} imbalance gaps` : null,
    volumeProfile: chartData?.volumeProfile || (ind.volumeProfile ? 'available' : null),
    rsi: formatMaybeNumber(ind.rsi, 2),
    macd: formatMaybeNumber(ind.macdHistogram, 4)
  };

  return (Array.isArray(activeIds) ? activeIds : [])
    .map(id => ({ id, value: lookup[id] !== undefined ? lookup[id] : null }))
    .filter(x => x.id);
}

// ====================================================
// VOICE COPILOT (Whisper + Piper, optional Mumble transport flag)
// ====================================================
app.get('/api/voice/transport', requireLogin, (req, res) => {
  const mode = (process.env.VOICE_TRANSPORT || (process.env.MUMBLE_ENABLED === 'true' ? 'mumble' : 'http')).toLowerCase();
  res.json({
    success: true,
    mode: mode === 'mumble' ? 'mumble' : 'http',
    wsPath: '/ws/voice',
    lowLatency: mode === 'mumble',
    mumbleHost: process.env.MUMBLE_HOST || '',
    mumblePort: Number(process.env.MUMBLE_PORT || 64738)
  });
});

app.post('/api/voice/transcribe', requireLogin, checkVoiceLimit, async (req, res) => {
  try {
    const parsed = parseBase64Audio(req.body?.audioBase64 || '');
    if (!parsed || !parsed.buffer || parsed.buffer.length === 0) {
      return res.status(400).json({ success: false, error: 'Audio payload is required' });
    }
    if (parsed.buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'Audio payload too large (max 10MB)' });
    }
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ success: false, error: 'Login required' });
    user.voiceMinutesUsed = (user.voiceMinutesUsed || 0) + estimateAudioMinutes(parsed.buffer, parsed.mimeType);
    await user.save();
    const out = await transcribeWithWhisper(parsed.buffer, parsed.mimeType);
    if (!out.text) {
      return res.status(422).json({ success: false, error: 'Could not transcribe audio clearly' });
    }
    res.json({
      success: true,
      text: out.text,
      latencyMs: out.latencyMs
    });
  } catch (err) {
    console.error('[Voice][Whisper] Error:', err.message);
    const status = /OPENAI_API_KEY/i.test(err.message) ? 503 : 500;
    res.status(status).json({ success: false, error: err.message || 'Transcription failed' });
  }
});

app.post('/api/voice/synthesize', requireLogin, checkVoiceLimit, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ success: false, error: 'text is required' });
    if (text.length > 10000) return res.status(400).json({ success: false, error: 'text too long (max 10000 chars)' });

    const out = await synthesizeWithPiper(text);
    res.setHeader('Content-Type', out.mimeType || 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Voice-Latency-Ms', String(out.latencyMs || 0));
    return res.send(out.audioBuffer);
  } catch (err) {
    console.error('[Voice][Piper] Error:', err.message);
    return res.status(503).json({ success: false, error: err.message || 'Speech synthesis failed' });
  }
});

async function runLlmChatForUser(userId, messages, executeActions) {
  const { getMarketPulse } = require('./services/market-pulse');
  const { getTop3FullCached } = require('./services/market-scanner');
  const { runChat } = require('./services/llm-chat');
  const deps = {
    User, Trade, getPerformanceStats, closeTrade, closeTradePartial, updateTradeLevels, fetchLivePrice, openTrade,
    fetchAllPrices, fetchAllCandles, fetchAllHistory, buildEngineOptions, analyzeAllCoins,
    getScoreHistory, getRegimeTimeline, getMarketPulse, getTop3FullCached, runBacktest
  };
  return runChat(userId, messages, deps, { executeActions: executeActions === true });
}

async function runChartCopilotForUser(userId, coinIdInput, questionInput, timeframeInput, activeIndicatorsInput) {
  const coinId = String(coinIdInput || '').trim().toLowerCase();
  const question = String(questionInput || '').trim();
  const timeframe = String(timeframeInput || '1h').toLowerCase();
  const tf = ['15m', '1h', '4h', '1d', '1w'].includes(timeframe) ? timeframe : '1h';
  const activeIndicators = Array.isArray(activeIndicatorsInput) ? activeIndicatorsInput.filter(id => typeof id === 'string') : [];

  if (!coinId) { const e = new Error('coinId required'); e.status = 400; throw e; }
  if (!question) { const e = new Error('Question is required'); e.status = 400; throw e; }
  if (question.length > 1200) { const e = new Error('Question too long (max 1200 chars)'); e.status = 400; throw e; }

  const user = await User.findById(userId).lean();
  if (!user) { const e = new Error('User not found'); e.status = 404; throw e; }

  let coinData = null;
  let history = { prices: [], volumes: [] };
  let candles = fetchCandles(coinId);

  if (TRACKED_COINS.includes(coinId)) {
    const [prices, allHistory] = await Promise.all([fetchAllPrices(), fetchAllHistory()]);
    coinData = (prices || []).find(p => p.id === coinId) || null;
    history = (allHistory && allHistory[coinId]) ? allHistory[coinId] : history;
    if (!candles) candles = await fetchAllCandlesForCoin(coinId);
  } else {
    const fetched = await fetchCoinDataForDetail(coinId);
    if (fetched?.coinData) {
      coinData = fetched.coinData;
      history = fetched.history || history;
    }
    if (!candles) candles = await fetchAllCandlesForCoin(coinId);
    if (coinData?.symbol) registerScannerCoinMeta(coinId, coinData.symbol);
  }

  if (!coinData) { const e = new Error('Coin not found'); e.status = 404; throw e; }
  if (!candles || !candles[tf] || candles[tf].length === 0) {
    const e = new Error('No candle data available for this coin/timeframe'); e.status = 404; throw e;
  }

  const options = await buildEngineOptions([coinData], { [coinId]: candles }, { [coinId]: history }, user);
  const sig = analyzeCoin(coinData, candles, history, options);
  if (!sig.coin && sig.coinData) sig.coin = sig.coinData;

  const tfCandles = candles[tf] || [];
  const recentCandles = tfCandles.slice(-120);
  const firstClose = recentCandles[0]?.close;
  const lastClose = recentCandles[recentCandles.length - 1]?.close;
  const priceChangePct = (Number.isFinite(firstClose) && Number.isFinite(lastClose) && firstClose > 0)
    ? ((lastClose - firstClose) / firstClose) * 100
    : null;

  const chartData = deriveChartIndicatorData(recentCandles);
  const availableIndicators = CHART_COPILOT_INDICATOR_CATALOG.map(i => ({
    ...i,
    active: activeIndicators.includes(i.id)
  }));
  const activeIndicatorSnapshot = buildActiveIndicatorSnapshot(sig, activeIndicators, chartData);
  const inactiveSuggestions = availableIndicators.filter(i => !i.active).slice(0, 10);

  let platformContext = null;
  try {
    const { buildContext } = require('./services/llm-agent');
    const { getMarketPulse } = require('./services/market-pulse');
    const pCtx = await buildContext(user, User, Trade, getPerformanceStats, fetchLivePrice, {
      fetchAllPrices, fetchAllCandles, fetchAllHistory, buildEngineOptions, analyzeAllCoins,
      getScoreHistory, getRegimeTimeline, getMarketPulse
    });
    let pulse = null;
    try { pulse = await getMarketPulse(); } catch (_) { /* ignore */ }
    const { buildContextBlock } = require('./services/llm-chat');
    if (typeof buildContextBlock === 'function') {
      platformContext = buildContextBlock(pCtx, pulse);
    } else {
      const parts = [];
      if (pCtx.openTradesCount > 0) {
        parts.push(`Open trades: ${pCtx.openTradesCount}`);
        pCtx.openTrades.forEach(t => parts.push(`  ${t.symbol} ${t.direction} P&L: $${(t.pnl||0).toFixed(2)}`));
      }
      parts.push(`Balance: $${(pCtx.balance||0).toLocaleString()}`);
      if (pCtx.stats) parts.push(`Stats: WR ${pCtx.stats.winRate||0}%, PnL $${(pCtx.stats.totalPnl||0).toFixed(0)}`);
      platformContext = parts.join('\n');
    }
  } catch (_) { /* platform context is optional */ }

  const contextPayload = {
    coin: { id: coinId, symbol: sig.coin?.symbol || coinData.symbol || coinId.toUpperCase(), name: sig.coin?.name || coinData.name || coinId },
    timeframe: tf,
    signal: {
      signal: sig.signal,
      score: sig.score,
      confidence: sig.confidence,
      regime: sig.regime,
      confluenceLevel: sig.confluenceLevel,
      strategyName: sig.strategyName,
      riskReward: sig.riskReward,
      reasoning: sig.reasoning || [],
      counterReasons: sig.counterReasons || []
    },
    timeframes: sig.timeframes || {},
    keyLevels: {
      entry: formatMaybeNumber(sig.entry, 6),
      stopLoss: formatMaybeNumber(sig.stopLoss, 6),
      takeProfit1: formatMaybeNumber(sig.takeProfit1, 6),
      takeProfit2: formatMaybeNumber(sig.takeProfit2, 6),
      takeProfit3: formatMaybeNumber(sig.takeProfit3, 6),
      support: formatMaybeNumber(sig.indicators?.support, 6),
      resistance: formatMaybeNumber(sig.indicators?.resistance, 6)
    },
    marketWindow: {
      candlesAnalyzed: recentCandles.length,
      closeChangePct: formatMaybeNumber(priceChangePct, 2),
      latestClose: formatMaybeNumber(lastClose, 6)
    },
    activeIndicators: activeIndicatorSnapshot,
    availableIndicators,
    inactiveIndicatorSuggestions: inactiveSuggestions,
    chartDerivedIndicators: chartData,
    rawIndicators: sig.indicators || {}
  };

  const systemParts = [
    'You are Chart Copilot, a crypto chart assistant with FULL access to this user\'s trading platform.',
    'You can see their open trades, performance, balance, settings, market pulse, AND the chart they are viewing with all active/available indicators.',
    'Use the provided chart context AND platform context to answer.',
    'Goals:',
    '1) Explain what active indicators suggest now.',
    '2) Suggest 2-4 off-chart indicators from availableIndicators that could improve confirmation.',
    '3) Provide balanced scenarios (bullish and bearish) and invalidation.',
    '4) Relate chart analysis to the user\'s open trades and portfolio when relevant.',
    '5) Never give financial advice or certainty. Use probabilistic language.',
    'Respond in concise plain text with sections:',
    'Bias',
    'Active Indicator Read',
    'What To Add Next',
    'Trade Ideas (educational)',
    'Risk / Invalidation'
  ];
  if (platformContext) {
    systemParts.push('', '---', 'Platform context:', platformContext);
  }
  const systemPrompt = systemParts.join('\n');

  const userPrompt = [
    `User question: ${question}`,
    '',
    'Chart context JSON:',
    JSON.stringify(contextPayload)
  ].join('\n');

  const { chat } = require('./services/ollama-client');
  const responseText = await chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    user.settings?.ollamaUrl || 'http://localhost:11434',
    user.settings?.ollamaModel || 'llama3.1:8b',
    user.settings?.ollamaApiKey || ''
  );

  return {
    success: true,
    response: (responseText || '').trim() || 'No response received from model.',
    contextNote: `Used ${activeIndicatorSnapshot.length} active indicators and ${availableIndicators.length} available indicators.`
  };
}

app.post('/api/chart-copilot/:coinId', requireLogin, checkCopilotLimit, async (req, res) => {
  try {
    const coinId = String(req.params.coinId || '').trim().toLowerCase();
    const question = String(req.body?.question || '').trim();
    const timeframe = String(req.body?.timeframe || '1h').toLowerCase();
    const tf = ['15m', '1h', '4h', '1d', '1w'].includes(timeframe) ? timeframe : '1h';
    const validIndicatorIds = new Set(CHART_COPILOT_INDICATOR_CATALOG.map(i => i.id));
    const activeIndicators = Array.isArray(req.body?.activeIndicators)
      ? req.body.activeIndicators.filter(id => typeof id === 'string' && validIndicatorIds.has(id))
      : [];

    if (!coinId) return res.status(400).json({ success: false, error: 'coinId required' });
    if (!question) return res.status(400).json({ success: false, error: 'Question is required' });
    if (question.length > 1200) return res.status(400).json({ success: false, error: 'Question too long (max 1200 chars)' });

    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    let coinData = null;
    let history = { prices: [], volumes: [] };
    let candles = fetchCandles(coinId);

    if (TRACKED_COINS.includes(coinId)) {
      const [prices, allHistory] = await Promise.all([fetchAllPrices(), fetchAllHistory()]);
      coinData = (prices || []).find(p => p.id === coinId) || null;
      history = (allHistory && allHistory[coinId]) ? allHistory[coinId] : history;
      if (!candles) candles = await fetchAllCandlesForCoin(coinId);
    } else {
      const fetched = await fetchCoinDataForDetail(coinId);
      if (fetched?.coinData) {
        coinData = fetched.coinData;
        history = fetched.history || history;
      }
      if (!candles) candles = await fetchAllCandlesForCoin(coinId);
      if (coinData?.symbol) registerScannerCoinMeta(coinId, coinData.symbol);
    }

    if (!coinData) {
      return res.status(404).json({ success: false, error: 'Coin not found' });
    }
    if (!candles || !candles[tf] || candles[tf].length === 0) {
      return res.status(404).json({ success: false, error: 'No candle data available for this coin/timeframe' });
    }

    const options = await buildEngineOptions([coinData], { [coinId]: candles }, { [coinId]: history }, user);
    const sig = analyzeCoin(coinData, candles, history, options);
    if (!sig.coin && sig.coinData) sig.coin = sig.coinData;

    const tfCandles = candles[tf] || [];
    const recentCandles = tfCandles.slice(-120);
    const chartData = deriveChartIndicatorData(recentCandles);
    const firstClose = recentCandles[0]?.close;
    const lastClose = recentCandles[recentCandles.length - 1]?.close;
    const priceChangePct = (Number.isFinite(firstClose) && Number.isFinite(lastClose) && firstClose > 0)
      ? ((lastClose - firstClose) / firstClose) * 100
      : null;

    const availableIndicators = CHART_COPILOT_INDICATOR_CATALOG.map(i => ({
      ...i,
      active: activeIndicators.includes(i.id)
    }));
    const activeIndicatorSnapshot = buildActiveIndicatorSnapshot(sig, activeIndicators, chartData);
    const inactiveSuggestions = availableIndicators.filter(i => !i.active).slice(0, 10);

    let platformContext = null;
    try {
      const { buildContext } = require('./services/llm-agent');
      const { getMarketPulse } = require('./services/market-pulse');
      const pCtx = await buildContext(user, User, Trade, getPerformanceStats, fetchLivePrice, {
        fetchAllPrices, fetchAllCandles, fetchAllHistory, buildEngineOptions, analyzeAllCoins,
        getScoreHistory, getRegimeTimeline, getMarketPulse
      });
      let pulse = null;
      try { pulse = await getMarketPulse(); } catch (_) { /* ignore */ }
      const { buildContextBlock } = require('./services/llm-chat');
      if (typeof buildContextBlock === 'function') {
        platformContext = buildContextBlock(pCtx, pulse);
      }
    } catch (_) { /* platform context is optional */ }

    const contextPayload = {
      coin: { id: coinId, symbol: sig.coin?.symbol || coinData.symbol || coinId.toUpperCase(), name: sig.coin?.name || coinData.name || coinId },
      timeframe: tf,
      signal: {
        signal: sig.signal,
        score: sig.score,
        confidence: sig.confidence,
        regime: sig.regime,
        confluenceLevel: sig.confluenceLevel,
        strategyName: sig.strategyName,
        riskReward: sig.riskReward,
        reasoning: sig.reasoning || [],
        counterReasons: sig.counterReasons || []
      },
      timeframes: sig.timeframes || {},
      keyLevels: {
        entry: formatMaybeNumber(sig.entry, 6),
        stopLoss: formatMaybeNumber(sig.stopLoss, 6),
        takeProfit1: formatMaybeNumber(sig.takeProfit1, 6),
        takeProfit2: formatMaybeNumber(sig.takeProfit2, 6),
        takeProfit3: formatMaybeNumber(sig.takeProfit3, 6),
        support: formatMaybeNumber(sig.indicators?.support, 6),
        resistance: formatMaybeNumber(sig.indicators?.resistance, 6)
      },
      marketWindow: {
        candlesAnalyzed: recentCandles.length,
        closeChangePct: formatMaybeNumber(priceChangePct, 2),
        latestClose: formatMaybeNumber(lastClose, 6)
      },
      activeIndicators: activeIndicatorSnapshot,
      availableIndicators,
      inactiveIndicatorSuggestions: inactiveSuggestions,
      chartDerivedIndicators: chartData,
      rawIndicators: sig.indicators || {}
    };

    const systemParts = [
      'You are Chart Copilot, a crypto chart assistant with FULL access to this user\'s trading platform.',
      'You can see their open trades, performance, balance, settings, market pulse, AND the chart they are viewing with all active/available indicators.',
      'Use the provided chart context AND platform context to answer.',
      'Goals:',
      '1) Explain what active indicators suggest now.',
      '2) Suggest 2-4 off-chart indicators from availableIndicators that could improve confirmation.',
      '3) Provide balanced scenarios (bullish and bearish) and invalidation.',
      '4) Relate chart analysis to the user\'s open trades and portfolio when relevant.',
      '5) Never give financial advice or certainty. Use probabilistic language.',
      'Respond in concise plain text with sections:',
      'Bias',
      'Active Indicator Read',
      'What To Add Next',
      'Trade Ideas (educational)',
      'Risk / Invalidation'
    ];
    if (platformContext) {
      systemParts.push('', '---', 'Platform context:', platformContext);
    }
    const systemPrompt = systemParts.join('\n');

    const userPrompt = [
      `User question: ${question}`,
      '',
      'Chart context JSON:',
      JSON.stringify(contextPayload)
    ].join('\n');

    const { chat } = require('./services/ollama-client');
    const responseText = await chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      user.settings?.ollamaUrl || 'http://localhost:11434',
      user.settings?.ollamaModel || 'llama3.1:8b',
      user.settings?.ollamaApiKey || ''
    );

    return res.json({
      success: true,
      response: (responseText || '').trim() || 'No response received from model.',
      contextNote: `Used ${activeIndicatorSnapshot.length} active indicators and ${availableIndicators.length} available indicators.`
    });
  } catch (err) {
    console.error('[ChartCopilot] Error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Chart Copilot failed' });
  }
});

app.post('/api/copilot/chat', requireLogin, checkCopilotLimit, async (req, res) => {
  try {
    const coinId = String(req.body?.coinId || '').trim().toLowerCase();
    const question = String(req.body?.question || '').trim();
    const timeframe = String(req.body?.timeframe || '1h').toLowerCase();
    const activeIndicators = Array.isArray(req.body?.activeIndicators) ? req.body.activeIndicators : [];
    const out = await runChartCopilotForUser(req.session.userId, coinId, question, timeframe, activeIndicators);
    return res.json(out);
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, error: err.message || 'Copilot failed' });
  }
});

// ====================================================
// LLM CHAT API
// ====================================================
app.post('/api/llm-chat', requireLogin, checkLLMLimit, async (req, res) => {
  try {
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: 'messages array required' });
    }
    const { getMarketPulse } = require('./services/market-pulse');
    const { getTop3FullCached } = require('./services/market-scanner');
    const { runChat } = require('./services/llm-chat');
    const deps = {
      User, Trade, getPerformanceStats, closeTrade, closeTradePartial, updateTradeLevels, fetchLivePrice, openTrade,
      fetchAllPrices, fetchAllCandles, fetchAllHistory, buildEngineOptions, analyzeAllCoins,
      getScoreHistory, getRegimeTimeline, getMarketPulse, getTop3FullCached, runBacktest
    };
    const executeActions = req.body?.executeActions === true;
    const result = await runChat(req.session.userId, messages, deps, { executeActions });
    res.json(result);
  } catch (err) {
    console.error('[LLM-Chat] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/llm/chat', requireLogin, checkLLMLimit, async (req, res) => {
  try {
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: 'messages array required' });
    }
    const executeActions = req.body?.executeActions === true;
    const result = await runLlmChatForUser(req.session.userId, messages, executeActions);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || 'LLM chat failed' });
  }
});

// ====================================================
// LLM AGENT: Manual trigger
// ====================================================
const _llmAgentLastTrigger = {};
app.post('/api/llm-agent/run', requireLogin, async (req, res) => {
  try {
    const uid = req.session.userId;
    const now = Date.now();
    if (_llmAgentLastTrigger[uid] && now - _llmAgentLastTrigger[uid] < 60000) {
      return res.status(429).json({ success: false, error: 'Wait 1 minute between runs' });
    }
    _llmAgentLastTrigger[uid] = now;
    const { getMarketPulse } = require('./services/market-pulse');
    const { getTop3FullCached } = require('./services/market-scanner');
    const deps = {
      User, Trade, runBacktest, getPerformanceStats, closeTrade, closeTradePartial, updateTradeLevels, fetchLivePrice, openTrade,
      fetchAllPrices, fetchAllCandles, fetchAllHistory, buildEngineOptions, analyzeAllCoins,
      getScoreHistory, getRegimeTimeline, getMarketPulse, getTop3FullCached
    };
    const result = await runAgent(uid, deps, { source: 'manual' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// OLLAMA STATUS (check if local LLM is reachable)
// ====================================================
app.get('/api/ollama/status', requireLogin, async (req, res) => {
  try {
    const url = req.query.url || req.session?.ollamaUrl || 'http://localhost:11434';
    const apiKey = req.query.apiKey || req.session?.ollamaApiKey || '';
    const result = await checkOllamaReachable(url, apiKey);
    res.json({ success: true, reachable: result.ok, error: result.error });
  } catch (err) {
    res.status(500).json({ success: false, reachable: false, error: err.message });
  }
});

// ====================================================
// AUTO-TRADE DEBUG: Diagnose why no trades are opening
// ====================================================
app.get('/api/auto-trade-debug', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const autoTradeOn = user.settings?.autoTrade === true;
    const minScore = user.settings?.autoTradeMinScore ?? user.liveTrading?.autoOpenMinScore ?? 56;
    const maxOpen = user.settings?.maxOpenTrades || 3;
    const cooldownHours = user.settings?.cooldownHours ?? 6;
    const llmEnabled = user.settings?.llmEnabled === true;
    const mode = user.settings?.autoTradeCoinsMode || (user.settings?.autoTradeTopMarketPick ? 'tracked+top1' : 'tracked');

    const openTrades = await Trade.find({ userId: user._id, status: 'OPEN' }).lean();
    const openCount = openTrades.length;
    const cooldownMs = cooldownHours * 3600 * 1000;
    const recentTrades = await Trade.find({
      userId: user._id,
      status: { $ne: 'OPEN' },
      exitTime: { $gte: new Date(Date.now() - cooldownMs) }
    }).select('coinId direction exitTime').lean();

    const [prices, allCandles, allHistory] = await Promise.all([
      fetchAllPrices(),
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory()
    ]);

    let signals = [];
    if (mode === 'tracked' || mode === 'tracked+top1') {
      const options = await buildEngineOptions(prices, allCandles, allHistory, user);
      signals = analyzeAllCoins(prices, allCandles, allHistory, options) || [];
    }
    if (mode === 'tracked+top1' || mode === 'top1') {
      try {
        const { getTop1ForAutoTrade } = require('./services/market-scanner');
        const top1 = getTop1ForAutoTrade();
        if (top1 && top1.coin && (top1.score || 0) >= minScore) {
          const dir = (top1.signal === 'STRONG_BUY' || top1.signal === 'BUY') ? 'LONG' : (top1.signal === 'STRONG_SELL' || top1.signal === 'SELL') ? 'SHORT' : null;
          if (dir) signals.push({ ...top1, _overallScore: top1.score, _direction: dir, _coinId: top1.coin.id });
        }
      } catch (e) { /* ignore */ }
    }

    const signalsWithDir = signals.map(sig => {
      const coinId = sig.coin?.id || sig.id;
      let direction = null;
      if (sig.topStrategies?.length) {
        for (const s of sig.topStrategies) {
          if (['STRONG_BUY','BUY','STRONG_SELL','SELL'].includes(s.signal)) {
            direction = s.signal.includes('BUY') ? 'LONG' : 'SHORT';
            break;
          }
        }
      }
      if (!direction && (sig.signal === 'STRONG_BUY' || sig.signal === 'BUY')) direction = 'LONG';
      if (!direction && (sig.signal === 'STRONG_SELL' || sig.signal === 'SELL')) direction = 'SHORT';
      return { ...sig, _overallScore: sig.score || 0, _direction: direction, _coinId: coinId };
    });

    const actionableCount = signalsWithDir.filter(s => s._direction && (s._overallScore || 0) >= minScore).length;
    const openCoinIds = openTrades.map(t => t.coinId);
    const cooldownSet = new Set(recentTrades.map(t => `${t.coinId}_${t.direction}`));
    const excluded = user.excludedCoins || [];
    const minRr = (user.settings?.minRiskRewardEnabled ?? true) ? (Number(user.settings?.minRiskReward) || 1.5) : 0;

    const blockedReasons = [];
    if (!autoTradeOn) blockedReasons.push('Auto-trade is OFF. Enable it in Performance settings.');
    if (openCount >= maxOpen) blockedReasons.push(`Max open trades (${maxOpen}) reached. Close a trade first.`);
    if (!prices || prices.length === 0) blockedReasons.push('No price data. API may be down or cold start.');
    if (signals.length === 0) blockedReasons.push(`No signals from engine. Mode=${mode}. Check candles/history.`);
    if (actionableCount === 0 && signals.length > 0) blockedReasons.push(`No signals meet minScore ${minScore} or all are HOLD.`);
    if (llmEnabled) blockedReasons.push('LLM approval is ON. Ollama may be rejecting trades. Try disabling to test.');

    const topSignals = signalsWithDir
      .filter(s => s._direction)
      .sort((a, b) => (b._overallScore || 0) - (a._overallScore || 0))
      .slice(0, 10)
      .map(s => {
        const rr = s.riskReward ?? s.topStrategies?.[0]?.riskReward ?? 0;
        return {
          coin: s._coinId,
          score: s._overallScore,
          direction: s._direction,
          signal: s.signal,
          riskReward: rr,
          blockedBy: [
            (s._overallScore || 0) < minScore ? `score<${minScore}` : null,
            openCoinIds.includes(s._coinId) ? 'already_open' : null,
            cooldownSet.has(`${s._coinId}_${s._direction}`) ? 'cooldown' : null,
            excluded.includes(s._coinId) ? 'excluded' : null,
            minRr > 0 && rr < minRr ? `rr<${minRr}` : null
          ].filter(Boolean)
        };
      });

    res.json({
      autoTradeOn,
      mode,
      minScore,
      maxOpen,
      openCount,
      cooldownHours,
      llmEnabled,
      pricesCount: prices?.length || 0,
      signalsCount: signals.length,
      actionableCount,
      recentTradesInCooldown: recentTrades.length,
      blockedReasons,
      topSignals,
      suggestion: blockedReasons.length > 0 ? blockedReasons[0] : (topSignals.length === 0 ? 'No actionable signals. Try lowering minScore to 52 or shortening cooldown.' : 'Signals exist. If still no trades: check Expectancy Filter (Feature Toggles), LLM rejection, or correlation filter.')
    });
  } catch (err) {
    console.error('[AutoTrade-Debug]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// AUTO-TRADE: Periodically scan signals for users with autoTrade enabled
// Opens paper trades (and live if Bitget connected) automatically
// when signal score meets threshold. Runs every 2 minutes.
// ====================================================
async function runAutoTrade() {
  if (!dbConnected) return; // Skip if no database
  try {
    // Find all users with autoTrade enabled
    const autoTradeUsers = await User.find({ 'settings.autoTrade': true }).lean();
    if (autoTradeUsers.length === 0) return;

    const [prices, allCandles, allHistory] = await Promise.all([
      fetchAllPrices(),
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory()
    ]);
    if (!prices || prices.length === 0) return;

    const strategyStatsForOpen = {};
    try {
      const allStratWeights = await getStrategyWeightsCached();
      allStratWeights.forEach(s => {
        strategyStatsForOpen[s.strategyId] = {
          totalTrades: s.performance?.totalTrades || 0,
          winRate: s.performance?.winRate || 0,
          avgRR: s.performance?.avgRR || 0
        };
      });
    } catch (e) { /* non-fatal */ }

    // Filter by overall score (multi-TF confluence), rank by overall score, execute with best strategy levels
    // Overall score = quality gate; best strategy = how to trade (direction, SL, TP)
    for (const user of autoTradeUsers) {
      try {
        const options = await buildEngineOptions(prices, allCandles, allHistory, user);
        const mode = user.settings?.autoTradeCoinsMode || (user.settings?.autoTradeTopMarketPick ? 'tracked+top1' : 'tracked');
        let signals = [];

        if (mode === 'tracked' || mode === 'tracked+top1') {
          const analyzed = analyzeAllCoins(prices, allCandles, allHistory, options);
          signals = analyzed || [];
        }

        if (mode === 'tracked+top1' || mode === 'top1') {
          try {
            const { getTop1ForAutoTrade } = require('./services/market-scanner');
            const top1 = getTop1ForAutoTrade();
            if (top1 && top1.coin) {
              const c = top1.coin;
              registerScannerCoinMeta(c.id, c.symbol);
              const dir = (top1.signal === 'STRONG_BUY' || top1.signal === 'BUY') ? 'LONG'
                : (top1.signal === 'STRONG_SELL' || top1.signal === 'SELL') ? 'SHORT' : null;
              if (dir && (top1.score || 0) >= (user.settings?.autoTradeMinScore ?? 56)) {
                signals = [...signals, { ...top1, _overallScore: top1.score, _bestStrat: top1.topStrategies?.[0] || { stopLoss: top1.stopLoss, takeProfit1: top1.takeProfit1, takeProfit2: top1.takeProfit2, takeProfit3: top1.takeProfit3, entry: top1.entry, riskReward: top1.riskReward, id: top1.strategyType }, _direction: dir, _coinId: c.id, _bestScore: top1.score }];
              }
            }
          } catch (e) { /* scanner not ready */ }
        }

        const signalMode = (user.settings?.autoTradeSignalMode === 'indicators') ? 'original' : (user.settings?.autoTradeSignalMode || 'original');
        const autoTradeUseSetups = user.settings?.autoTradeUseSetups === true;
        const setupIds = user.settings?.autoTradeSetupIds || [];

        if ((signalMode === 'setups' || signalMode === 'both' || autoTradeUseSetups) && setupIds.length > 0) {
          const { evaluateSetupsForAutoTrade } = require('./services/smc-scanner');
          const setupOpts = user.settings?.minVolume24hUsd != null ? { minVolume24hUsd: user.settings.minVolume24hUsd } : null;
          const setupSignals = evaluateSetupsForAutoTrade(setupIds, allCandles, TRACKED_COINS, prices, setupOpts);
          if (signalMode === 'setups') {
            signals = setupSignals;
          } else {
            const bothLogic = user.settings?.autoTradeBothLogic || 'or';
            if (bothLogic === 'or') {
              const origIds = new Set(signals.map(s => s._coinId));
              for (const ss of setupSignals) {
                if (!origIds.has(ss._coinId)) signals.push(ss);
              }
            } else {
              const setupCoinIdSet = new Set(setupSignals.map(s => s._coinId));
              signals = signals.filter(s => setupCoinIdSet.has(s._coinId));
            }
          }
        }

        const signalsWithBestStrategy = signals.map(sig => {
          const coinId = sig.coin?.id || sig.id || sig._coinId;
          let overallScore = sig._overallScore ?? sig.score ?? 0;
          let bestStrat = sig._bestStrat || null;
          let direction = sig._direction || null;

          if (sig.topStrategies && Array.isArray(sig.topStrategies)) {
            for (const strat of sig.topStrategies) {
              const stratSignal = strat.signal || '';
              if (stratSignal === 'STRONG_BUY' || stratSignal === 'BUY' || stratSignal === 'STRONG_SELL' || stratSignal === 'SELL') {
                const stratDir = (stratSignal === 'STRONG_BUY' || stratSignal === 'BUY') ? 'LONG' : 'SHORT';
                if (!bestStrat || (strat.score || 0) > (bestStrat.score || 0)) {
                  bestStrat = strat;
                  direction = stratDir;
                }
              }
            }
          }
          if (!direction) {
            if (sig.signal === 'STRONG_BUY' || sig.signal === 'BUY') direction = 'LONG';
            else if (sig.signal === 'STRONG_SELL' || sig.signal === 'SELL') direction = 'SHORT';
          }
          return { ...sig, _overallScore: overallScore, _bestStrat: bestStrat, _direction: direction, _coinId: coinId };
        });
        // Use paper trading min score from settings, fallback to exchange setting, then default 70
        const minScore = user.settings?.autoTradeMinScore ?? user.liveTrading?.autoOpenMinScore ?? 56;
        const confidenceFilterEnabled = user.settings?.featureConfidenceFilterEnabled === true;
        const minConfidence = Math.max(0, Math.min(100, Number(user.settings?.minConfidence ?? 60)));
        const maxOpen = user.settings?.maxOpenTrades || 3;
        const openTrades = await Trade.find({ userId: user._id, status: 'OPEN' }).lean();
        if (openTrades.length >= maxOpen) continue;

        const openCoinIds = openTrades.map(t => t.coinId);
        // Cooldown check
        const cooldownMs = (user.settings?.cooldownHours ?? 6) * 3600 * 1000;
        const recentTrades = await Trade.find({
          userId: user._id,
          status: { $ne: 'OPEN' },
          exitTime: { $gte: new Date(Date.now() - cooldownMs) }
        }).select('coinId direction').lean();
        const cooldownSet = new Set(recentTrades.map(t => `${t.coinId}_${t.direction}`));

        // Filter by overall score >= threshold, rank by overall score (weighted), use best strategy for levels
        const userExcluded = user.excludedCoins || [];
        const coinWeights = user.coinWeights || {};
        const coinWeightEnabled = user.coinWeightEnabled === true;
        const strength = user.coinWeightStrength || 'moderate';
        const strengthMult = { conservative: 0.25, moderate: 1, aggressive: 1.5 }[strength] ?? 1;
        const effectiveWeight = (coinId, baseW) => {
          if (!coinWeightEnabled || baseW == null) return 1;
          return 1 + (baseW - 1) * strengthMult;
        };
        const minRr = (user.settings?.minRiskRewardEnabled ?? true) ? (Number(user.settings?.minRiskReward) || 1.5) : 0;
        // Setup signals use a separate (lower) min score — SMC setups are quality-gated
        // by phase completion, not by the scoring engine, so the main minScore doesn't apply cleanly.
        const setupMinScore = user.settings?.autoTradeSetupMinScore ?? 55;
        const candidates = signalsWithBestStrategy.filter(sig => {
          const threshold = sig._isSetupSignal ? setupMinScore : minScore;
          if (sig._overallScore < threshold) return false;
          if (!sig._direction) return false; // HOLD signals ignored
          if (confidenceFilterEnabled) {
            const conf = Number(sig.confidence);
            if (!Number.isFinite(conf) || conf < minConfidence) return false;
          }
          if (openCoinIds.includes(sig._coinId)) return false;
          if (cooldownSet.has(`${sig._coinId}_${sig._direction}`)) return false;
          if (userExcluded.includes(sig._coinId)) return false; // Skip excluded coins
          if (minRr > 0) {
            const effectiveRr = sig._bestStrat?.riskReward ?? sig.riskReward ?? 0;
            if (effectiveRr < minRr) return false;
          }
          return true;
        }).sort((a, b) => {
          const baseA = coinWeights[a._coinId] ?? 1;
          const baseB = coinWeights[b._coinId] ?? 1;
          const weightA = effectiveWeight(a._coinId, baseA);
          const weightB = effectiveWeight(b._coinId, baseB);
          return (b._overallScore * weightB) - (a._overallScore * weightA);
        });

        const slotsAvailable = maxOpen - openTrades.length;
        const toOpen = candidates.slice(0, slotsAvailable);

        for (const sig of toOpen) {
          try {
            const coinId = sig._coinId;
            let coinData = prices.find(p => p.id === coinId);
            if (!coinData && sig.coin) coinData = sig.coin; // Market-scanner top pick
            if (!coinData) continue;
            const livePrice = await fetchLivePrice(coinId);
            if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) continue;

            // Use the best strategy's levels ONLY — do NOT fall back to overall signal levels.
            // The overall signal might be in the OPPOSITE direction (e.g. overall SELL but
            // best strategy says BUY). Mixing SHORT TPs with a LONG trade causes instant
            // TP3 "hits" at prices below entry, closing with massive losses.
            const strat = sig._bestStrat;
            const useStratType = (strat && strat.id) || sig.strategyType || 'auto';

            // Only use levels from the SAME direction as our trade
            const sigDirMatchesTrade = (sig._direction === 'LONG')
              ? (sig.signal === 'STRONG_BUY' || sig.signal === 'BUY')
              : (sig.signal === 'STRONG_SELL' || sig.signal === 'SELL');

            let useSL = (strat && strat.stopLoss) || (sigDirMatchesTrade ? sig.stopLoss : null);
            let useTP1 = (strat && strat.takeProfit1) || (sigDirMatchesTrade ? sig.takeProfit1 : null);
            let useTP2 = (strat && strat.takeProfit2) || (sigDirMatchesTrade ? sig.takeProfit2 : null);
            let useTP3 = (strat && strat.takeProfit3) || (sigDirMatchesTrade ? sig.takeProfit3 : null);

            // Sanity: for LONG, TPs must be ABOVE entry; for SHORT, TPs must be BELOW entry.
            // If any TP is on the wrong side (from a direction mismatch), null it out.
            const metaSym = getCoinMeta(coinId)?.symbol || coinData?.symbol || coinId;
            if (sig._direction === 'LONG') {
              if (useTP1 && useTP1 <= livePrice * 0.99) { if (process.env.NODE_ENV !== 'production') console.warn(`[AutoTrade] ${metaSym}: TP1 $${useTP1} below entry $${livePrice} for LONG — removed`); useTP1 = null; }
              if (useTP2 && useTP2 <= livePrice * 0.99) { if (process.env.NODE_ENV !== 'production') console.warn(`[AutoTrade] ${metaSym}: TP2 $${useTP2} below entry $${livePrice} for LONG — removed`); useTP2 = null; }
              if (useTP3 && useTP3 <= livePrice * 0.99) { if (process.env.NODE_ENV !== 'production') console.warn(`[AutoTrade] ${metaSym}: TP3 $${useTP3} below entry $${livePrice} for LONG — removed`); useTP3 = null; }
              if (useSL && useSL >= livePrice * 1.01) { if (process.env.NODE_ENV !== 'production') console.warn(`[AutoTrade] ${metaSym}: SL $${useSL} above entry $${livePrice} for LONG — removed`); useSL = null; }
            } else {
              if (useTP1 && useTP1 >= livePrice * 1.01) { if (process.env.NODE_ENV !== 'production') console.warn(`[AutoTrade] ${metaSym}: TP1 $${useTP1} above entry $${livePrice} for SHORT — removed`); useTP1 = null; }
              if (useTP2 && useTP2 >= livePrice * 1.01) { if (process.env.NODE_ENV !== 'production') console.warn(`[AutoTrade] ${metaSym}: TP2 $${useTP2} above entry $${livePrice} for SHORT — removed`); useTP2 = null; }
              if (useTP3 && useTP3 >= livePrice * 1.01) { if (process.env.NODE_ENV !== 'production') console.warn(`[AutoTrade] ${metaSym}: TP3 $${useTP3} above entry $${livePrice} for SHORT — removed`); useTP3 = null; }
              if (useSL && useSL <= livePrice * 0.99) { if (process.env.NODE_ENV !== 'production') console.warn(`[AutoTrade] ${metaSym}: SL $${useSL} below entry $${livePrice} for SHORT — removed`); useSL = null; }
            }

            // If no SL from strategy, calculate a default ATR-based one
            if (!useSL) {
              const defaultSlPct = 0.05; // 5% default stop
              useSL = sig._direction === 'LONG' ? livePrice * (1 - defaultSlPct) : livePrice * (1 + defaultSlPct);
              useSL = parseFloat(useSL.toFixed(6));
            }

            // Recalculate SL/TP relative to live price if analysis used a different price
            const analysisEntry = (strat && strat.entry) || (sigDirMatchesTrade ? sig.entry : null) || (coinData && coinData.price);
            if (analysisEntry && analysisEntry > 0 && useSL && Math.abs(livePrice - analysisEntry) / analysisEntry > 0.005) {
              const ratio = livePrice / analysisEntry;
              useSL = parseFloat((useSL * ratio).toFixed(6));
              if (useTP1) useTP1 = parseFloat((useTP1 * ratio).toFixed(6));
              if (useTP2) useTP2 = parseFloat((useTP2 * ratio).toFixed(6));
              if (useTP3) useTP3 = parseFloat((useTP3 * ratio).toFixed(6));
              if (process.env.NODE_ENV !== 'production') console.log(`[AutoTrade] ${metaSym}: Scaled levels by ${ratio.toFixed(4)} (analysis=$${analysisEntry} live=$${livePrice})`);
            }

            const signalLev = sig.suggestedLeverage || suggestLeverage(sig._bestScore, sig.regime || 'mixed', 'normal');
            const useFixed = user.settings?.useFixedLeverage;
            const lev = user.settings?.disableLeverage ? 1 : (useFixed ? (user.settings?.defaultLeverage ?? 2) : signalLev);
            const tradeData = {
              coinId,
              symbol: getCoinMeta(coinId)?.symbol || coinData?.symbol || coinId.toUpperCase(),
              direction: sig._direction,
              entry: livePrice,
              stopLoss: useSL,
              takeProfit1: useTP1,
              takeProfit2: useTP2,
              takeProfit3: useTP3,
              volume24h: coinData?.volume24h,
              leverage: lev,
              score: sig._overallScore,
              confidence: Number.isFinite(Number(sig.confidence)) ? Number(sig.confidence) : null,
              strategyType: useStratType,
              regime: sig.regime || 'unknown',
              reasoning: sig.reasoning || [],
              indicators: sig.indicators || {},
              scoreBreakdown: sig.scoreBreakdown || {},
              stopType: sig.stopType || 'ATR_SR_FIB',
              stopLabel: sig.stopLabel || 'ATR + S/R + Fib',
              tpType: sig.tpType || 'R_multiple',
              tpLabel: sig.tpLabel || 'R multiples',
              strategyStats: strategyStatsForOpen,
              autoTriggered: true
            };

            // LLM approval gate (Ollama) — when enabled, ask local LLM with full context
            if (user.settings?.llmEnabled) {
              let marketPulseForApproval = null;
              try { const { getMarketPulse: gmp } = require('./services/market-pulse'); marketPulseForApproval = await gmp(); } catch (e) { /* ignore */ }

              let stratPerf = null;
              try {
                const sp = strategyStatsForOpen[useStratType];
                if (sp) {
                  stratPerf = { ...sp };
                  const StrategyWeight = require('./models/StrategyWeight');
                  const sw = await StrategyWeight.findOne({ strategyId: useStratType }).lean();
                  if (sw?.performance?.byRegime?.[sig.regime || 'mixed']) {
                    const rd = sw.performance.byRegime[sig.regime || 'mixed'];
                    const rdTotal = (rd.wins || 0) + (rd.losses || 0);
                    stratPerf.regimeWinRate = rdTotal > 0 ? (rd.wins / rdTotal) * 100 : null;
                    stratPerf.regimeTrades = rdTotal;
                    stratPerf.profitFactor = sw.performance.profitFactor || 0;
                  }
                }
              } catch (e) { /* ignore */ }

              const openTradesCount = await Trade.countDocuments({ userId: user._id, status: 'OPEN' });

              const llmResult = await approveTrade({
                coinId,
                symbol: tradeData.symbol,
                direction: sig._direction,
                score: sig._overallScore,
                confidence: sig.confidence,
                scoreBreakdown: sig.scoreBreakdown,
                reasoning: sig.reasoning,
                strategy: useStratType,
                regime: sig.regime || 'unknown',
                riskReward: sig._bestStrat?.riskReward ?? sig.riskReward,
                indicators: sig.indicators,
                marketPulse: marketPulseForApproval,
                strategyPerformance: stratPerf,
                openTradesCount,
                maxOpenTrades: user.settings?.maxOpenTrades ?? 3,
                balance: user.paperBalance ?? 10000,
                timeframes: sig.timeframes ? { '1H': sig.timeframes['1H']?.score, '4H': sig.timeframes['4H']?.score, '1D': sig.timeframes['1D']?.score } : null,
                entry: livePrice,
                stopLoss: useSL,
                takeProfit1: useTP1,
                takeProfit2: useTP2,
                takeProfit3: useTP3,
                atr: sig.indicators?.atr,
                userDefaults: {
                  tpMode: user.settings?.tpMode || 'fixed',
                  trailingTpDistanceMode: user.settings?.trailingTpDistanceMode || 'atr',
                  trailingTpAtrMultiplier: user.settings?.trailingTpAtrMultiplier ?? 1.5,
                  trailingTpFixedPercent: user.settings?.trailingTpFixedPercent ?? 2,
                  useFixedLeverage: user.settings?.useFixedLeverage ?? false,
                  defaultLeverage: user.settings?.defaultLeverage ?? 2
                },
                recentPerformance: {
                  wins: user.stats?.wins || 0,
                  losses: user.stats?.losses || 0,
                  streak: user.stats?.currentStreak || 0
                }
              }, user.settings?.ollamaUrl || 'http://localhost:11434', user.settings?.ollamaModel || 'llama3.1:8b', user.settings?.ollamaApiKey || '');

              if (!llmResult.approve) {
                if (process.env.NODE_ENV !== 'production') console.log(`[AutoTrade] LLM rejected ${tradeData.symbol} ${sig._direction} for ${user.username}: ${llmResult.reasoning || 'no reason'}`);
                continue;
              }

              tradeData.llmConfidence = llmResult.confidence;
              tradeData.llmReasoning = llmResult.reasoning;

              // Apply LLM overrides (stop, TPs, tpMode, trailing, leverage) for this trade
              if (llmResult.overrides && Object.keys(llmResult.overrides).length > 0) {
                tradeData.llmOverrides = llmResult.overrides;
                if (llmResult.overrides.stopLoss != null) tradeData.stopLoss = llmResult.overrides.stopLoss;
                if (llmResult.overrides.takeProfit1 != null) tradeData.takeProfit1 = llmResult.overrides.takeProfit1;
                if (llmResult.overrides.takeProfit2 != null) tradeData.takeProfit2 = llmResult.overrides.takeProfit2;
                if (llmResult.overrides.takeProfit3 != null) tradeData.takeProfit3 = llmResult.overrides.takeProfit3;
                if (llmResult.overrides.leverage != null) tradeData.leverage = llmResult.overrides.leverage;
                if (process.env.NODE_ENV !== 'production') console.log(`[AutoTrade] LLM overrides for ${tradeData.symbol}:`, JSON.stringify(llmResult.overrides));
              }

              // Modulate position via confidence: <50 confidence = reduce size by up to 30%
              if (llmResult.confidence > 0 && llmResult.confidence < 50) {
                const sizeMult = 0.7 + (llmResult.confidence / 50) * 0.3;
                if (process.env.NODE_ENV !== 'production') console.log(`[AutoTrade] LLM low confidence (${llmResult.confidence}) on ${tradeData.symbol} — sizing x${sizeMult.toFixed(2)}`);
                tradeData.llmSizeMultiplier = sizeMult;
              }
            }

            await openTrade(user._id, tradeData);
            if (process.env.NODE_ENV !== 'production') console.log(`[AutoTrade] Opened ${sig._direction} on ${tradeData.symbol} (overall ${sig._overallScore}, strat: ${useStratType}) for user ${user.username}`);
          } catch (tradeErr) {
            console.error(`[AutoTrade] Failed to open ${sig._coinId} for ${user.username}:`, tradeErr.message);
          }
        }
      } catch (userErr) {
        console.error(`[AutoTrade] Error for user ${user.username}:`, userErr.message);
      }
    }
  } catch (err) {
    console.error('[AutoTrade] Error:', err.message);
  }
}
if (IS_PRIMARY_WORKER) {
  trackInterval(() => runNonOverlapping('runAutoTrade', runAutoTrade), 2 * 60 * 1000);
  trackTimeout(() => runNonOverlapping('runAutoTrade', runAutoTrade), 45 * 1000);
}

async function buildSignalForCoin(coinId, userForOptions) {
  const [prices, allCandles, allHistory] = await Promise.all([
    fetchAllPrices(),
    Promise.resolve(fetchAllCandles()),
    fetchAllHistory()
  ]);
  const coinData = (prices || []).find(p => p.id === coinId);
  if (!coinData) return null;
  const options = await buildEngineOptions(prices, allCandles, allHistory, userForOptions || null);
  const candles = (allCandles && allCandles[coinId]) || fetchCandles(coinId);
  const history = (allHistory && allHistory[coinId]) || { prices: [], volumes: [] };
  return analyzeCoin(coinData, candles, history, options);
}

async function runFreeSignalDiscordUpdate() {
  if (!dbConnected) return;
  try {
    await runPeriodicFreeSignalUpdate(buildSignalForCoin, { openTradeFn: openTrade });
  } catch (err) {
    console.warn('[FreeSignal] periodic update failed:', err.message);
  }
}
if (IS_PRIMARY_WORKER) {
  trackInterval(() => runNonOverlapping('runFreeSignalDiscordUpdate', runFreeSignalDiscordUpdate), 5 * 60 * 1000);
  trackTimeout(() => runNonOverlapping('runFreeSignalDiscordUpdate', runFreeSignalDiscordUpdate), 60 * 1000);
}

async function runCandleCacheSyncJob() {
  if (!dbConnected) return;
  try {
    const out = await syncAllCandles({ coins: TRACKED_COINS, timeframes: CACHE_TIMEFRAMES });
    console.log(`[Cache] Candle cache updated: ${(out.newCandles || 0).toLocaleString()} new candles added across ${TRACKED_COINS.length} coins`);
    if (out.failed && out.failed.length > 0) {
      console.warn(`[Cache] Sync failures: ${out.failed.length}`);
    }
  } catch (err) {
    console.warn('[Cache] Sync job failed:', err.message);
  }
}
if (IS_PRIMARY_WORKER) {
  trackInterval(() => runNonOverlapping('runCandleCacheSyncJob', runCandleCacheSyncJob), 30 * 60 * 1000);
  trackTimeout(() => runNonOverlapping('runCandleCacheSyncJob', runCandleCacheSyncJob), 2 * 60 * 1000);
}

async function runMonthlyCandleCacheCleanup() {
  if (!dbConnected) return;
  try {
    const out = await cleanupOldCandles();
    console.log(`[Cache] Monthly cleanup deleted ${(out.deletedCount || 0).toLocaleString()} candles older than 3 years`);
  } catch (err) {
    console.warn('[Cache] Cleanup failed:', err.message);
  }
}
if (IS_PRIMARY_WORKER) {
  trackInterval(() => runNonOverlapping('runMonthlyCandleCacheCleanup', runMonthlyCandleCacheCleanup), 30 * 24 * 60 * 60 * 1000);
}

// ====================================================
// LLM AGENT: Autonomous agent that can change settings, run backtests
// Runs periodically for users with llmAgentEnabled
// ====================================================
async function runLlmAgentForUsers() {
  if (!dbConnected) return;
  try {
    const users = await User.find({ 'settings.llmAgentEnabled': true }).select('_id settings llmAgentLastRun').lean();
    const { getMarketPulse } = require('./services/market-pulse');
    const { getTop3FullCached } = require('./services/market-scanner');
    const deps = {
      User, Trade, runBacktest, getPerformanceStats, closeTrade, closeTradePartial, updateTradeLevels, fetchLivePrice, openTrade,
      fetchAllPrices, fetchAllCandles, fetchAllHistory, buildEngineOptions, analyzeAllCoins,
      getScoreHistory, getRegimeTimeline, getMarketPulse, getTop3FullCached
    };
    for (const u of users) {
      const intervalMin = u.settings?.llmAgentIntervalMinutes ?? 60;
      const lastRun = u.llmAgentLastRun?.at ? new Date(u.llmAgentLastRun.at).getTime() : 0;
      if (Date.now() - lastRun < intervalMin * 60 * 1000) continue;
      try {
        const result = await runAgent(u._id, deps, { source: 'scheduled' });
        if (result.success && (result.actionsExecuted?.length || result.actionsFailed?.length)) {
          if (process.env.NODE_ENV !== 'production') console.log(`[LLMAgent] ${u._id}: ${result.actionsExecuted?.length || 0} ok, ${result.actionsFailed?.length || 0} failed`);
        }
      } catch (err) {
        console.warn('[LLMAgent]', err.message);
      }
    }
  } catch (err) {
    console.warn('[LLMAgent]', err.message);
  }
}
if (IS_PRIMARY_WORKER) {
  trackInterval(() => runNonOverlapping('runLlmAgentForUsers', runLlmAgentForUsers), 5 * 60 * 1000);
  trackTimeout(() => runNonOverlapping('runLlmAgentForUsers', runLlmAgentForUsers), 5 * 60 * 1000);
}

// ====================================================
// SCORE HISTORY API (track score evolution per coin)
// ====================================================
app.get('/api/score-history/:coinId', async (req, res) => {
  try {
    const coinId = req.params.coinId;
    if (!TRACKED_COINS.includes(coinId)) {
      return res.status(404).json({ success: false, error: 'Coin not found' });
    }
    const history = getScoreHistory(coinId);
    res.json({ success: true, coinId, history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// STRATEGY COMPARISON API (side-by-side current strategy scores)
// ====================================================
app.get('/api/strategy-comparison', async (req, res) => {
  try {
    const [prices, allCandles, allHistory] = await Promise.all([
      fetchAllPrices(),
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory()
    ]);
    const pricesMerged = mergeWebSocketPrices(prices);
    let compUser = null;
    if (req.session?.userId) {
      try {
        compUser = await User.findById(req.session.userId).select('settings disabledRegimesByCoin').lean();
      } catch (e) { /* ignore */ }
    }
    const options = await buildEngineOptions(pricesMerged, allCandles, allHistory, compUser);
    const signals = analyzeAllCoins(pricesMerged, allCandles, allHistory, options);

    // Build comparison: for each coin, show all strategy scores
    const comparison = signals.map(sig => ({
      coin: sig.coin.symbol,
      coinId: sig.coin.id,
      price: sig.coin.price,
      overallScore: sig.score,
      signal: sig.signal,
      regime: sig.regime,
      bestStrategy: sig.strategyName,
      strategies: (sig.topStrategies || []).map(s => ({
        id: s.id,
        name: s.name,
        score: s.score,
        signal: s.signal,
        riskReward: s.riskReward
      }))
    }));

    res.json({ success: true, comparison });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// STRATEGY COMPARISON PAGE
// ====================================================
app.get('/strategy-comparison', cacheResponse('strategy-comparison', 30), async (req, res) => {
  try {
    const [prices, allCandles, allHistory] = await Promise.all([
      fetchAllPrices(),
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory()
    ]);
    const pricesMerged = mergeWebSocketPrices(prices);
    let compUser = null;
    if (req.session?.userId) {
      try {
        compUser = await User.findById(req.session.userId).select('settings disabledRegimesByCoin').lean();
      } catch (e) { /* ignore */ }
    }
    const options = await buildEngineOptions(pricesMerged, allCandles, allHistory, compUser);
    let signals = analyzeAllCoins(pricesMerged, allCandles, allHistory, options) || [];

    // Add top 3 market picks to comparison (they change each scan)
    try {
      const top3Full = require('./services/market-scanner').getTop3FullCached();
      top3Full.forEach(s => {
        if (s && s.coin && !signals.some(x => x.coin?.id === s.coin.id)) {
          signals = [...signals, s];
        }
      });
    } catch (e) { /* ignore */ }

    // Get learning engine data
    const strategies = await StrategyWeight.find({}).lean();

    // Recommendation: most common regime + best strategy for that regime
    const regimeCounts = {};
    signals.forEach(s => {
      const r = s.regime || 'unknown';
      regimeCounts[r] = (regimeCounts[r] || 0) + 1;
    });
    const topRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0];
    let recommendation = 'Use default blended signal.';
    if (topRegime && strategies.length > 0) {
      const [regime, count] = topRegime;
      const bestForRegime = strategies
        .filter(s => s.performance?.byRegime?.[regime])
        .map(s => {
          const rd = s.performance.byRegime[regime];
          const total = (rd.wins || 0) + (rd.losses || 0);
          const wr = total > 0 ? (rd.wins / total) * 100 : 0;
          return { name: s.name || s.strategyId, wr, total };
        })
        .filter(s => s.total >= 3)
        .sort((a, b) => b.wr - a.wr)[0];
      if (bestForRegime) {
        recommendation = `${count} coin(s) in ${regime} regime. Best strategy: ${bestForRegime.name} (${bestForRegime.wr.toFixed(0)}% WR in ${regime}).`;
      }
    }

    res.render('strategy-comparison', {
      activePage: 'comparison',
      signals,
      strategies,
      recommendation
    });
  } catch (err) {
    console.error('[StrategyComparison] Error:', err);
    res.status(500).send('Error loading strategy comparison');
  }
});

// ====================================================
// DATA SOURCE STATUS API
// ====================================================
app.get('/api/data-status', (req, res) => {
  const status = {};
  TRACKED_COINS.forEach(coinId => {
    const candles = fetchCandles(coinId);
    status[coinId] = {
      symbol: COIN_META[coinId]?.symbol,
      source: candles?._source || 'none',
      fresh: candles ? isCandleFresh(candles) : false,
      has1h: !!(candles && candles['1h'] && candles['1h'].length >= 20),
      has4h: !!(candles && candles['4h'] && candles['4h'].length >= 5),
      has1d: !!(candles && candles['1d'] && candles['1d'].length >= 5)
    };
  });
  res.json({ success: true, status, dataReady: isDataReady() });
});

// ====================================================
// MERGE WEBSOCKET PRICES (real-time overlay when available)
// ====================================================
function mergeWebSocketPrices(prices) {
  if (!prices || !Array.isArray(prices)) return prices || [];
  const wsPrices = getAllWebSocketPrices();
  if (Object.keys(wsPrices).length === 0) return prices;
  return prices.map(p => {
    const ws = wsPrices[p.id];
    if (!ws || !Number.isFinite(ws.price)) return p;
    return { ...p, price: ws.price, change24h: ws.change24h ?? p.change24h, volume24h: ws.volume24h ?? p.volume24h, _ws: true };
  });
}

// ====================================================
// START SERVER (wait for first price load so dashboard has data)
// ====================================================
const START_TIMEOUT = 140000;
const server = http.createServer(app);

// WebSocket server for real-time price broadcasts to browsers
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => {
  addBrowserClient(ws);
  ws.send(JSON.stringify({ type: 'connected', wsConnected: isWebSocketConnected() }));
});

// Real-time voice gateway (used when VOICE_TRANSPORT=mumble)
const voiceWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(request.url, 'http://localhost').pathname;
  } catch (e) {
    pathname = '';
  }
  console.log('[WS] upgrade request:', pathname || '(invalid)');
  if (pathname === '/ws/prices') {
    const wsOrigin = request.headers.origin || '';
    const wsHost = request.headers.host || '';
    if (wsOrigin && wsHost && wsOrigin.indexOf(wsHost) === -1) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
    return;
  }
  if (pathname !== '/ws/voice' && pathname !== '/voice') {
    console.log('[WS] path not found:', pathname);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const origin = request.headers.origin || '';
  const host = request.headers.host || '';
  if (origin && host && origin.indexOf(host) === -1) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const fakeRes = { getHeader() {}, setHeader() {}, end() {} };
  sessionMiddleware(request, fakeRes, () => {
    if (!request.session?.userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    voiceWss.handleUpgrade(request, socket, head, (ws) => {
      voiceWss.emit('connection', ws, request);
    });
  });
});

voiceWss.on('connection', (ws, req) => {
  console.log('[WS] Voice WebSocket connected');
  const uid = req.session?.userId;
  const state = {
    mode: 'llm',
    mimeType: 'audio/webm',
    chunks: [],
    meta: {}
  };

  function send(payload) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  send({ type: 'voice_ready', mode: (process.env.VOICE_TRANSPORT || 'http').toLowerCase(), lowLatency: true });

  ws.on('message', async (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(String(raw || '{}'));
    } catch (e) {
      send({ type: 'voice_error', error: 'Invalid voice payload' });
      return;
    }

    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'voice_start') {
      state.mode = msg.mode === 'chart' ? 'chart' : 'llm';
      state.mimeType = String(msg.mimeType || 'audio/webm');
      state.chunks = [];
      state.meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : {};
      send({ type: 'voice_status', stage: 'listening' });
      return;
    }
    if (msg.type === 'voice_chunk') {
      try {
        const buf = Buffer.from(String(msg.data || ''), 'base64');
        if (buf.length > 0) state.chunks.push(buf);
      } catch (e) {}
      return;
    }
    if (msg.type === 'voice_cancel') {
      state.chunks = [];
      state.meta = {};
      send({ type: 'voice_status', stage: 'idle' });
      return;
    }
    if (msg.type !== 'voice_stop') return;

    if (!state.chunks.length) {
      send({ type: 'voice_error', error: 'No audio chunks received' });
      return;
    }

    const totalStart = Date.now();
    try {
      send({ type: 'voice_status', stage: 'transcribing' });
      const merged = Buffer.concat(state.chunks);
      state.chunks = [];
      const user = await User.findById(uid);
      if (!user) throw new Error('Login required');
      const monthly = getMonthlyLimits(user);
      const estimatedMinutes = estimateAudioMinutes(merged, state.mimeType);
      const totalVoice = (user.voiceMinutesUsed || 0) + estimatedMinutes;
      const voiceCap = (monthly.voice || 0) + (user.voicePackMinutes || 0);
      if (voiceCap <= 0 || totalVoice > voiceCap) {
        throw new Error('Voice minutes exhausted. Buy a voice pack or upgrade.');
      }
      user.voiceMinutesUsed = totalVoice;

      const consumeMessageCredit = (kind) => {
        if (kind === 'chart') {
          const monthlyCap = monthly.copilot;
          const used = user.copilotQuestionsUsed || 0;
          const pack = user.copilotPackQuestions || 0;
          if (used >= monthlyCap && pack <= 0) throw new Error('Copilot limit reached. Buy a pack or upgrade.');
          if (used < monthlyCap) user.copilotQuestionsUsed = used + 1;
          else user.copilotPackQuestions = Math.max(0, pack - 1);
          return;
        }
        const monthlyCap = monthly.llm;
        const used = user.llmMessagesUsed || 0;
        const pack = user.llmPackMessages || 0;
        if (used >= monthlyCap && pack <= 0) throw new Error('LLM message limit reached. Buy a pack or upgrade.');
        if (used < monthlyCap) user.llmMessagesUsed = used + 1;
        else user.llmPackMessages = Math.max(0, pack - 1);
      };
      consumeMessageCredit(state.mode === 'chart' ? 'chart' : 'llm');
      await user.save();

      const tr = await transcribeWithWhisper(merged, state.mimeType);
      const transcript = String(tr.text || '').trim();
      if (!transcript) throw new Error('Could not transcribe audio clearly');
      send({ type: 'voice_transcript', text: transcript, latencyMs: tr.latencyMs || 0 });

      send({ type: 'voice_status', stage: 'thinking' });
      let responseText = '';
      let contextNote = '';
      let agentResult = null;
      let agentError = null;

      if (state.mode === 'chart') {
        const out = await runChartCopilotForUser(
          uid,
          state.meta.coinId || '',
          transcript,
          state.meta.timeframe || '1h',
          Array.isArray(state.meta.activeIndicators) ? state.meta.activeIndicators : []
        );
        responseText = String(out.response || '').trim();
        contextNote = out.contextNote || '';
      } else {
        const messages = Array.isArray(state.meta.messages) ? state.meta.messages.slice(-50) : [];
        messages.push({ role: 'user', content: transcript });
        const out = await runLlmChatForUser(uid, messages, state.meta.executeActions === true);
        if (!out || out.success !== true || !out.text) {
          throw new Error(out?.error || 'Failed to get response');
        }
        responseText = String(out.text || '').trim();
        agentResult = out.agentResult || null;
        agentError = out.agentError || null;
      }

      send({ type: 'voice_response', text: responseText, contextNote, agentResult, agentError });

      const speakResponse = state.meta.speakResponse !== false;
      if (speakResponse) {
        send({ type: 'voice_status', stage: 'speaking' });
        try {
          const tts = await synthesizeWithPiper(responseText);
          send({
            type: 'voice_audio',
            mimeType: tts.mimeType || 'audio/wav',
            data: tts.audioBuffer.toString('base64'),
            latencyMs: tts.latencyMs || 0
          });
        } catch (ttsErr) {
          send({ type: 'voice_error', error: ttsErr.message || 'Speech synthesis failed', scope: 'tts' });
        }
      }

      send({ type: 'voice_done', totalLatencyMs: Date.now() - totalStart });
    } catch (err) {
      send({ type: 'voice_error', error: err.message || 'Voice request failed' });
      send({ type: 'voice_status', stage: 'idle' });
    }
  });
});

// ====================================================
// TRENCH AUTO-TRADE SCHEDULER - admin only (runs for enabled bots)
// ====================================================
function startTrenchAutoTradeScheduler() {
  if (!IS_PRIMARY_WORKER) return;
  const trenchAuto = require('./services/trench-auto-trading');
  console.log('[TrenchAuto] Scheduler started (admin-only feature)');
  const runTrenchAuto = async () => {
    await trenchAuto.runTrenchAutoTrade();
  };
  trackInterval(() => runNonOverlapping('runTrenchAutoTrade', runTrenchAuto), 60 * 1000);
  trackTimeout(() => runNonOverlapping('runTrenchAutoTrade', runTrenchAuto), 10000);
}

// ====================================================
// KEEP-ALIVE: Prevent Render free tier from sleeping (15 min inactivity timeout)
// Self-pings every 14 minutes. Only runs when RENDER_EXTERNAL_URL is set.
// ====================================================
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutes
function startKeepAlive() {
  startTrenchAutoTradeScheduler();
  const url = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  if (!url) {
    console.log('[KeepAlive] No RENDER_EXTERNAL_URL or APP_URL set — skipping keep-alive (local dev)');
    return;
  }
  console.log(`[KeepAlive] Self-ping enabled: ${url}/api/health every 14 minutes`);
  const runKeepAlivePing = async () => {
    try {
      const res = await fetch(`${url}/api/health`, { timeout: 10000 });
      console.log(`[KeepAlive] Ping: ${res.status}`);
    } catch (err) {
      console.warn(`[KeepAlive] Ping failed: ${err.message}`);
    }
  };
  trackInterval(() => runNonOverlapping('keepAlivePing', runKeepAlivePing), KEEP_ALIVE_INTERVAL);
}

// Health endpoint for keep-alive pings (lightweight, no auth)
app.get('/api/health', async (req, res) => {
  const now = Date.now();
  if (healthResponseCache.payload && (now - healthResponseCache.loadedAt) < HEALTH_CACHE_TTL_MS) {
    return res.json(healthResponseCache.payload);
  }
  const payload = {
    status: isDataReady() ? 'ok' : 'loading',
    version: 'trench-scalp-v1',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    coins: TRACKED_COINS.length,
    coinsWithCandles: null,
    totalTracked: TRACKED_COINS.length,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  };
  healthResponseCache.payload = payload;
  healthResponseCache.loadedAt = now;
  res.json(payload);
});

app.get('/api/ops/metrics', (req, res, next) => {
  if (hasOpsMetricsAccess(req)) return next();
  return requireLogin(req, res, next);
}, (req, res) => {
  const httpLat = [...opsMetrics.http.latencies].sort((a, b) => a - b);
  const dbLat = [...opsMetrics.db.latencies].sort((a, b) => a - b);

  const topHttp = [...opsMetrics.http.byRoute.entries()]
    .map(([route, m]) => ({
      route,
      count: m.count,
      avgMs: m.count > 0 ? Number((m.totalMs / m.count).toFixed(1)) : 0,
      maxMs: m.maxMs,
      slow: m.slow,
      status5xx: m.status5xx
    }))
    .sort((a, b) => (b.avgMs - a.avgMs) || (b.count - a.count))
    .slice(0, 20);

  const topDb = [...opsMetrics.db.byOp.entries()]
    .map(([op, m]) => ({
      op,
      count: m.count,
      avgMs: m.count > 0 ? Number((m.totalMs / m.count).toFixed(1)) : 0,
      maxMs: m.maxMs,
      slow: m.slow
    }))
    .sort((a, b) => (b.avgMs - a.avgMs) || (b.count - a.count))
    .slice(0, 20);

  res.json({
    uptimeSec: Math.round((Date.now() - STARTED_AT_MS) / 1000),
    thresholds: { slowHttpMs: SLOW_HTTP_MS, slowDbMs: SLOW_DB_MS },
    http: {
      total: opsMetrics.http.total,
      errors5xx: opsMetrics.http.errors5xx,
      p50: percentile(httpLat, 50),
      p95: percentile(httpLat, 95),
      p99: percentile(httpLat, 99),
      topRoutes: topHttp
    },
    db: {
      total: opsMetrics.db.total,
      errors: opsMetrics.db.errors,
      p50: percentile(dbLat, 50),
      p95: percentile(dbLat, 95),
      p99: percentile(dbLat, 99),
      topOps: topDb
    }
  });
});

// Monthly usage reset (midnight on 1st).
if (IS_PRIMARY_WORKER) cron.schedule('0 0 1 * *', async () => {
  try {
    await User.updateMany({}, { $set: { copilotQuestionsUsed: 0, llmMessagesUsed: 0, voiceMinutesUsed: 0 } });
  } catch (err) {
    console.warn('[Billing] Monthly usage reset failed:', err.message);
  }
});

// Daily trial lifecycle checks (reminders + downgrade on expiry).
if (IS_PRIMARY_WORKER) cron.schedule('15 0 * * *', async () => {
  try {
    const now = new Date();
    const trialUsers = await User.find({ subscriptionTier: 'trial', trialEndsAt: { $ne: null } });
    for (const user of trialUsers) {
      const daysLeft = getTrialDaysRemaining(user);
      if (daysLeft === 3) {
        await sendLifecycleEmail(user.email, '3 days left on your free trial', 'Your trial expires in 3 days. Upgrade to keep access.');
      } else if (daysLeft === 1) {
        await sendLifecycleEmail(user.email, 'Last chance — trial ends tomorrow', 'Your trial ends tomorrow. Upgrade now to keep access.');
      } else if (daysLeft <= 0) {
        user.subscriptionTier = 'free';
        user.subscriptionEndsAt = now;
        await user.save();
      }
    }
  } catch (err) {
    console.warn('[Billing] Trial lifecycle job failed:', err.message);
  }
});

// ====================================================
// 404 CATCH-ALL (must be after all routes)
// ====================================================
app.use((req, res) => {
  const wantsJson = req.path?.startsWith('/api/')
    || req.xhr
    || req.headers.accept?.includes('application/json');
  if (wantsJson) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).send(`
    <html><head><title>404 | AlphaConfluence</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{background:#0a0e17;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .c{text-align:center}h1{font-size:4rem;margin:0;color:#6366f1}p{color:#94a3b8;margin:1rem 0}a{color:#818cf8;text-decoration:none}</style></head>
    <body><div class="c"><h1>404</h1><p>Page not found</p><a href="/">Back to Dashboard</a></div></body></html>
  `);
});

// ====================================================
// GLOBAL ERROR HANDLER
// ====================================================
app.use((err, req, res, _next) => {
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  console.error('[Error]', err.stack || err.message || err);
  const status = err.status || err.statusCode || 500;
  const wantsJson = req.path?.startsWith('/api/')
    || req.xhr
    || req.headers.accept?.includes('application/json');
  if (wantsJson) {
    return res.status(status).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal server error') });
  }
  res.status(status).send(`
    <html><head><title>Error | AlphaConfluence</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{background:#0a0e17;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .c{text-align:center}h1{font-size:3rem;margin:0;color:#ef4444}p{color:#94a3b8;margin:1rem 0}a{color:#818cf8;text-decoration:none}</style></head>
    <body><div class="c"><h1>Something went wrong</h1><p>${process.env.NODE_ENV === 'production' ? 'Please try again later.' : (err.message || '')}</p><a href="/">Back to Dashboard</a></div></body></html>
  `);
});

// Graceful shutdown: stop timers/sockets/db and exit cleanly on SIGTERM/SIGINT
let _isShuttingDown = false;
function gracefulShutdown(signal) {
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  console.log(`[Server] ${signal} received — shutting down gracefully...`);

  for (const id of runtimeIntervals) clearInterval(id);
  runtimeIntervals.clear();
  for (const id of runtimeTimeouts) clearTimeout(id);
  runtimeTimeouts.clear();

  try {
    const trenchAuto = require('./services/trench-auto-trading');
    if (typeof trenchAuto.stopAllBots === 'function') trenchAuto.stopAllBots();
  } catch (e) { /* ignore */ }

  try { shutdownWebSocketPrices(); } catch (e) { /* ignore */ }
  try { wss.close(); } catch (e) { /* ignore */ }
  try { voiceWss.close(); } catch (e) { /* ignore */ }

  const forceExitTimer = setTimeout(() => {
    console.warn('[Server] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 12000);

  server.close(async () => {
    try {
      await mongoose.connection.close();
    } catch (e) { /* ignore */ }
    clearTimeout(forceExitTimer);
    console.log('[Server] Shutdown complete');
    process.exit(0);
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

Promise.race([
  pricesReadyPromise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), START_TIMEOUT))
])
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[Server] CryptoSignals Pro v3.0 running on port ${PORT}`);
      console.log(`[Server] Dashboard: http://localhost:${PORT}`);
      console.log(`[Server] WebSocket: ws://localhost:${PORT}/ws/prices`);
      startKeepAlive();
      if (typeof process.send === 'function') process.send('ready');
    });
  })
  .catch(() => {
    server.listen(PORT, () => {
      console.log(`[Server] CryptoSignals Pro v3.0 running on port ${PORT} (started without waiting for prices)`);
      console.log(`[Server] WebSocket: ws://localhost:${PORT}/ws/prices`);
      startKeepAlive();
      if (typeof process.send === 'function') process.send('ready');
    });
  });
