// voting-app.js
// ====================================================
// CRYPTO TRADING SIGNALS APP
// Real-time trade recommendations with entry/TP/SL levels
// powered by CoinGecko market data + technical analysis.
// ====================================================

const express = require('express');
const mongoose = require('mongoose');
const ejs = require('ejs');

const { fetchAllPrices, fetchPriceHistory, fetchAllHistory, TRACKED_COINS, COIN_META } = require('./services/crypto-api');
const { analyzeAllCoins, analyzeCoin } = require('./services/trading-engine');

const app = express();
const PORT = process.env.PORT || 3000;

// ====================================================
// MONGODB CONNECTION
// ====================================================
const mongoURI = process.env.MONGODB_URI || 'mongodb+srv://sharedvaluevending:KTwSLX9PeeaXIXME@cluster0.1blpa.mongodb.net/votingApp?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(mongoURI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('MongoDB connection error:', err));

// ====================================================
// MONGOOSE MODELS
// ====================================================

// SignalLog: Track generated signals for historical accuracy
const signalLogSchema = new mongoose.Schema({
  coinId: { type: String, required: true },
  symbol: { type: String, required: true },
  signal: { type: String, required: true },
  entry: Number,
  takeProfit1: Number,
  takeProfit2: Number,
  takeProfit3: Number,
  stopLoss: Number,
  confidence: Number,
  priceAtSignal: Number,
  createdAt: { type: Date, default: Date.now }
});
signalLogSchema.index({ coinId: 1, createdAt: -1 });
const SignalLog = mongoose.model('SignalLog', signalLogSchema);

// ====================================================
// MIDDLEWARE
// ====================================================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
  res.removeHeader("X-Frame-Options");
  next();
});

// ====================================================
// DASHBOARD TEMPLATE
// ====================================================
const dashboardTemplate = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Crypto Trading Signals</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0a0e17; color: #e1e5eb; min-height: 100vh; }
    .dashboard { max-width: 1400px; margin: 0 auto; padding: 16px; }

    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; padding-bottom: 16px; border-bottom: 1px solid #1e2a3a; }
    .header h1 { font-size: 22px; color: #fff; letter-spacing: -0.5px; }
    .header h1 span { color: #3b82f6; }
    .header-meta { font-size: 12px; color: #6b7280; }
    .nav-links { display: flex; gap: 8px; }
    .nav-links a { color: #9ca3af; text-decoration: none; font-size: 13px; padding: 6px 14px; border: 1px solid #1e2a3a; border-radius: 6px; transition: all 0.2s; }
    .nav-links a:hover, .nav-links a.active { background: #1e2a3a; color: #fff; }

    /* Ticker Strip */
    .ticker-strip { display: flex; gap: 8px; overflow-x: auto; padding: 8px 0 16px; scrollbar-width: thin; scrollbar-color: #1e2a3a transparent; }
    .ticker-strip::-webkit-scrollbar { height: 4px; }
    .ticker-strip::-webkit-scrollbar-thumb { background: #1e2a3a; border-radius: 2px; }
    .ticker { background: #111827; border: 1px solid #1e2a3a; border-radius: 8px; padding: 10px 14px; min-width: 130px; flex-shrink: 0; cursor: pointer; transition: border-color 0.2s; }
    .ticker:hover { border-color: #3b82f6; }
    .ticker-sym { font-weight: 700; font-size: 13px; color: #9ca3af; }
    .ticker-price { font-size: 17px; font-weight: 700; color: #fff; margin: 2px 0; }
    .ticker-change { font-size: 12px; font-weight: 600; }
    .up { color: #10b981; }
    .down { color: #ef4444; }

    /* Signal Cards */
    .signals-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .signal-card { background: #111827; border: 1px solid #1e2a3a; border-radius: 12px; padding: 18px; transition: border-color 0.2s; }
    .signal-card:hover { border-color: #3b82f6; }
    .signal-card.strong-buy { border-left: 3px solid #10b981; }
    .signal-card.buy { border-left: 3px solid #3b82f6; }
    .signal-card.hold { border-left: 3px solid #eab308; }
    .signal-card.sell { border-left: 3px solid #f97316; }
    .signal-card.strong-sell { border-left: 3px solid #ef4444; }

    .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
    .coin-info h3 { font-size: 18px; color: #fff; font-weight: 700; }
    .coin-info .symbol { font-size: 12px; color: #6b7280; font-weight: 400; }
    .coin-price { text-align: right; }
    .coin-price .price { font-size: 18px; font-weight: 700; color: #fff; }
    .coin-price .change { font-size: 13px; font-weight: 600; }

    .signal-badge { display: inline-block; padding: 4px 12px; border-radius: 6px; font-size: 13px; font-weight: 700; letter-spacing: 0.5px; }
    .badge-STRONG_BUY { background: #064e3b; color: #10b981; }
    .badge-BUY { background: #1e3a5f; color: #3b82f6; }
    .badge-HOLD { background: #3b3510; color: #eab308; }
    .badge-SELL { background: #4a2510; color: #f97316; }
    .badge-STRONG_SELL { background: #451a1a; color: #ef4444; }

    .signal-meta { display: flex; gap: 16px; margin: 10px 0; font-size: 13px; color: #9ca3af; }
    .signal-meta span { display: flex; align-items: center; gap: 4px; }

    /* Levels Grid */
    .levels { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 12px 0; }
    .level { background: #0d1320; border-radius: 6px; padding: 8px 10px; }
    .level-label { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
    .level-value { font-size: 15px; font-weight: 700; }
    .level-value.entry { color: #3b82f6; }
    .level-value.tp { color: #10b981; }
    .level-value.sl { color: #ef4444; }
    .level-value.rr { color: #a78bfa; }

    /* Reasoning */
    .reasoning { margin-top: 12px; padding-top: 12px; border-top: 1px solid #1e2a3a; }
    .reasoning h4 { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .reason { font-size: 13px; color: #9ca3af; padding: 3px 0; padding-left: 12px; border-left: 2px solid #1e2a3a; margin-bottom: 4px; }

    /* Timeframe Row */
    .tf-row { display: flex; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
    .tf-chip { font-size: 11px; padding: 4px 10px; border-radius: 6px; display: inline-flex; gap: 6px; align-items: center; }
    .tf-bull { background: #0d2818; color: #10b981; border: 1px solid #064e3b; }
    .tf-bear { background: #2a1010; color: #ef4444; border: 1px solid #451a1a; }
    .tf-neutral { background: #1a1a0d; color: #eab308; border: 1px solid #3b3510; }
    .tf-label { font-weight: 700; }
    .tf-rsi { color: #6b7280; font-size: 10px; }

    /* Indicators Mini */
    .indicators-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
    .ind { font-size: 11px; color: #6b7280; }
    .ind span { color: #9ca3af; font-weight: 600; }

    /* Summary Bar */
    .summary-bar { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .summary-stat { background: #111827; border: 1px solid #1e2a3a; border-radius: 8px; padding: 12px 18px; flex: 1; min-width: 140px; }
    .summary-stat .label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
    .summary-stat .value { font-size: 22px; font-weight: 700; color: #fff; margin-top: 2px; }

    .disclaimer { font-size: 11px; color: #4b5563; text-align: center; margin-top: 32px; padding: 16px; border-top: 1px solid #1e2a3a; line-height: 1.5; }

    .loading-note { font-size: 13px; color: #6b7280; text-align: center; padding: 40px; }

    @media (max-width: 500px) {
      .signals-grid { grid-template-columns: 1fr; }
      .levels { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="dashboard">
    <div class="header">
      <div>
        <h1><span>Crypto</span> Trading Signals</h1>
        <div class="header-meta">Real-time analysis powered by technical indicators | Updated: <%= new Date().toLocaleString() %></div>
      </div>
      <div class="nav-links">
        <a href="/" class="active">Dashboard</a>
        <a href="/api/signals">API</a>
      </div>
    </div>

    <!-- PRICE TICKER -->
    <div class="ticker-strip">
      <% prices.forEach(function(coin) { %>
        <div class="ticker" onclick="location.href='/coin/<%= coin.id %>'">
          <div class="ticker-sym"><%= coin.symbol %></div>
          <div class="ticker-price">$<%= formatPrice(coin.price) %></div>
          <div class="ticker-change <%= coin.change24h >= 0 ? 'up' : 'down' %>">
            <%= coin.change24h >= 0 ? '+' : '' %><%= coin.change24h.toFixed(2) %>%
          </div>
        </div>
      <% }); %>
    </div>

    <!-- SUMMARY -->
    <div class="summary-bar">
      <div class="summary-stat">
        <div class="label">Strong Buys</div>
        <div class="value up"><%= signals.filter(s => s.signal === 'STRONG_BUY').length %></div>
      </div>
      <div class="summary-stat">
        <div class="label">Buys</div>
        <div class="value" style="color:#3b82f6;"><%= signals.filter(s => s.signal === 'BUY').length %></div>
      </div>
      <div class="summary-stat">
        <div class="label">Holds</div>
        <div class="value" style="color:#eab308;"><%= signals.filter(s => s.signal === 'HOLD').length %></div>
      </div>
      <div class="summary-stat">
        <div class="label">Sells</div>
        <div class="value down"><%= signals.filter(s => s.signal === 'SELL' || s.signal === 'STRONG_SELL').length %></div>
      </div>
      <div class="summary-stat">
        <div class="label">Coins Tracked</div>
        <div class="value"><%= signals.length %></div>
      </div>
    </div>

    <!-- SIGNAL CARDS -->
    <% if (signals.length === 0) { %>
      <div class="loading-note">
        Loading market data... The first load takes ~20 seconds while we fetch price history.<br>
        <strong>This page will auto-refresh in 30 seconds.</strong>
      </div>
      <script>setTimeout(function(){ location.reload(); }, 30000);</script>
    <% } %>

    <div class="signals-grid">
      <% signals.forEach(function(sig) { %>
        <div class="signal-card <%= sig.signal.toLowerCase().replace('_', '-') %>">
          <div class="card-header">
            <div class="coin-info">
              <h3><%= sig.coin.name %> <span class="symbol"><%= sig.coin.symbol %></span></h3>
              <span class="signal-badge badge-<%= sig.signal %>"><%= sig.signal.replace('_', ' ') %></span>
            </div>
            <div class="coin-price">
              <div class="price">$<%= formatPrice(sig.coin.price) %></div>
              <div class="change <%= sig.coin.change24h >= 0 ? 'up' : 'down' %>">
                <%= sig.coin.change24h >= 0 ? '+' : '' %><%= sig.coin.change24h.toFixed(2) %>% (24h)
              </div>
            </div>
          </div>

          <div class="signal-meta">
            <span>Strength: <strong><%= sig.strength %>%</strong></span>
            <span>Confidence: <strong><%= sig.confidence %>%</strong></span>
            <span>R:R <strong><%= sig.riskReward %>x</strong></span>
            <span>Confluence: <strong><%= sig.confluenceLevel %>/3</strong></span>
            <span>Best TF: <strong><%= sig.bestTimeframe %></strong></span>
          </div>

          <% if (sig.timeframes) { %>
          <div class="tf-row">
            <% ['1H','4H','1D'].forEach(function(tf) { var t = sig.timeframes[tf]; if(t) { %>
              <div class="tf-chip <%= t.direction === 'BULL' ? 'tf-bull' : t.direction === 'BEAR' ? 'tf-bear' : 'tf-neutral' %>">
                <span class="tf-label"><%= tf %></span> <%= t.signal %> <span class="tf-rsi">RSI <%= t.rsi %></span>
              </div>
            <% }}); %>
          </div>
          <% } %>

          <% if (sig.entry) { %>
          <div class="levels">
            <div class="level">
              <div class="level-label">Entry</div>
              <div class="level-value entry">$<%= formatPrice(sig.entry) %></div>
            </div>
            <div class="level">
              <div class="level-label">Stop Loss</div>
              <div class="level-value sl"><%= sig.stopLoss ? '$' + formatPrice(sig.stopLoss) : '-' %></div>
            </div>
            <div class="level">
              <div class="level-label">Risk / Reward</div>
              <div class="level-value rr"><%= sig.riskReward %>x</div>
            </div>
            <div class="level">
              <div class="level-label">TP 1</div>
              <div class="level-value tp"><%= sig.takeProfit1 ? '$' + formatPrice(sig.takeProfit1) : '-' %></div>
            </div>
            <div class="level">
              <div class="level-label">TP 2</div>
              <div class="level-value tp"><%= sig.takeProfit2 ? '$' + formatPrice(sig.takeProfit2) : '-' %></div>
            </div>
            <div class="level">
              <div class="level-label">TP 3</div>
              <div class="level-value tp"><%= sig.takeProfit3 ? '$' + formatPrice(sig.takeProfit3) : '-' %></div>
            </div>
          </div>
          <% } %>

          <div class="reasoning">
            <h4>Why This Trade</h4>
            <% sig.reasoning.forEach(function(reason) { %>
              <div class="reason"><%= reason %></div>
            <% }); %>
          </div>

          <% if (sig.indicators && sig.indicators.rsi !== undefined) { %>
          <div class="indicators-row">
            <div class="ind">RSI <span><%= sig.indicators.rsi %></span></div>
            <% if (sig.indicators.trend) { %><div class="ind">Trend <span><%= sig.indicators.trend.replace('_',' ') %></span></div><% } %>
            <% if (sig.indicators.macdHistogram !== undefined) { %><div class="ind">MACD <span class="<%= sig.indicators.macdHistogram >= 0 ? 'up' : 'down' %>"><%= sig.indicators.macdHistogram >= 0 ? '+' : '' %><%= sig.indicators.macdHistogram %></span></div><% } %>
            <% if (sig.indicators.stochK !== undefined) { %><div class="ind">Stoch <span><%= sig.indicators.stochK %>/<%= sig.indicators.stochD %></span></div><% } %>
            <% if (sig.indicators.bollingerUpper) { %><div class="ind">BB <span><%= formatPrice(sig.indicators.bollingerLower) %> - <%= formatPrice(sig.indicators.bollingerUpper) %></span></div><% } %>
            <% if (sig.indicators.support) { %><div class="ind">S/R <span><%= formatPrice(sig.indicators.support) %>/<%= formatPrice(sig.indicators.resistance) %></span></div><% } %>
            <% if (sig.indicators.volumeTrend) { %><div class="ind">Vol <span><%= sig.indicators.volumeTrend %></span></div><% } %>
          </div>
          <% } %>
        </div>
      <% }); %>
    </div>

    <div class="disclaimer">
      This tool is for informational and educational purposes only. Not financial advice.
      Always do your own research (DYOR). Crypto is volatile - never trade more than you can afford to lose.
      Signals are generated from technical analysis of public market data via CoinGecko API.
    </div>
  </div>
</body>
</html>
`;

// ====================================================
// COIN DETAIL TEMPLATE
// ====================================================
const coinDetailTemplate = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title><%= sig.coin.name %> (<%= sig.coin.symbol %>) - Trade Signal</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0a0e17; color: #e1e5eb; min-height: 100vh; }
    .page { max-width: 900px; margin: 0 auto; padding: 20px; }

    .back { color: #3b82f6; text-decoration: none; font-size: 13px; display: inline-block; margin-bottom: 16px; }
    .back:hover { text-decoration: underline; }

    .coin-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
    .coin-header h1 { font-size: 28px; color: #fff; }
    .coin-header .price-big { font-size: 32px; font-weight: 700; color: #fff; text-align: right; }
    .coin-header .change-big { font-size: 16px; font-weight: 600; }
    .up { color: #10b981; }
    .down { color: #ef4444; }

    .signal-banner { padding: 20px; border-radius: 12px; margin-bottom: 24px; text-align: center; }
    .signal-banner.STRONG_BUY { background: linear-gradient(135deg, #064e3b, #111827); border: 1px solid #10b981; }
    .signal-banner.BUY { background: linear-gradient(135deg, #1e3a5f, #111827); border: 1px solid #3b82f6; }
    .signal-banner.HOLD { background: linear-gradient(135deg, #3b3510, #111827); border: 1px solid #eab308; }
    .signal-banner.SELL { background: linear-gradient(135deg, #4a2510, #111827); border: 1px solid #f97316; }
    .signal-banner.STRONG_SELL { background: linear-gradient(135deg, #451a1a, #111827); border: 1px solid #ef4444; }
    .signal-banner h2 { font-size: 24px; color: #fff; }
    .signal-banner .meta { font-size: 14px; color: #9ca3af; margin-top: 4px; }

    .section { background: #111827; border: 1px solid #1e2a3a; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    .section h3 { font-size: 14px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 14px; }

    .levels-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
    .level-box { background: #0d1320; border-radius: 8px; padding: 14px; text-align: center; }
    .level-box .lbl { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
    .level-box .val { font-size: 20px; font-weight: 700; margin-top: 4px; }
    .level-box .val.entry { color: #3b82f6; }
    .level-box .val.tp { color: #10b981; }
    .level-box .val.sl { color: #ef4444; }
    .level-box .val.rr { color: #a78bfa; }

    .reason-item { padding: 10px 14px; background: #0d1320; border-radius: 8px; margin-bottom: 6px; font-size: 14px; color: #d1d5db; line-height: 1.5; }

    .ind-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
    .ind-box { background: #0d1320; border-radius: 8px; padding: 10px 14px; }
    .ind-box .ind-label { font-size: 11px; color: #6b7280; text-transform: uppercase; }
    .ind-box .ind-val { font-size: 16px; font-weight: 600; color: #e1e5eb; margin-top: 2px; }

    .disclaimer { font-size: 11px; color: #4b5563; text-align: center; margin-top: 32px; padding: 16px; border-top: 1px solid #1e2a3a; }
  </style>
</head>
<body>
  <div class="page">
    <a href="/" class="back">&larr; Back to Dashboard</a>

    <div class="coin-header">
      <div>
        <h1><%= sig.coin.name %></h1>
        <span style="color:#6b7280;font-size:14px;"><%= sig.coin.symbol %> | Market Cap: $<%= formatBigNumber(sig.coin.marketCap) %></span>
      </div>
      <div>
        <div class="price-big">$<%= formatPrice(sig.coin.price) %></div>
        <div class="change-big <%= sig.coin.change24h >= 0 ? 'up' : 'down' %>">
          <%= sig.coin.change24h >= 0 ? '+' : '' %><%= sig.coin.change24h.toFixed(2) %>% (24h)
        </div>
      </div>
    </div>

    <div class="signal-banner <%= sig.signal %>">
      <h2><%= sig.signal.replace('_', ' ') %></h2>
      <div class="meta">Strength: <%= sig.strength %>% | Confidence: <%= sig.confidence %>% | Risk/Reward: <%= sig.riskReward %>x</div>
    </div>

    <div class="section">
      <h3>Trade Levels</h3>
      <div class="levels-grid">
        <div class="level-box">
          <div class="lbl">Entry Price</div>
          <div class="val entry">$<%= formatPrice(sig.entry) %></div>
        </div>
        <div class="level-box">
          <div class="lbl">Stop Loss</div>
          <div class="val sl"><%= sig.stopLoss ? '$' + formatPrice(sig.stopLoss) : 'N/A' %></div>
        </div>
        <div class="level-box">
          <div class="lbl">Take Profit 1</div>
          <div class="val tp"><%= sig.takeProfit1 ? '$' + formatPrice(sig.takeProfit1) : 'N/A' %></div>
        </div>
        <div class="level-box">
          <div class="lbl">Take Profit 2</div>
          <div class="val tp"><%= sig.takeProfit2 ? '$' + formatPrice(sig.takeProfit2) : 'N/A' %></div>
        </div>
        <div class="level-box">
          <div class="lbl">Take Profit 3</div>
          <div class="val tp"><%= sig.takeProfit3 ? '$' + formatPrice(sig.takeProfit3) : 'N/A' %></div>
        </div>
        <div class="level-box">
          <div class="lbl">Risk / Reward</div>
          <div class="val rr"><%= sig.riskReward %>x</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h3>Why This Trade</h3>
      <% sig.reasoning.forEach(function(reason) { %>
        <div class="reason-item"><%= reason %></div>
      <% }); %>
    </div>

    <% if (sig.indicators) { %>
    <div class="section">
      <h3>Technical Indicators</h3>
      <div class="ind-grid">
        <% if (sig.indicators.rsi !== undefined) { %>
        <div class="ind-box">
          <div class="ind-label">RSI (14)</div>
          <div class="ind-val"><%= sig.indicators.rsi %></div>
        </div>
        <% } %>
        <% if (sig.indicators.trend) { %>
        <div class="ind-box">
          <div class="ind-label">Trend</div>
          <div class="ind-val"><%= sig.indicators.trend.replace('_', ' ') %></div>
        </div>
        <% } %>
        <% if (sig.indicators.sma20) { %>
        <div class="ind-box">
          <div class="ind-label">SMA 20</div>
          <div class="ind-val">$<%= formatPrice(sig.indicators.sma20) %></div>
        </div>
        <% } %>
        <% if (sig.indicators.sma50) { %>
        <div class="ind-box">
          <div class="ind-label">SMA 50</div>
          <div class="ind-val">$<%= formatPrice(sig.indicators.sma50) %></div>
        </div>
        <% } %>
        <% if (sig.indicators.macdLine !== undefined) { %>
        <div class="ind-box">
          <div class="ind-label">MACD Line</div>
          <div class="ind-val"><%= sig.indicators.macdLine %></div>
        </div>
        <% } %>
        <% if (sig.indicators.macdSignal !== undefined) { %>
        <div class="ind-box">
          <div class="ind-label">MACD Signal</div>
          <div class="ind-val"><%= sig.indicators.macdSignal %></div>
        </div>
        <% } %>
        <% if (sig.indicators.macdHistogram !== undefined) { %>
        <div class="ind-box">
          <div class="ind-label">MACD Histogram</div>
          <div class="ind-val <%= sig.indicators.macdHistogram >= 0 ? 'up' : 'down' %>"><%= sig.indicators.macdHistogram %></div>
        </div>
        <% } %>
        <% if (sig.indicators.atr) { %>
        <div class="ind-box">
          <div class="ind-label">ATR (14)</div>
          <div class="ind-val">$<%= formatPrice(sig.indicators.atr) %></div>
        </div>
        <% } %>
        <% if (sig.indicators.support) { %>
        <div class="ind-box">
          <div class="ind-label">Support</div>
          <div class="ind-val">$<%= formatPrice(sig.indicators.support) %></div>
        </div>
        <% } %>
        <% if (sig.indicators.resistance) { %>
        <div class="ind-box">
          <div class="ind-label">Resistance</div>
          <div class="ind-val">$<%= formatPrice(sig.indicators.resistance) %></div>
        </div>
        <% } %>
        <% if (sig.indicators.volumeTrend) { %>
        <div class="ind-box">
          <div class="ind-label">Volume Trend</div>
          <div class="ind-val"><%= sig.indicators.volumeTrend %></div>
        </div>
        <% } %>
      </div>
    </div>
    <% } %>

    <div class="disclaimer">
      Not financial advice. Always DYOR. Crypto is volatile. Never trade more than you can afford to lose.
    </div>
  </div>
</body>
</html>
`;

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

// ====================================================
// ROUTES
// ====================================================

// Main Dashboard
app.get('/', async (req, res) => {
  try {
    const [prices, allHistory] = await Promise.all([
      fetchAllPrices(),
      fetchAllHistory(7)
    ]);

    const signals = analyzeAllCoins(prices, allHistory);

    // Log signals to DB (non-blocking)
    logSignals(signals).catch(err => console.error('Signal logging error:', err));

    const html = ejs.render(dashboardTemplate, {
      prices,
      signals,
      formatPrice,
      formatBigNumber
    });
    res.send(html);
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Error loading dashboard. Try refreshing.');
  }
});

// Individual Coin Detail
app.get('/coin/:coinId', async (req, res) => {
  try {
    const coinId = req.params.coinId;
    if (!TRACKED_COINS.includes(coinId)) {
      return res.status(404).send('Coin not found. <a href="/">Back to Dashboard</a>');
    }

    const [prices, history] = await Promise.all([
      fetchAllPrices(),
      fetchPriceHistory(coinId, 7)
    ]);

    const coinData = prices.find(p => p.id === coinId);
    if (!coinData) {
      return res.status(404).send('Price data unavailable. <a href="/">Back to Dashboard</a>');
    }

    const sig = analyzeCoin(coinData, history);

    const html = ejs.render(coinDetailTemplate, {
      sig,
      formatPrice,
      formatBigNumber
    });
    res.send(html);
  } catch (err) {
    console.error('Coin detail error:', err);
    res.status(500).send('Error loading coin data. <a href="/">Back to Dashboard</a>');
  }
});

// ====================================================
// JSON API ENDPOINTS
// ====================================================

// All signals
app.get('/api/signals', async (req, res) => {
  try {
    const [prices, allHistory] = await Promise.all([
      fetchAllPrices(),
      fetchAllHistory(7)
    ]);
    const signals = analyzeAllCoins(prices, allHistory);
    res.json({
      success: true,
      generated: new Date().toISOString(),
      count: signals.length,
      signals
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single coin signal
app.get('/api/signals/:coinId', async (req, res) => {
  try {
    const coinId = req.params.coinId;
    if (!TRACKED_COINS.includes(coinId)) {
      return res.status(404).json({ success: false, error: 'Coin not tracked' });
    }

    const [prices, history] = await Promise.all([
      fetchAllPrices(),
      fetchPriceHistory(coinId, 7)
    ]);

    const coinData = prices.find(p => p.id === coinId);
    if (!coinData) return res.status(404).json({ success: false, error: 'No price data' });

    const signal = analyzeCoin(coinData, history);
    res.json({ success: true, signal });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Current prices
app.get('/api/prices', async (req, res) => {
  try {
    const prices = await fetchAllPrices();
    res.json({ success: true, data: prices });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Signal history from DB
app.get('/api/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const coinId = req.query.coin;

    const query = coinId ? { coinId } : {};
    const logs = await SignalLog.find(query).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// SIGNAL LOGGING
// ====================================================
async function logSignals(signals) {
  const logs = signals.map(sig => ({
    coinId: sig.coin.id,
    symbol: sig.coin.symbol,
    signal: sig.signal,
    entry: sig.entry,
    takeProfit1: sig.takeProfit1,
    takeProfit2: sig.takeProfit2,
    takeProfit3: sig.takeProfit3,
    stopLoss: sig.stopLoss,
    confidence: sig.confidence,
    priceAtSignal: sig.coin.price
  }));

  // Only log once per hour per coin
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  for (const log of logs) {
    const recent = await SignalLog.findOne({
      coinId: log.coinId,
      createdAt: { $gte: oneHourAgo }
    });
    if (!recent) {
      await new SignalLog(log).save();
    }
  }
}

// ====================================================
// START THE SERVER
// ====================================================
app.listen(PORT, () => {
  console.log(`Crypto Trading Signals running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/signals`);
});
