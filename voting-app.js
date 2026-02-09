// voting-app.js
// ====================================================
// CRYPTO SIGNALS PRO v3.0
// Professional crypto trading signals platform with:
//   - Multi-strategy 0-100 scoring engine
//   - Binance OHLCV candles + CoinGecko prices
//   - User accounts with paper trading ($10k start)
//   - 1 trade per pair, suggested leverage
//   - Trade tracking, performance analytics
//   - Trading journal, educational content
//   - Learning engine (tracks outcomes, adjusts weights)
// ====================================================

const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');

const { fetchAllPrices, fetchAllCandles, fetchAllHistory, fetchCandles, getCurrentPrice, isDataReady, TRACKED_COINS, COIN_META } = require('./services/crypto-api');
const { analyzeAllCoins, analyzeCoin } = require('./services/trading-engine');
const { requireLogin, optionalUser, guestOnly } = require('./middleware/auth');
const { openTrade, closeTrade, checkStopsAndTPs, getOpenTrades, getTradeHistory, getPerformanceStats, resetAccount, suggestLeverage } = require('./services/paper-trading');
const { initializeStrategies } = require('./services/learning-engine');

const User = require('./models/User');
const Trade = require('./models/Trade');
const Journal = require('./models/Journal');

const app = express();
const PORT = process.env.PORT || 3000;

// ====================================================
// MONGODB
// On Render: use the STANDARD connection string (not mongodb+srv) to avoid
// DNS ENOTFOUND. In Atlas: Cluster → Connect → "Connect your application"
// → toggle "Driver" to see standard format, or use "Direct connection" host.
// ====================================================
const mongoURI = process.env.MONGODB_URI || (process.env.NODE_ENV === 'production' ? null : 'mongodb://127.0.0.1:27017/votingApp');
if (!mongoURI) {
  console.error('[DB] MONGODB_URI is required in production. Set it in Render Environment.');
  process.exit(1);
}

// Prefer explicit standard URI on Render to avoid SRV DNS issues (ENOTFOUND)
const uri = process.env.MONGODB_URI_STANDARD || mongoURI;

mongoose.connect(uri)
  .then(() => {
    console.log('[DB] Connected to MongoDB');
    initializeStrategies().catch(err => console.error('[DB] Strategy init error:', err.message));
  })
  .catch(err => {
    console.error('[DB] MongoDB connection error:', err);
    if (uri.startsWith('mongodb+srv://') && process.env.NODE_ENV === 'production') {
      console.error('[DB] Tip: On Render, use the standard connection string (mongodb://...) in MONGODB_URI or MONGODB_URI_STANDARD to avoid SRV DNS errors.');
    }
  });

// ====================================================
// MIDDLEWARE
// ====================================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'crypto-signals-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: uri, collectionName: 'sessions' }),
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Load user data into res.locals for all templates
app.use(async (req, res, next) => {
  res.locals.user = null;
  res.locals.balance = 10000;
  if (req.session && req.session.userId) {
    try {
      const user = await User.findById(req.session.userId).lean();
      if (user) {
        res.locals.user = user;
        res.locals.balance = user.paperBalance;
        req.session.username = user.username;
      }
    } catch (err) { /* ignore */ }
  }
  next();
});

app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
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
  res.render('login', { activePage: 'login', error: null });
});

app.post('/login', guestOnly, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !(await user.comparePassword(password))) {
      return res.render('login', { activePage: 'login', error: 'Invalid email or password' });
    }
    req.session.userId = user._id;
    req.session.username = user.username;
    res.redirect('/');
  } catch (err) {
    res.render('login', { activePage: 'login', error: 'Something went wrong' });
  }
});

app.get('/register', guestOnly, (req, res) => {
  res.render('register', { activePage: 'register', error: null });
});

app.post('/register', guestOnly, async (req, res) => {
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
    res.redirect('/');
  } catch (err) {
    res.render('register', { activePage: 'register', error: err.message || 'Registration failed' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

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

    const signals = analyzeAllCoins(prices, allCandles, allHistory);

    res.render('dashboard', {
      activePage: 'dashboard',
      prices,
      signals
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

    const prices = await fetchAllPrices();
    const coinData = prices.find(p => p.id === coinId);
    if (!coinData) {
      return res.status(404).send('Price data unavailable. <a href="/">Back to Dashboard</a>');
    }

    const candles = fetchCandles(coinId);
    const allHistory = await fetchAllHistory();
    const history = allHistory[coinId] || { prices: [], volumes: [] };
    const sig = analyzeCoin(coinData, candles, history);

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
// TRADE ROUTES (require login)
// ====================================================
app.get('/trades', requireLogin, async (req, res) => {
  try {
    const trades = await getOpenTrades(req.session.userId);
    const prices = await fetchAllPrices();
    res.render('trades', {
      activePage: 'trades',
      trades,
      prices,
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
    const { coinId, direction, score } = req.body;
    if (!coinId || !direction) {
      return res.redirect('/trades?error=' + encodeURIComponent('Missing trade data'));
    }

    const prices = await fetchAllPrices();
    const coinData = prices.find(p => p.id === coinId);
    if (!coinData) {
      return res.redirect('/trades?error=' + encodeURIComponent('Price data not available'));
    }

    const candles = fetchCandles(coinId);
    const allHistory = await fetchAllHistory();
    const history = allHistory[coinId] || { prices: [], volumes: [] };
    const signal = analyzeCoin(coinData, candles, history);

    const lev = signal.suggestedLeverage || suggestLeverage(parseInt(score) || 0, signal.regime || 'mixed', 'normal');

    const tradeData = {
      coinId,
      symbol: COIN_META[coinId]?.symbol || coinId.toUpperCase(),
      direction,
      entry: signal.entry || coinData.price,
      stopLoss: signal.stopLoss,
      takeProfit1: signal.takeProfit1,
      takeProfit2: signal.takeProfit2,
      takeProfit3: signal.takeProfit3,
      leverage: lev,
      score: signal.score || parseInt(score) || 0,
      strategyType: signal.strategyType || 'manual',
      regime: signal.regime || 'unknown',
      reasoning: signal.reasoning || [],
      indicators: signal.indicators || {}
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

    const priceData = getCurrentPrice(trade.coinId);
    const currentPrice = priceData ? priceData.price : trade.entryPrice;

    const closed = await closeTrade(req.session.userId, trade._id, currentPrice, 'MANUAL');
    res.redirect('/trades?success=' + encodeURIComponent(`Closed ${trade.symbol} for ${closed.pnl >= 0 ? '+' : ''}$${closed.pnl.toFixed(2)}`));
  } catch (err) {
    console.error('[CloseTrade] Error:', err);
    res.redirect('/trades?error=' + encodeURIComponent(err.message));
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
    const stats = await getPerformanceStats(req.session.userId);
    res.render('performance', { activePage: 'performance', stats });
  } catch (err) {
    console.error('[Performance] Error:', err);
    res.status(500).send('Error loading performance');
  }
});

// ====================================================
// ACCOUNT RESET
// ====================================================
app.post('/account/reset', requireLogin, async (req, res) => {
  try {
    await resetAccount(req.session.userId);
    res.redirect('/performance');
  } catch (err) {
    res.redirect('/performance');
  }
});

// ====================================================
// JOURNAL
// ====================================================
app.get('/journal', requireLogin, async (req, res) => {
  try {
    const entries = await Journal.find({ userId: req.session.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Discipline stats
    const allEntries = await Journal.find({ userId: req.session.userId }).lean();
    const withRules = allEntries.filter(e => e.followedRules !== undefined);
    const ruleStats = {
      total: withRules.length,
      followed: withRules.filter(e => e.followedRules).length,
      avgRating: allEntries.length > 0
        ? (allEntries.filter(e => e.rating).reduce((s, e) => s + e.rating, 0) / (allEntries.filter(e => e.rating).length || 1)).toFixed(1)
        : '0'
    };

    res.render('journal', {
      activePage: 'journal',
      entries,
      ruleStats,
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
    const { type, emotion, followedRules, content, rating } = req.body;
    if (!content || !content.trim()) {
      return res.redirect('/journal?error=' + encodeURIComponent('Content is required'));
    }

    const entry = new Journal({
      userId: req.session.userId,
      type: type || 'trade_note',
      emotion: emotion || 'neutral',
      followedRules: followedRules === 'true',
      content: content.trim(),
      rating: parseInt(rating) || undefined
    });
    await entry.save();

    res.redirect('/journal?success=' + encodeURIComponent('Journal entry saved'));
  } catch (err) {
    res.redirect('/journal?error=' + encodeURIComponent(err.message));
  }
});

// ====================================================
// LEARN PAGE
// ====================================================
app.get('/learn', (req, res) => {
  res.render('learn', { activePage: 'learn' });
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
    const signals = analyzeAllCoins(prices, allCandles, allHistory);
    res.json({ success: true, generated: new Date().toISOString(), count: signals.length, signals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/prices', async (req, res) => {
  try {
    const prices = await fetchAllPrices();
    res.json({ success: true, data: prices });
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

// ====================================================
// AUTO-CHECK STOPS & TPs (runs every 60 seconds)
// ====================================================
setInterval(() => {
  checkStopsAndTPs(getCurrentPrice).catch(err =>
    console.error('[AutoCheck] Error:', err.message)
  );
}, 60 * 1000);

// ====================================================
// START SERVER
// ====================================================
app.listen(PORT, () => {
  console.log(`[Server] CryptoSignals Pro v3.0 running on port ${PORT}`);
  console.log(`[Server] Dashboard: http://localhost:${PORT}`);
  console.log(`[Server] API: http://localhost:${PORT}/api/signals`);
});
