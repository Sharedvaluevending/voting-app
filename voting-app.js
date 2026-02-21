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

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');

// Prevent unhandled promise rejections (e.g. MongoDB) from crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled rejection (non-fatal):', reason?.message || reason);
});
const session = require('express-session');
const MongoStore = require('connect-mongo');
const crypto = require('crypto');
const path = require('path');

const { fetchAllPrices, fetchAllCandles, fetchAllCandlesForCoin, fetchAllHistory, fetchCandles, getCurrentPrice, fetchLivePrice, isDataReady, getFundingRate, getAllFundingRates, isCandleFresh, getCandleSource, recordScoreHistory, getScoreHistory, recordRegimeSnapshot, getRegimeTimeline, pricesReadyPromise, TRACKED_COINS, COIN_META } = require('./services/crypto-api');
const { analyzeAllCoins, analyzeCoin } = require('./services/trading-engine');
const { requireLogin, optionalUser, guestOnly } = require('./middleware/auth');
const { openTrade, closeTrade, checkStopsAndTPs, recheckTradeScores, SCORE_RECHECK_MINUTES, getOpenTrades, getTradeHistory, getPerformanceStats, resetAccount, suggestLeverage } = require('./services/paper-trading');
const { initializeStrategies, getPerformanceReport, resetStrategyWeights } = require('./services/learning-engine');
const { runBacktest, runBacktestForCoin } = require('./services/backtest');
const bitget = require('./services/bitget');
const { getWebSocketPrice, getAllWebSocketPrices, addBrowserClient, isWebSocketConnected } = require('./services/websocket-prices');
const StrategyWeight = require('./models/StrategyWeight');

const User = require('./models/User');
const Trade = require('./models/Trade');
const Journal = require('./models/Journal');
const Alert = require('./models/Alert');

const app = express();
const PORT = process.env.PORT || 3000;

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
  mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 })
    .then(() => {
      dbConnected = true;
      console.log('[DB] Connected to MongoDB');
      initializeStrategies().catch(err => console.error('[DB] Strategy init error:', err.message));
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
// MIDDLEWARE
// ====================================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  resave: true,              // always re-save session to store (needed for MemoryStore + CSRF)
  saveUninitialized: true,   // save new sessions immediately so CSRF tokens persist
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
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
      mongoOptions: { serverSelectionTimeoutMS: 10000 }
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

app.use(session(sessionConfig));


// Load user data into res.locals for all templates
app.use(async (req, res, next) => {
  res.locals.user = null;
  res.locals.balance = 10000;
  res.locals.livePnl = null;
  if (!dbConnected || !req.session || !req.session.userId) return next();
  try {
    const user = await User.findById(req.session.userId).lean();
    if (user) {
      res.locals.user = user;
      res.locals.balance = user.paperBalance;
      req.session.username = user.username;
      // Compute live PNL from open trades using cached prices (no extra latency)
      try {
        const openTrades = await getOpenTrades(req.session.userId);
        if (openTrades.length > 0) {
          const prices = await fetchAllPrices();
          const priceMap = {};
          prices.forEach(p => { if (p && p.id != null) priceMap[p.id] = Number(p.price); });
          let totalPnl = 0;
          let count = 0;
          for (const t of openTrades) {
            const cp = priceMap[t.coinId];
            if (cp == null || !t.entryPrice || !t.positionSize) continue;
            const unrealized = t.direction === 'LONG'
              ? ((cp - t.entryPrice) / t.entryPrice) * t.positionSize
              : ((t.entryPrice - cp) / t.entryPrice) * t.positionSize;
            totalPnl += (t.partialPnl || 0) + unrealized;
            count++;
          }
          if (count > 0) res.locals.livePnl = totalPnl;
        }
      } catch (e) { /* non-critical, client polling will fill in */ }
    } else {
      // User no longer exists in DB — clear stale session
      delete req.session.userId;
      delete req.session.username;
    }
  } catch (err) {
    console.warn('[Auth] User load error (non-fatal):', err.message);
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
  if (price >= 1) return price.toFixed(2);
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
app.get('/login', guestOnly, (req, res) => {
  res.render('login', { activePage: 'login', error: req.query.error || null, success: req.query.success || null });
});

app.post('/login', guestOnly, async (req, res) => {
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

app.get('/register', guestOnly, (req, res) => {
  res.render('register', { activePage: 'register', error: null });
});

app.post('/register', guestOnly, async (req, res) => {
  if (!dbConnected) {
    return res.render('register', { activePage: 'register', error: 'Database not available. Registration requires MongoDB.' });
  }
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.render('register', { activePage: 'register', error: 'All fields are required' });
    }
    if (password.length < 6) {
      return res.render('register', { activePage: 'register', error: 'Password must be at least 6 characters' });
    }

    const existing = await User.findOne({ $or: [{ email: email.toLowerCase().trim() }, { username: username.trim() }] });
    if (existing) {
      return res.render('register', { activePage: 'register', error: 'Email or username already taken' });
    }

    const user = new User({
      email: email.toLowerCase().trim(),
      username: username.trim(),
      password
    });
    await user.save();

    req.session.userId = user._id;
    req.session.username = user.username;
    req.session.save((err) => {
      if (err) {
        console.error('[Register] Session save error:', err.message);
        return res.render('register', { activePage: 'register', error: 'Account created but login failed. Please log in manually.' });
      }
      res.redirect('/');
    });
  } catch (err) {
    res.render('register', { activePage: 'register', error: err.message || 'Registration failed' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/forgot-password', guestOnly, (req, res) => {
  res.render('forgot-password', { activePage: 'login', error: null, success: null });
});

app.post('/forgot-password', guestOnly, async (req, res) => {
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

app.post('/reset-password', guestOnly, async (req, res) => {
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

// Build engine options: strategy weights, BTC signal, strategy stats, funding rates, BTC candles
// Optional user: when provided, merges feature toggles (quality filters) for paper/live trades
async function buildEngineOptions(prices, allCandles, allHistory, user) {
  const strategyWeights = await StrategyWeight.find({ active: true }).lean();
  const strategyStats = {};
  strategyWeights.forEach(s => {
    strategyStats[s.strategyId] = { totalTrades: s.performance.totalTrades || 0 };
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
  // User-specific quality filters (for paper/live)
  if (user?.settings) {
    const s = user.settings;
    opts.featurePriceActionConfluence = s.featurePriceActionConfluence === true;
    opts.featureVolatilityFilter = s.featureVolatilityFilter === true;
    opts.featureVolumeConfirmation = s.featureVolumeConfirmation === true;
    opts.featureFundingRateFilter = s.featureFundingRateFilter === true;
  }
  return opts;
}

// ====================================================
// DASHBOARD (public, enhanced for logged-in users)
// ====================================================
app.get('/', async (req, res) => {
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
        dashUser = await User.findById(req.session.userId).select('excludedCoins settings').lean();
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
    // Min R:R filter: hide signals below threshold when enabled
    if (dashUser?.settings?.minRiskRewardEnabled && dashUser.settings.minRiskReward != null) {
      const minRr = Number(dashUser.settings.minRiskReward) || 1.2;
      monitoredSignals = monitoredSignals.filter(s => (s.riskReward || 0) >= minRr);
    }

    // Top 5 coins from latest backtest (for "Top performer" badge)
    let topPerformerCoins = [];
    try {
      const resultsDir = path.join(__dirname, 'data/backtest-results');
      if (fs.existsSync(resultsDir)) {
        const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('massive-') && f.endsWith('.json'));
        if (files.length > 0) {
          const latest = files.sort().reverse()[0];
          const data = JSON.parse(fs.readFileSync(path.join(resultsDir, latest), 'utf8'));
          topPerformerCoins = (data.top10 || []).slice(0, 5).map(c => c.symbol);
        }
      }
    } catch (e) { /* ignore */ }

    const excludedSignals = dashUser ? signals.filter(s => excludedCoins.includes(s.coin?.id)) : [];
    const excludedCoinsFull = dashUser ? excludedCoins.map(id => {
      const sig = signals.find(s => s.coin?.id === id);
      const meta = COIN_META[id];
      return { id, symbol: sig?.coin?.symbol || meta?.symbol || id, name: sig?.coin?.name || meta?.name || id };
    }) : [];

    res.render('dashboard', {
      activePage: 'dashboard',
      prices: pricesMerged,
      signals: monitoredSignals,
      allSignals: signals,
      deleted: req.query.deleted === '1',
      excludedCoins,
      excludedSignals,
      excludedCoinsFull,
      topPerformerCoins,
      COIN_META
    });
  } catch (err) {
    console.error('[Dashboard] Error:', err);
    res.status(500).send('Error loading dashboard. Try refreshing in a few seconds.');
  }
});

// ====================================================
// COIN DETAIL
// ====================================================
app.get('/coin/:coinId', async (req, res) => {
  try {
    const coinId = req.params.coinId;
    if (!TRACKED_COINS.includes(coinId)) {
      return res.status(404).send('Coin not found. <a href="/">Back to Dashboard</a>');
    }

    const [prices, allCandles, allHistory] = await Promise.all([
      fetchAllPrices(),
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory()
    ]);
    const coinData = prices.find(p => p.id === coinId);
    if (!coinData) {
      return res.status(404).send('Price data unavailable. <a href="/">Back to Dashboard</a>');
    }
    const options = await buildEngineOptions(prices, allCandles, allHistory);
    const candles = fetchCandles(coinId);
    const history = allHistory[coinId] || { prices: [], volumes: [] };
    const sig = analyzeCoin(coinData, candles, history, options);

    res.render('coin-detail', {
      activePage: 'dashboard',
      pageTitle: sig.coin.name,
      sig
    });
  } catch (err) {
    console.error('[CoinDetail] Error:', err);
    res.status(500).send('Error loading coin data. <a href="/">Back to Dashboard</a>');
  }
});

// ====================================================
// CHART (TradingView embed; optional trade levels from query)
// ====================================================
app.get('/chart/:coinId', async (req, res) => {
  const coinId = req.params.coinId;
  if (!TRACKED_COINS.includes(coinId)) {
    return res.status(404).send('Coin not found. <a href="/">Back to Dashboard</a>');
  }
  const meta = COIN_META[coinId];
  if (!meta || !meta.bybit) {
    return res.status(404).send('Chart not available for this coin. <a href="/">Back to Dashboard</a>');
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
  const chartCandles = fetchCandles(coinId);
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

  const currentCoinIndex = TRACKED_COINS.indexOf(coinId);
  const prevCoinId = currentCoinIndex > 0 ? TRACKED_COINS[currentCoinIndex - 1] : TRACKED_COINS[TRACKED_COINS.length - 1];
  const nextCoinId = currentCoinIndex < TRACKED_COINS.length - 1 && currentCoinIndex >= 0 ? TRACKED_COINS[currentCoinIndex + 1] : TRACKED_COINS[0];

  const chartCoins = TRACKED_COINS.filter(id => COIN_META[id] && COIN_META[id].bybit).map(id => ({
    id,
    symbol: COIN_META[id].symbol,
    name: COIN_META[id].name
  }));

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
    chartCoins
  });
});

// ====================================================
// TRADE ROUTES (require login)
// ====================================================
app.get('/trades', requireLogin, async (req, res) => {
  try {
    const [trades, prices, user] = await Promise.all([
      getOpenTrades(req.session.userId),
      fetchAllPrices(),
      User.findById(req.session.userId).lean()
    ]);
    // If we have open trades, fetch live prices for those coins so initial PnL is accurate
    // (avoids 0% or wrong PnL from stale cache right after opening)
    let pricesToUse = Array.isArray(prices) ? prices : [];
    if (trades.length > 0 && pricesToUse.length > 0) {
      const coinIds = [...new Set(trades.map(t => t.coinId))];
      const livePrices = await Promise.all(coinIds.map(id => fetchLivePrice(id)));
      pricesToUse = pricesToUse.map(x => {
        const idx = coinIds.indexOf(x.id);
        if (idx >= 0 && livePrices[idx] != null && Number.isFinite(livePrices[idx]) && livePrices[idx] > 0) {
          return { ...x, price: livePrices[idx] };
        }
        return x;
      });
    }
    res.render('trades', {
      activePage: 'trades',
      trades,
      prices: pricesToUse,
      user,
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    console.error('[Trades] Error:', err);
    res.status(500).send('Error loading trades');
  }
});

app.post('/trades/open', requireLogin, async (req, res) => {
  try {
    const { coinId, direction, strategyType } = req.body;
    if (!coinId || !direction) {
      return res.redirect('/trades?error=' + encodeURIComponent('Missing trade data'));
    }

    // Explicit coin whitelist: only tracked coins can be traded
    if (!TRACKED_COINS.includes(coinId)) {
      return res.redirect('/trades?error=' + encodeURIComponent('Invalid coin'));
    }

    // Validate direction
    if (!['LONG', 'SHORT'].includes(direction)) {
      return res.redirect('/trades?error=' + encodeURIComponent('Invalid direction'));
    }

    const prices = await fetchAllPrices();
    const coinData = prices.find(p => p.id === coinId);
    if (!coinData) {
      return res.redirect('/trades?error=' + encodeURIComponent('Price data not available'));
    }

    const [allCandles, allHistory, livePrice, user] = await Promise.all([
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory(),
      fetchLivePrice(coinId),
      User.findById(req.session.userId).lean()
    ]);
    const options = await buildEngineOptions(await fetchAllPrices(), allCandles, allHistory, user);
    const candles = fetchCandles(coinId);
    const history = allHistory[coinId] || { prices: [], volumes: [] };
    const signal = analyzeCoin(coinData, candles, history, options);
    const signalDir = (signal.signal === 'BUY' || signal.signal === 'STRONG_BUY') ? 'LONG'
      : (signal.signal === 'SELL' || signal.signal === 'STRONG_SELL') ? 'SHORT'
      : null;
    const bestDisplayStrat = (signal.topStrategies || []).find(s =>
      (s.signal === 'BUY' || s.signal === 'STRONG_BUY' || s.signal === 'SELL' || s.signal === 'STRONG_SELL') &&
      (s.score || 0) >= 55
    ) || null;
    const displaySignal = signal.signal === 'HOLD' && bestDisplayStrat ? bestDisplayStrat.signal : signal.signal;
    const displayDir = (displaySignal === 'BUY' || displaySignal === 'STRONG_BUY') ? 'LONG'
      : (displaySignal === 'SELL' || displaySignal === 'STRONG_SELL') ? 'SHORT'
      : null;
    const minConf = (signal.score || 0) >= 58 ? 1 : 2;
    const overallCanTrade = (signal.score || 0) >= 55 && (signal.confluenceLevel || 0) >= minConf;

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
      if ((selectedStrat.score || 0) < 55) {
        return res.redirect('/trades?error=' + encodeURIComponent('Selected strategy score must be at least 55'));
      }
    } else {
      if (!overallCanTrade) {
        return res.redirect('/trades?error=' + encodeURIComponent(`Main signal requires score >=55 and confluence >=${minConf}`));
      }
      if (!displayDir || displayDir !== direction) {
        return res.redirect('/trades?error=' + encodeURIComponent('Trade direction does not match current signal'));
      }
    }

    // Ignore client-provided score to prevent tampering.
    const useScore = selectedStrat ? (selectedStrat.score || signal.score || 0) : (signal.score || 0);
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
      symbol: COIN_META[coinId]?.symbol || coinId.toUpperCase(),
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
// PRICE ALERTS
// ====================================================
app.get('/alerts', requireLogin, async (req, res) => {
  try {
    const alerts = await Alert.find({ userId: req.session.userId }).sort({ createdAt: -1 }).lean();
    res.render('alerts', { activePage: 'alerts', alerts, TRACKED_COINS, COIN_META });
  } catch (err) {
    console.error('[Alerts] Error:', err);
    res.status(500).send('Error loading alerts');
  }
});

app.post('/alerts', requireLogin, async (req, res) => {
  try {
    const { coinId, condition, price } = req.body;
    if (!coinId || !TRACKED_COINS.includes(coinId) || !condition || !price) {
      return res.redirect('/alerts?error=' + encodeURIComponent('Invalid alert: coin, condition, and price required'));
    }
    const p = parseFloat(price);
    if (isNaN(p) || p <= 0) return res.redirect('/alerts?error=' + encodeURIComponent('Invalid price'));
    if (condition !== 'above' && condition !== 'below') return res.redirect('/alerts?error=' + encodeURIComponent('Condition must be above or below'));
    const meta = COIN_META[coinId];
    await Alert.create({
      userId: req.session.userId,
      coinId,
      symbol: meta?.symbol || coinId.toUpperCase(),
      condition,
      price: p
    });
    res.redirect('/alerts?success=Alert+created');
  } catch (err) {
    console.error('[Alerts Create] Error:', err);
    res.redirect('/alerts?error=' + encodeURIComponent(err.message));
  }
});

app.post('/alerts/:id/delete', requireLogin, async (req, res) => {
  try {
    await Alert.findOneAndDelete({ _id: req.params.id, userId: req.session.userId });
    res.redirect('/alerts?success=Alert+deleted');
  } catch (err) {
    console.error('[Alerts Delete] Error:', err);
    res.redirect('/alerts?error=' + encodeURIComponent(err.message));
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
    res.render('performance', {
      activePage: 'performance',
      stats: safeStats,
      user: user || {},
      journalAnalytics: journalAnalytics || { byEmotion: {}, byRules: { followed: { wins: 0, total: 0 }, broke: { wins: 0, total: 0 } } },
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (err) {
    console.error('[Performance] Error:', err);
    res.status(500).send('Error loading performance');
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
    s.featurePriceActionConfluence = req.body.featurePriceActionConfluence ? parseBool(req.body.featurePriceActionConfluence) : false;
    s.featureVolatilityFilter = req.body.featureVolatilityFilter ? parseBool(req.body.featureVolatilityFilter) : false;
    s.featureVolumeConfirmation = req.body.featureVolumeConfirmation ? parseBool(req.body.featureVolumeConfirmation) : false;
    s.featureFundingRateFilter = req.body.featureFundingRateFilter ? parseBool(req.body.featureFundingRateFilter) : false;
    s.minRiskRewardEnabled = req.body.minRiskRewardEnabled ? parseBool(req.body.minRiskRewardEnabled) : false;
    const minRr = parseFloat(req.body.minRiskReward);
    s.minRiskReward = !isNaN(minRr) && minRr >= 1 && minRr <= 5 ? minRr : 1.2;

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

    // Risk controls
    const maxDaily = parseFloat(req.body.maxDailyLossPercent);
    s.maxDailyLossPercent = !isNaN(maxDaily) && maxDaily >= 0 && maxDaily <= 20 ? maxDaily : 0;
    s.drawdownSizingEnabled = req.body.drawdownSizingEnabled ? parseBool(req.body.drawdownSizingEnabled) : false;
    const ddThresh = parseFloat(req.body.drawdownThresholdPercent);
    s.drawdownThresholdPercent = !isNaN(ddThresh) && ddThresh >= 5 && ddThresh <= 50 ? ddThresh : 10;
    const minVol = parseFloat(req.body.minVolume24hUsd);
    s.minVolume24hUsd = !isNaN(minVol) && minVol >= 0 ? minVol : 0;
    s.correlationFilterEnabled = req.body.correlationFilterEnabled ? parseBool(req.body.correlationFilterEnabled) : false;
    s.expectancyFilterEnabled = req.body.expectancyFilterEnabled ? parseBool(req.body.expectancyFilterEnabled) : false;
    const minExp = parseFloat(req.body.minExpectancy);
    s.minExpectancy = !isNaN(minExp) && minExp >= -1 && minExp <= 2 ? minExp : 0.15;

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
app.get('/backtest', (req, res) => {
  res.render('backtest', { activePage: 'backtest', results: null, TRACKED_COINS });
});

// ====================================================
// BACKTEST RESULTS (latest massive backtest)
// ====================================================
app.get('/backtest-results', (req, res) => {
  try {
    const resultsDir = path.join(__dirname, 'data/backtest-results');
    if (!fs.existsSync(resultsDir)) {
      return res.render('backtest-results', { activePage: 'backtest-results', error: 'No backtest results directory.' });
    }
    const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('massive-') && f.endsWith('.json'));
    if (files.length === 0) {
      return res.render('backtest-results', { activePage: 'backtest-results', error: 'No massive backtest results found.' });
    }
    const latest = files.sort().reverse()[0];
    const data = JSON.parse(fs.readFileSync(path.join(resultsDir, latest), 'utf8'));
    res.render('backtest-results', { activePage: 'backtest-results', result: data });
  } catch (err) {
    console.error('[BacktestResults] Error:', err);
    res.render('backtest-results', { activePage: 'backtest-results', error: err.message });
  }
});

// ====================================================
// TRENCH WARFARE - Shitcoin scalping hub (Solana memecoins)
// ====================================================
app.get('/trench-warfare', async (req, res) => {
  const mobula = require('./services/mobula-api');
  const ScalpTrade = require('./models/ScalpTrade');
  let trendings = [];
  try {
    const dexscreener = require('./services/dexscreener-api');
    trendings = await dexscreener.fetchSolanaTrendings(15);
  } catch (e) {
    console.warn('[TrenchWarfare] DexScreener failed:', e.message);
  }
  if (!trendings || trendings.length === 0) {
    try {
      trendings = await (mobula.fetchMetaTrendingsMulti || mobula.fetchMetaTrendings)('solana');
    } catch (e) {
      console.error('[TrenchWarfare] Mobula fetch failed:', e.message);
    }
  }
  let openPositions = [];
  const user = req.session?.userId ? await User.findById(req.session.userId).lean() : null;
  if (user) {
    openPositions = await ScalpTrade.find({ userId: user._id, status: 'OPEN' }).sort({ createdAt: -1 }).lean();
  }
  res.render('trench-warfare', {
    activePage: 'trench-warfare',
    pageTitle: 'Trench Warfare',
    trendings,
    user,
    trenchPaperBalance: user ? (user.trenchPaperBalance ?? 1000) : 0,
    openPositions,
    trenchBot: user?.trenchBot || {},
    trenchAuto: user?.trenchAuto || {}
  });
});

app.get('/api/trench-warfare/trendings', async (req, res) => {
  const mobula = require('./services/mobula-api');
  try {
    const data = await (mobula.fetchMetaTrendingsMulti || mobula.fetchMetaTrendings)(req.query.blockchain || 'solana');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/swap/quote', async (req, res) => {
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

app.post('/api/trench-warfare/paper/buy', requireLogin, async (req, res) => {
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

app.post('/api/trench-warfare/paper/sell', requireLogin, async (req, res) => {
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

app.post('/api/trench-warfare/paper/reset', requireLogin, async (req, res) => {
  const ScalpTrade = require('./models/ScalpTrade');
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const openCount = await ScalpTrade.countDocuments({ userId: user._id, isPaper: true, status: 'OPEN' });
    if (openCount > 0) {
      return res.status(400).json({ error: 'Close all open positions before reset' });
    }
    user.trenchPaperBalance = 1000;
    user.trenchPaperBalanceInitial = 1000;
    await user.save();
    res.json({ success: true, trenchPaperBalance: 1000 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/bot/connect', requireLogin, async (req, res) => {
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

app.post('/api/trench-warfare/bot/disconnect', requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  user.trenchBot = { privateKeyEncrypted: '', publicKey: '', connected: false };
  await user.save();
  res.json({ success: true });
});

app.post('/api/trench-warfare/auto/settings', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const b = req.body || {};
    if (b.enabled !== undefined) user.trenchAuto.enabled = !!b.enabled;
    if (b.mode !== undefined) user.trenchAuto.mode = b.mode === 'live' ? 'live' : 'paper';
    if (b.minTrendingScore !== undefined) user.trenchAuto.minTrendingScore = Math.max(0, Math.min(50, Number(b.minTrendingScore)));
    if (b.maxOpenPositions !== undefined) user.trenchAuto.maxOpenPositions = Math.max(1, Math.min(10, Number(b.maxOpenPositions)));
    if (b.amountPerTradeUsd !== undefined) user.trenchAuto.amountPerTradeUsd = Math.max(5, Math.min(500, Number(b.amountPerTradeUsd)));
    if (b.amountPerTradeSol !== undefined) user.trenchAuto.amountPerTradeSol = Math.max(0.01, Math.min(1, Number(b.amountPerTradeSol)));
    if (b.checkIntervalMinutes !== undefined) user.trenchAuto.checkIntervalMinutes = Math.max(5, Math.min(60, Number(b.checkIntervalMinutes)));
    if (b.tpPercent !== undefined) user.trenchAuto.tpPercent = Math.max(5, Math.min(100, Number(b.tpPercent)));
    if (b.slPercent !== undefined) user.trenchAuto.slPercent = Math.max(3, Math.min(50, Number(b.slPercent)));
    if (b.trailingStopPercent !== undefined) user.trenchAuto.trailingStopPercent = Math.max(3, Math.min(30, Number(b.trailingStopPercent)));
    if (b.useTrailingStop !== undefined) user.trenchAuto.useTrailingStop = !!b.useTrailingStop;
    if (b.partialTpPercent !== undefined) user.trenchAuto.partialTpPercent = Math.max(0, Math.min(100, Number(b.partialTpPercent)));
    if (b.partialTpAtPercent !== undefined) user.trenchAuto.partialTpAtPercent = Math.max(5, Math.min(50, Number(b.partialTpAtPercent)));
    if (b.breakevenAtPercent !== undefined) user.trenchAuto.breakevenAtPercent = Math.max(2, Math.min(20, Number(b.breakevenAtPercent)));
    if (b.useBreakevenStop !== undefined) user.trenchAuto.useBreakevenStop = !!b.useBreakevenStop;
    if (b.maxHoldMinutes !== undefined) user.trenchAuto.maxHoldMinutes = Math.max(15, Math.min(480, Number(b.maxHoldMinutes)));
    if (b.minLiquidityUsd !== undefined) user.trenchAuto.minLiquidityUsd = Math.max(0, Math.min(1000000, Number(b.minLiquidityUsd)));
    if (b.maxTop10HoldersPercent !== undefined) user.trenchAuto.maxTop10HoldersPercent = Math.max(50, Math.min(100, Number(b.maxTop10HoldersPercent)));
    if (b.maxPriceChange24hPercent !== undefined) user.trenchAuto.maxPriceChange24hPercent = Math.max(50, Math.min(1000, Number(b.maxPriceChange24hPercent)));
    if (b.cooldownHours !== undefined) user.trenchAuto.cooldownHours = Math.max(0, Math.min(48, Number(b.cooldownHours)));
    if (b.useEntryFilters !== undefined) user.trenchAuto.useEntryFilters = !!b.useEntryFilters;
    if (b.maxDailyLossPercent !== undefined) user.trenchAuto.maxDailyLossPercent = Math.max(0, Math.min(50, Number(b.maxDailyLossPercent)));
    if (b.consecutiveLossesToPause !== undefined) user.trenchAuto.consecutiveLossesToPause = Math.max(0, Math.min(10, Number(b.consecutiveLossesToPause)));
    if (b.minSolBalance !== undefined) user.trenchAuto.minSolBalance = Math.max(0.01, Math.min(1, Number(b.minSolBalance)));
    if (b.trenchNotifyTradeOpen !== undefined) user.trenchAuto.trenchNotifyTradeOpen = !!b.trenchNotifyTradeOpen;
    if (b.trenchNotifyTradeClose !== undefined) user.trenchAuto.trenchNotifyTradeClose = !!b.trenchNotifyTradeClose;
    await user.save();
    res.json({ success: true, trenchAuto: user.trenchAuto });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/blacklist/add', requireLogin, async (req, res) => {
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

app.post('/api/trench-warfare/blacklist/remove', requireLogin, async (req, res) => {
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

app.get('/api/trench-warfare/analytics', requireLogin, async (req, res) => {
  try {
    const ScalpTrade = require('./models/ScalpTrade');
    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const closed = await ScalpTrade.find({ userId: user._id, status: 'CLOSED' }).sort({ exitTime: -1 }).limit(100).lean();
    const stats = user.trenchStats || {};
    const totalTrades = (stats.wins || 0) + (stats.losses || 0);
    const winRate = totalTrades > 0 ? ((stats.wins || 0) / totalTrades * 100).toFixed(1) : 0;
    const initial = user.trenchPaperBalanceInitial ?? 1000;
    const current = user.trenchPaperBalance ?? 1000;
    const pnlPercent = initial > 0 ? (((current - initial) / initial) * 100).toFixed(2) : 0;
    res.json({
      trenchStats: stats,
      winRate: parseFloat(winRate),
      totalTrades,
      totalPnl: stats.totalPnl || 0,
      pnlPercent: parseFloat(pnlPercent),
      bestTrade: stats.bestTrade || 0,
      worstTrade: stats.worstTrade || 0,
      consecutiveLosses: stats.consecutiveLosses || 0,
      closedTrades: closed,
      paused: !!user.trenchAuto?.lastPausedAt,
      pausedReason: user.trenchAuto?.pausedReason || ''
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/unpause', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    user.trenchAuto.lastPausedAt = null;
    user.trenchAuto.pausedReason = '';
    user.trenchStats = user.trenchStats || {};
    user.trenchStats.consecutiveLosses = 0;
    await user.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/auto/run-now', requireLogin, async (req, res) => {
  try {
    const trenchAuto = require('./services/trench-auto-trading');
    const result = await trenchAuto.runTrenchAutoTrade({ forceRun: true });
    res.json({ success: true, message: 'Auto trade run completed', ...result });
  } catch (e) {
    console.error('[TrenchAuto] Run-now error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trench-warfare/auto/debug', requireLogin, async (req, res) => {
  try {
    const dexscreener = require('./services/dexscreener-api');
    const User = require('./models/User');
    const ScalpTrade = require('./models/ScalpTrade');
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const trendings = await dexscreener.fetchSolanaTrendings(5);
    const openCount = await ScalpTrade.countDocuments({ userId: user._id, status: 'OPEN' });
    const balance = user.trenchPaperBalance ?? 1000;
    const settings = user.trenchAuto || {};
    const amountPerTrade = settings.amountPerTradeUsd ?? 20;
    const maxPos = settings.maxOpenPositions ?? 3;
    const canBuy = balance >= amountPerTrade && openCount < maxPos;
    res.json({
      trendings: trendings.length,
      sample: trendings[0],
      balance,
      openCount,
      maxPositions: maxPos,
      amountPerTrade,
      canBuy,
      autoEnabled: !!settings.enabled,
      mode: settings.mode
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trench-warfare/swap/send', async (req, res) => {
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
    res.json(result);
  } catch (e) {
    console.error('[TrenchWarfare] Swap send failed:', e.message);
    res.status(500).json({ error: e.message });
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
        weights: s.weights,
        byRegime: perf.byRegime || {},
        active: s.active,
        updatedAt: s.updatedAt
      };
    });
    const user = req.session?.userId ? await User.findById(req.session.userId).lean() : null;
    res.render('learning', { activePage: 'learning', strategies, user });
  } catch (err) {
    console.error('[Learning] Error:', err);
    res.render('learning', { activePage: 'learning', strategies: [], user: null });
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
          const livePrices = await Promise.all(coinIds.map(id => fetchLivePrice(id)));
          for (let i = 0; i < coinIds.length; i++) {
            if (livePrices[i] != null && Number.isFinite(livePrices[i]) && livePrices[i] > 0) {
              const idx = prices.findIndex(p => p.id === coinIds[i]);
              if (idx >= 0) prices[idx] = { ...prices[idx], price: livePrices[i] };
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

// Backtest API (historical simulation)
// When user is logged in: uses strategy weights, excluded coins (live parity)
app.post('/api/backtest', async (req, res) => {
  try {
    const { coinId, startDate, endDate, coins, minScore, leverage, features } = req.body || {};
    const startMs = startDate ? new Date(startDate).getTime() : Date.now() - 30 * 24 * 60 * 60 * 1000;
    const endMs = endDate ? new Date(endDate).getTime() : Date.now();
    if (isNaN(startMs) || isNaN(endMs)) {
      return res.status(400).json({ error: 'Invalid date range. Please select valid start and end dates.' });
    }
    if (startMs >= endMs) {
      return res.status(400).json({ error: 'Start date must be before end date' });
    }
    let coinsToRun = coins && Array.isArray(coins) ? coins : (coinId ? [coinId] : undefined);
    if (!coinsToRun && TRACKED_COINS) {
      // Limit to 3 coins by default to stay under typical 30s hosting timeout (Render, etc.)
      coinsToRun = TRACKED_COINS.slice(0, 3);
    }

    // Fetch user settings when logged in (strategy weights, excluded coins, coin weights, maxOpenTrades)
    let strategyWeights = [];
    let strategyStats = {};
    let excludedCoins = [];
    let coinWeights = {};
    let maxOpenTrades = 3;
    let coinWeightStrength = 'moderate';
    if (req.session?.userId) {
      try {
        const user = await User.findById(req.session.userId).select('excludedCoins coinWeights coinWeightEnabled coinWeightStrength settings').lean();
        if (user) {
          excludedCoins = user.excludedCoins || [];
          coinWeights = user.coinWeights || {};
          maxOpenTrades = user.settings?.maxOpenTrades ?? 3;
          coinWeightStrength = user.coinWeightStrength || 'moderate';
        }
      } catch (e) { /* non-fatal */ }
    }
    try {
      const StrategyWeight = require('./models/StrategyWeight');
      const sw = await StrategyWeight.find({ active: true }).lean();
      strategyWeights = sw || [];
      strategyStats = {};
      strategyWeights.forEach(s => {
        strategyStats[s.strategyId] = { totalTrades: s.performance?.totalTrades || 0 };
      });
    } catch (e) { /* DB may be unavailable */ }

    // Filter out excluded coins (matches live/paper)
    if (excludedCoins.length > 0) {
      const excludeSet = new Set(excludedCoins);
      coinsToRun = coinsToRun.filter(c => !excludeSet.has(c));
    }
    if (coinsToRun.length === 0) {
      return res.status(400).json({ error: 'All selected coins are excluded. Add coins in Performance settings.' });
    }

    const options = {
      coins: coinsToRun,
      minScore: minScore != null ? Number(minScore) : undefined,
      leverage: leverage != null ? Number(leverage) : undefined,
      initialBalance: req.body.initialBalance != null ? Number(req.body.initialBalance) : undefined,
      riskMode: req.body.riskMode === 'dollar' ? 'dollar' : 'percent',
      riskPerTrade: req.body.riskPerTrade != null ? Number(req.body.riskPerTrade) : undefined,
      riskDollarsPerTrade: req.body.riskDollarsPerTrade != null ? Number(req.body.riskDollarsPerTrade) : undefined,
      features: features || {},
      strategyWeights,
      strategyStats,
      coinWeights,
      maxOpenTrades,
      coinWeightStrength
    };
    const result = await runBacktest(startMs, endMs, options);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Backtest] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Push notifications: get VAPID public key
app.get('/api/push/vapid-public', (req, res) => {
  try {
    const { getVapidKeys } = require('./services/push-notifications');
    const keys = getVapidKeys();
    if (!keys) return res.json({ publicKey: null });
    res.json({ publicKey: keys.publicKey });
  } catch (e) {
    res.json({ publicKey: null });
  }
});

// Push notifications: subscribe (save subscription to user)
app.post('/api/push/subscribe', requireLogin, async (req, res) => {
  try {
    const subscription = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    if (!Array.isArray(user.pushSubscriptions)) user.pushSubscriptions = [];
    const exists = user.pushSubscriptions.some(s => s && s.endpoint === subscription.endpoint);
    if (!exists) {
      user.pushSubscriptions.push(subscription);
      await user.save();
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Candles for chart (Lightweight Charts format)
app.get('/api/candles/:coinId', async (req, res) => {
  try {
    const { coinId } = req.params;
    const interval = req.query.interval || '1h';
    if (!TRACKED_COINS.includes(coinId)) {
      return res.status(404).json({ error: 'Coin not found' });
    }
    let allCandles = fetchCandles(coinId);
    if (!allCandles) {
      allCandles = await fetchAllCandlesForCoin(coinId);
      if (!allCandles && !isDataReady()) {
        await new Promise(r => setTimeout(r, 2000));
        allCandles = await fetchAllCandlesForCoin(coinId);
      }
    }
    if (!allCandles || !allCandles[interval]) {
      return res.json({ success: true, candles: [], volume: [], patterns: [], chartPatterns: [] });
    }
    const raw = allCandles[interval].filter(c =>
      c.openTime > 0 && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) && c.high >= c.low
    ).sort((a, b) => a.openTime - b.openTime); // ascending for Lightweight Charts
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
      volumeProfile
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
    const openTrades = await Trade.find({ status: 'OPEN' }).select('coinId userId').lean();
    if (openTrades.length === 0) return;
    // Fetch live prices from Bitget/Kraken for all coins with open trades
    const coinIds = [...new Set(openTrades.map(t => t.coinId))];
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
setInterval(runStopTPCheck, 30 * 1000);
// Run first check 15s after startup
setTimeout(runStopTPCheck, 15 * 1000);

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
        try {
          const { sendPushToUser } = require('./services/push-notifications');
          const u = await User.findById(alert.userId).lean();
          if (u) await sendPushToUser(u, `${alert.symbol} Alert`, `Price ${alert.condition} $${alert.price.toLocaleString()} (now $${price.toLocaleString()})`);
        } catch (e) { /* non-critical */ }
      }
    }
  } catch (err) {
    console.error('[AlertCheck] Error:', err.message);
  }
}
setInterval(checkPriceAlerts, 60 * 1000);
setTimeout(checkPriceAlerts, 20 * 1000);

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
setInterval(runScoreRecheck, SCORE_RECHECK_MINUTES * 60 * 1000);
// Run first score check 30s after startup so trades get data quickly
setTimeout(runScoreRecheck, 30 * 1000);

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
    runScoreRecheck().catch(err => console.error('[ScoreCheck] Trigger error:', err.message));
    res.json({ success: true, message: 'Score check triggered. Refresh in 10–15 seconds.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

    // Filter by overall score (multi-TF confluence), rank by overall score, execute with best strategy levels
    // Overall score = quality gate; best strategy = how to trade (direction, SL, TP)
    for (const user of autoTradeUsers) {
      try {
        const options = await buildEngineOptions(prices, allCandles, allHistory, user);
        const signals = analyzeAllCoins(prices, allCandles, allHistory, options);
        if (!signals || signals.length === 0) continue;

        const signalsWithBestStrategy = signals.map(sig => {
          const coinId = sig.coin?.id || sig.id;
          const overallScore = sig.score || 0;
          let bestStrat = null;
          let direction = null;

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
        const minScore = user.settings?.autoTradeMinScore ?? user.liveTrading?.autoOpenMinScore ?? 52;
        const maxOpen = user.settings?.maxOpenTrades || 3;
        const openTrades = await Trade.find({ userId: user._id, status: 'OPEN' }).lean();
        if (openTrades.length >= maxOpen) continue;

        const openCoinIds = openTrades.map(t => t.coinId);
        // Cooldown check
        const cooldownMs = (user.settings?.cooldownHours || 4) * 3600 * 1000;
        const recentTrades = await Trade.find({
          userId: user._id,
          status: { $ne: 'OPEN' },
          closedAt: { $gte: new Date(Date.now() - cooldownMs) }
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
        const minRr = user.settings?.minRiskRewardEnabled ? (Number(user.settings.minRiskReward) || 1.2) : 0;
        const candidates = signalsWithBestStrategy.filter(sig => {
          if (sig._overallScore < minScore) return false;
          if (!sig._direction) return false; // HOLD signals ignored
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

        // Build strategy stats for expectancy filter (risk engine)
        const allStratWeights = await StrategyWeight.find({ active: true }).lean();
        const strategyStatsForOpen = {};
        allStratWeights.forEach(s => {
          strategyStatsForOpen[s.strategyId] = {
            totalTrades: s.performance?.totalTrades || 0,
            winRate: s.performance?.winRate || 0,
            avgRR: s.performance?.avgRR || 0
          };
        });

        for (const sig of toOpen) {
          try {
            const coinId = sig._coinId;
            const coinData = prices.find(p => p.id === coinId);
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
            if (sig._direction === 'LONG') {
              if (useTP1 && useTP1 <= livePrice * 0.99) { console.warn(`[AutoTrade] ${COIN_META[coinId]?.symbol}: TP1 $${useTP1} below entry $${livePrice} for LONG — removed`); useTP1 = null; }
              if (useTP2 && useTP2 <= livePrice * 0.99) { console.warn(`[AutoTrade] ${COIN_META[coinId]?.symbol}: TP2 $${useTP2} below entry $${livePrice} for LONG — removed`); useTP2 = null; }
              if (useTP3 && useTP3 <= livePrice * 0.99) { console.warn(`[AutoTrade] ${COIN_META[coinId]?.symbol}: TP3 $${useTP3} below entry $${livePrice} for LONG — removed`); useTP3 = null; }
              if (useSL && useSL >= livePrice * 1.01) { console.warn(`[AutoTrade] ${COIN_META[coinId]?.symbol}: SL $${useSL} above entry $${livePrice} for LONG — removed`); useSL = null; }
            } else {
              if (useTP1 && useTP1 >= livePrice * 1.01) { console.warn(`[AutoTrade] ${COIN_META[coinId]?.symbol}: TP1 $${useTP1} above entry $${livePrice} for SHORT — removed`); useTP1 = null; }
              if (useTP2 && useTP2 >= livePrice * 1.01) { console.warn(`[AutoTrade] ${COIN_META[coinId]?.symbol}: TP2 $${useTP2} above entry $${livePrice} for SHORT — removed`); useTP2 = null; }
              if (useTP3 && useTP3 >= livePrice * 1.01) { console.warn(`[AutoTrade] ${COIN_META[coinId]?.symbol}: TP3 $${useTP3} above entry $${livePrice} for SHORT — removed`); useTP3 = null; }
              if (useSL && useSL <= livePrice * 0.99) { console.warn(`[AutoTrade] ${COIN_META[coinId]?.symbol}: SL $${useSL} below entry $${livePrice} for SHORT — removed`); useSL = null; }
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
              console.log(`[AutoTrade] ${COIN_META[coinId]?.symbol}: Scaled levels by ${ratio.toFixed(4)} (analysis=$${analysisEntry} live=$${livePrice})`);
            }

            const signalLev = sig.suggestedLeverage || suggestLeverage(sig._bestScore, sig.regime || 'mixed', 'normal');
            const useFixed = user.settings?.useFixedLeverage;
            const lev = user.settings?.disableLeverage ? 1 : (useFixed ? (user.settings?.defaultLeverage ?? 2) : signalLev);
            const tradeData = {
              coinId,
              symbol: COIN_META[coinId]?.symbol || coinId.toUpperCase(),
              direction: sig._direction,
              entry: livePrice,
              stopLoss: useSL,
              takeProfit1: useTP1,
              takeProfit2: useTP2,
              takeProfit3: useTP3,
              volume24h: coinData?.volume24h,
              leverage: lev,
              score: sig._overallScore,
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

            await openTrade(user._id, tradeData);
            console.log(`[AutoTrade] Opened ${sig._direction} on ${tradeData.symbol} (overall ${sig._overallScore}, strat: ${useStratType}) for user ${user.username}`);
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
setInterval(runAutoTrade, 2 * 60 * 1000);
// First auto-trade check 45s after startup
setTimeout(runAutoTrade, 45 * 1000);

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
        compUser = await User.findById(req.session.userId).select('settings').lean();
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
app.get('/strategy-comparison', async (req, res) => {
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
        compUser = await User.findById(req.session.userId).select('settings').lean();
      } catch (e) { /* ignore */ }
    }
    const options = await buildEngineOptions(pricesMerged, allCandles, allHistory, compUser);
    const signals = analyzeAllCoins(pricesMerged, allCandles, allHistory, options);

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
      activePage: 'learning',
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
const wss = new WebSocketServer({ server, path: '/ws/prices' });
wss.on('connection', (ws) => {
  addBrowserClient(ws);
  ws.send(JSON.stringify({ type: 'connected', wsConnected: isWebSocketConnected() }));
});

// ====================================================
// KEEP-ALIVE: Prevent Render free tier from sleeping (15 min inactivity timeout)
// Self-pings every 14 minutes. Only runs when RENDER_EXTERNAL_URL is set.
// ====================================================
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutes
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  if (!url) {
    console.log('[KeepAlive] No RENDER_EXTERNAL_URL or APP_URL set — skipping keep-alive (local dev)');
    return;
  }
  console.log(`[KeepAlive] Self-ping enabled: ${url}/api/health every 14 minutes`);
  const trenchAuto = require('./services/trench-auto-trading');
  setInterval(() => {
    trenchAuto.runTrenchAutoTrade().catch(err => console.error('[TrenchAuto] Error:', err.message));
  }, 5 * 60 * 1000);
  setTimeout(() => trenchAuto.runTrenchAutoTrade().catch(() => {}), 60000);
  setInterval(async () => {
    try {
      const res = await fetch(`${url}/api/health`, { timeout: 10000 });
      console.log(`[KeepAlive] Ping: ${res.status}`);
    } catch (err) {
      console.warn(`[KeepAlive] Ping failed: ${err.message}`);
    }
  }, KEEP_ALIVE_INTERVAL);
}

// Health endpoint for keep-alive pings (lightweight, no auth)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

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
    });
  })
  .catch(() => {
    server.listen(PORT, () => {
      console.log(`[Server] CryptoSignals Pro v3.0 running on port ${PORT} (started without waiting for prices)`);
      console.log(`[Server] WebSocket: ws://localhost:${PORT}/ws/prices`);
      startKeepAlive();
    });
  });
