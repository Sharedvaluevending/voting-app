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
const crypto = require('crypto');
const path = require('path');

const { fetchAllPrices, fetchAllCandles, fetchAllCandlesForCoin, fetchAllHistory, fetchCandles, getCurrentPrice, fetchLivePrice, isDataReady, getFundingRate, getAllFundingRates, pricesReadyPromise, TRACKED_COINS, COIN_META } = require('./services/crypto-api');
const { analyzeAllCoins, analyzeCoin } = require('./services/trading-engine');
const { requireLogin, optionalUser, guestOnly } = require('./middleware/auth');
const { openTrade, closeTrade, checkStopsAndTPs, recheckTradeScores, SCORE_RECHECK_MINUTES, getOpenTrades, getTradeHistory, getPerformanceStats, resetAccount, suggestLeverage } = require('./services/paper-trading');
const { initializeStrategies, getPerformanceReport } = require('./services/learning-engine');
const bitget = require('./services/bitget');
const StrategyWeight = require('./models/StrategyWeight');

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

// Require SESSION_SECRET in production to prevent session forgery
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : 'crypto-signals-dev-key-only');
if (!sessionSecret) {
  console.error('FATAL: SESSION_SECRET environment variable is required in production. Set it and restart.');
  process.exit(1);
}

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: uri, collectionName: 'sessions' }),
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Load user data into res.locals for all templates
app.use(async (req, res, next) => {
  res.locals.user = null;
  res.locals.balance = 10000;
  res.locals.livePnl = null;
  if (req.session && req.session.userId) {
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
      }
    } catch (err) { /* ignore */ }
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

// Make CSRF token available in all templates
app.use((req, res, next) => {
  if (req.session) {
    res.locals.csrfToken = generateCsrfToken(req.session);
  }
  next();
});

// Validate CSRF on all POST/PUT/DELETE requests (except API endpoints used by fetch with session cookies)
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    // Skip CSRF for JSON API calls (they use fetch with same-origin and custom headers)
    const isJsonApi = req.path.startsWith('/api/') || req.xhr || req.headers['content-type']?.includes('application/json');
    if (!isJsonApi && !validateCsrfToken(req)) {
      console.warn(`[CSRF] Blocked ${req.method} ${req.path} from ${req.ip} (bad/missing token)`);
      return res.status(403).send('Forbidden: invalid or missing CSRF token. Please refresh the page and try again.');
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

// Build engine options: strategy weights, BTC signal, strategy stats, funding rates, BTC candles
async function buildEngineOptions(prices, allCandles, allHistory) {
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
  return { strategyWeights, strategyStats, btcSignal, btcCandles, btcDirection, fundingRates };
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
    const options = await buildEngineOptions(prices, allCandles, allHistory);
    const signals = analyzeAllCoins(prices, allCandles, allHistory, options);

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
  if (!meta || !meta.binance) {
    return res.status(404).send('Chart not available for this coin. <a href="/">Back to Dashboard</a>');
  }
  // Use Kraken for TradingView symbol if Binance is unavailable
  const KRAKEN_TV_PAIRS = {
    'BTCUSDT': 'KRAKEN:BTCUSD', 'ETHUSDT': 'KRAKEN:ETHUSD', 'SOLUSDT': 'KRAKEN:SOLUSD',
    'DOGEUSDT': 'KRAKEN:DOGEUSD', 'XRPUSDT': 'KRAKEN:XRPUSD', 'ADAUSDT': 'KRAKEN:ADAUSD',
    'DOTUSDT': 'KRAKEN:DOTUSD', 'AVAXUSDT': 'KRAKEN:AVAXUSD', 'LINKUSDT': 'KRAKEN:LINKUSD',
    'MATICUSDT': 'KRAKEN:MATICUSD', 'BNBUSDT': 'BINANCE:BNBUSDT', 'LTCUSDT': 'KRAKEN:LTCUSD',
    'UNIUSDT': 'KRAKEN:UNIUSD', 'ATOMUSDT': 'KRAKEN:ATOMUSD'
  };
  const tvSymbol = KRAKEN_TV_PAIRS[meta.binance] || ('BINANCE:' + meta.binance);
  let entry = req.query.entry ? Number(req.query.entry) : null;
  let sl = req.query.sl ? Number(req.query.sl) : null;
  const tp1 = req.query.tp1 ? Number(req.query.tp1) : null;
  const tp2 = req.query.tp2 ? Number(req.query.tp2) : null;
  const tp3 = req.query.tp3 ? Number(req.query.tp3) : null;
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
      if (!sl && trade.stopLoss) sl = trade.stopLoss;
      if (!entry && trade.entryPrice) entry = trade.entryPrice;
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
    fibLevels
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
    const { coinId, direction, score, strategyType } = req.body;
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

    const [allCandles, allHistory, livePrice] = await Promise.all([
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory(),
      fetchLivePrice(coinId)
    ]);
    const options = await buildEngineOptions(await fetchAllPrices(), allCandles, allHistory);
    const candles = fetchCandles(coinId);
    const history = allHistory[coinId] || { prices: [], volumes: [] };
    const signal = analyzeCoin(coinData, candles, history, options);

    const useScore = parseInt(score, 10) || signal.score || 0;
    const lev = signal.suggestedLeverage || suggestLeverage(useScore, signal.regime || 'mixed', 'normal');

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

    if (strategyType && signal.topStrategies && Array.isArray(signal.topStrategies)) {
      const strat = signal.topStrategies.find(s => s.id === strategyType);
      if (strat && strat.entry != null && strat.stopLoss != null) {
        // Entry always uses live price; strategy provides SL/TP levels
        stopLoss = strat.stopLoss;
        takeProfit1 = strat.takeProfit1;
        takeProfit2 = strat.takeProfit2;
        takeProfit3 = strat.takeProfit3;
        usedStrategyType = strat.id;
      }
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
      strategyStats: strategyStatsForKelly
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
    const [stats, user] = await Promise.all([
      getPerformanceStats(req.session.userId),
      User.findById(req.session.userId).lean()
    ]);
    const safeStats = stats || {
      balance: 10000, initialBalance: 10000, totalPnl: 0, totalPnlPercent: '0', totalTrades: 0,
      openTrades: 0, wins: 0, losses: 0, winRate: '0', avgWin: 0, avgLoss: 0, profitFactor: '0',
      bestTrade: 0, worstTrade: 0, currentStreak: 0, bestStreak: 0, pnl7d: 0,
      byStrategy: {}, byCoin: {}, equityCurve: []
    };
    res.render('performance', {
      activePage: 'performance',
      stats: safeStats,
      user: user || {},
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (err) {
    console.error('[Performance] Error:', err);
    res.status(500).send('Error loading performance');
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
      const v = Math.min(95, Math.max(30, parseInt(req.body.autoTradeMinScore, 10) || 70));
      s.autoTradeMinScore = v;
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
    u.settings = s;
    await u.save();
    res.redirect('/performance?success=Settings+saved');
  } catch (err) {
    res.redirect('/performance?error=' + encodeURIComponent(err.message || 'Failed to save'));
  }
});

// ====================================================
// ACCOUNT RESET
// ====================================================
app.post('/account/reset', requireLogin, async (req, res) => {
  try {
    // Server-side confirmation: require confirm=RESET to prevent accidental/CSRF resets
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
    // Don't save masked values
    if (apiKey.startsWith('••')) {
      return res.redirect('/exchange?error=' + encodeURIComponent('Please enter your full API key, not the masked value'));
    }

    const user = await User.findById(req.session.userId);
    if (!user) return res.redirect('/login');

    // Save keys temporarily for test
    user.bitget = {
      apiKey,
      secretKey,
      passphrase,
      connected: false,
      lastVerified: null
    };

    // Test connection before confirming
    const testResult = await bitget.testConnection(user);
    if (testResult.success) {
      user.bitget.connected = true;
      user.bitget.lastVerified = new Date();
      await user.save();
      res.redirect('/exchange?success=' + encodeURIComponent('Connected to Bitget successfully!'));
    } else {
      // Don't save bad keys
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
      autoOpenMinScore: 75
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
      user.liveTrading.autoOpenMinScore = Math.min(95, Math.max(50, parseInt(req.body.autoOpenMinScore, 10) || 75));
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
    const entries = await Journal.find({ userId: req.session.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Load trade if coming from "Journal this trade" link
    let linkedTrade = null;
    const tradeId = req.query.tradeId;
    if (tradeId) {
      linkedTrade = await Trade.findOne({ _id: tradeId, userId: req.session.userId }).lean();
    }

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

    // Analytics: win rate by emotion, win rate by rules followed (from trade-linked entries)
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

    res.render('journal', {
      activePage: 'journal',
      entries,
      ruleStats,
      linkedTrade,
      analytics: { byEmotion, byRules },
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
    const { type, emotion, followedRules, content, rating, tradeId } = req.body;
    if (!content || !content.trim()) {
      return res.redirect('/journal?error=' + encodeURIComponent('Content is required'));
    }

    const entryData = {
      userId: req.session.userId,
      type: type || 'trade_note',
      emotion: emotion || 'neutral',
      followedRules: followedRules === 'true',
      content: content.trim(),
      rating: parseInt(rating) || undefined
    };
    if (tradeId && mongoose.Types.ObjectId.isValid(tradeId)) {
      const trade = await Trade.findOne({ _id: tradeId, userId: req.session.userId });
      if (trade) entryData.tradeId = trade._id;
    }

    const entry = new Journal(entryData);
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
    res.render('learning', { activePage: 'learning', strategies });
  } catch (err) {
    console.error('[Learning] Error:', err);
    res.render('learning', { activePage: 'learning', strategies: [] });
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
    const options = await buildEngineOptions(prices, allCandles, allHistory);
    const signals = analyzeAllCoins(prices, allCandles, allHistory, options);
    res.json({ success: true, generated: new Date().toISOString(), count: signals.length, signals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/prices', async (req, res) => {
  try {
    const prices = await fetchAllPrices();
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
    }
    if (!allCandles || !allCandles[interval]) {
      return res.json({ success: true, candles: [] });
    }
    const raw = allCandles[interval];
    const candles = raw.map(c => ({
      time: Math.floor(c.openTime / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }));
    res.json({ success: true, candles });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// AUTO-CHECK STOPS & TPs (runs every 30 seconds)
// Uses live exchange prices so TPs/SLs aren't missed due to stale cache
// ====================================================
async function runStopTPCheck() {
  try {
    const openTrades = await Trade.find({ status: 'OPEN' }).select('coinId').lean();
    if (openTrades.length === 0) return;
    // Fetch live prices from Binance/Kraken for all coins with open trades
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
    await checkStopsAndTPs(getLivePrice);
  } catch (err) {
    console.error('[AutoCheck] Error:', err.message);
  }
}
setInterval(runStopTPCheck, 30 * 1000);
// Run first check 15s after startup
setTimeout(runStopTPCheck, 15 * 1000);

// ====================================================
// TRADE SCORE RE-CHECK (runs every SCORE_RECHECK_MINUTES)
// Re-analyzes each open trade's coin and generates
// status messages: confidence, momentum, structure, etc.
// ====================================================
async function runScoreRecheck() {
  try {
    const [prices, allCandles, allHistory] = await Promise.all([
      fetchAllPrices(),
      Promise.resolve(fetchAllCandles()),
      fetchAllHistory()
    ]);
    if (!prices || prices.length === 0) return; // prices not loaded yet
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

// ====================================================
// AUTO-TRADE: Periodically scan signals for users with autoTrade enabled
// Opens paper trades (and live if Bitget connected) automatically
// when signal score meets threshold. Runs every 2 minutes.
// ====================================================
async function runAutoTrade() {
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
    const options = await buildEngineOptions(prices, allCandles, allHistory);
    const signals = analyzeAllCoins(prices, allCandles, allHistory, options);
    if (!signals || signals.length === 0) return;

    // For each signal, find the best strategy and its score/direction
    // The overall coin score (e.g. 57) can be lower than individual strategies (e.g. Position at 72)
    // Auto-trade should use the BEST strategy score since that's what the trader would pick
    const signalsWithBestStrategy = signals.map(sig => {
      const coinId = sig.coin?.id || sig.id;
      let bestScore = sig.score || 0;
      let bestStrat = null;
      let direction = null;

      // Check topStrategies for a higher-scoring strategy with a clear direction
      if (sig.topStrategies && Array.isArray(sig.topStrategies)) {
        for (const strat of sig.topStrategies) {
          const stratScore = strat.score || 0;
          const stratSignal = strat.signal || '';
          // Only consider strategies with a directional signal
          if (stratSignal === 'STRONG_BUY' || stratSignal === 'BUY' || stratSignal === 'STRONG_SELL' || stratSignal === 'SELL') {
            if (stratScore > bestScore || !bestStrat) {
              bestScore = stratScore;
              bestStrat = strat;
              direction = (stratSignal === 'STRONG_BUY' || stratSignal === 'BUY') ? 'LONG' : 'SHORT';
            }
          }
        }
      }

      // Fallback to overall signal direction if no strategy qualified
      if (!direction) {
        if (sig.signal === 'STRONG_BUY' || sig.signal === 'BUY') direction = 'LONG';
        else if (sig.signal === 'STRONG_SELL' || sig.signal === 'SELL') direction = 'SHORT';
      }

      return { ...sig, _bestScore: bestScore, _bestStrat: bestStrat, _direction: direction, _coinId: coinId };
    });

    for (const user of autoTradeUsers) {
      try {
        // Use paper trading min score from settings, fallback to exchange setting, then default 70
        const minScore = user.settings?.autoTradeMinScore ?? user.liveTrading?.autoOpenMinScore ?? 70;
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

        // Filter signals: best strategy score >= threshold, has direction, not open, not in cooldown
        const candidates = signalsWithBestStrategy.filter(sig => {
          if (sig._bestScore < minScore) return false;
          if (!sig._direction) return false; // HOLD signals ignored
          if (openCoinIds.includes(sig._coinId)) return false;
          if (cooldownSet.has(`${sig._coinId}_${sig._direction}`)) return false;
          return true;
        }).sort((a, b) => b._bestScore - a._bestScore);

        const slotsAvailable = maxOpen - openTrades.length;
        const toOpen = candidates.slice(0, slotsAvailable);

        for (const sig of toOpen) {
          try {
            const coinId = sig._coinId;
            const coinData = prices.find(p => p.id === coinId);
            if (!coinData) continue;
            const livePrice = await fetchLivePrice(coinId);
            if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) continue;

            // Use the best strategy's levels if available, otherwise use overall signal levels
            const strat = sig._bestStrat;
            let useSL = (strat && strat.stopLoss) || sig.stopLoss;
            let useTP1 = (strat && strat.takeProfit1) || sig.takeProfit1;
            let useTP2 = (strat && strat.takeProfit2) || sig.takeProfit2;
            let useTP3 = (strat && strat.takeProfit3) || sig.takeProfit3;
            const useStratType = (strat && strat.id) || sig.strategyType || 'auto';

            // CRITICAL FIX: Recalculate SL/TP relative to live price
            // The signal analysis used cached prices. If livePrice differs from the
            // price used to calculate SL/TP, the levels will be wrong relative to entry.
            const analysisEntry = (strat && strat.entry) || sig.entry || sig.price || (coinData && coinData.price);
            if (analysisEntry && analysisEntry > 0 && Math.abs(livePrice - analysisEntry) / analysisEntry > 0.005) {
              // Price moved since analysis — scale SL/TP proportionally
              const ratio = livePrice / analysisEntry;
              if (useSL) useSL = parseFloat((useSL * ratio).toFixed(6));
              if (useTP1) useTP1 = parseFloat((useTP1 * ratio).toFixed(6));
              if (useTP2) useTP2 = parseFloat((useTP2 * ratio).toFixed(6));
              if (useTP3) useTP3 = parseFloat((useTP3 * ratio).toFixed(6));
              console.log(`[AutoTrade] ${COIN_META[coinId]?.symbol}: Scaled levels by ${ratio.toFixed(4)} (analysis=$${analysisEntry} live=$${livePrice})`);
            }

            const lev = user.settings?.disableLeverage ? 1 : (sig.suggestedLeverage || suggestLeverage(sig._bestScore, sig.regime || 'mixed', 'normal'));
            const tradeData = {
              coinId,
              symbol: COIN_META[coinId]?.symbol || coinId.toUpperCase(),
              direction: sig._direction,
              entry: livePrice,
              stopLoss: useSL,
              takeProfit1: useTP1,
              takeProfit2: useTP2,
              takeProfit3: useTP3,
              leverage: lev,
              score: sig._bestScore,
              strategyType: useStratType,
              regime: sig.regime || 'unknown',
              reasoning: sig.reasoning || [],
              indicators: sig.indicators || {},
              scoreBreakdown: sig.scoreBreakdown || {},
              stopType: sig.stopType || 'ATR_SR_FIB',
              stopLabel: sig.stopLabel || 'ATR + S/R + Fib',
              tpType: sig.tpType || 'R_multiple',
              tpLabel: sig.tpLabel || 'R multiples',
              autoTriggered: true
            };

            await openTrade(user._id, tradeData);
            console.log(`[AutoTrade] Opened ${sig._direction} on ${tradeData.symbol} (best strat: ${useStratType} score ${sig._bestScore}) for user ${user.username}`);
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
// START SERVER (wait for first price load so dashboard has data)
// ====================================================
const START_TIMEOUT = 140000;
Promise.race([
  pricesReadyPromise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), START_TIMEOUT))
])
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[Server] CryptoSignals Pro v3.0 running on port ${PORT}`);
      console.log(`[Server] Dashboard: http://localhost:${PORT}`);
      console.log(`[Server] API: http://localhost:${PORT}/api/signals`);
    });
  })
  .catch(() => {
    app.listen(PORT, () => {
      console.log(`[Server] CryptoSignals Pro v3.0 running on port ${PORT} (started without waiting for prices)`);
      console.log(`[Server] Dashboard: http://localhost:${PORT}`);
    });
  });
