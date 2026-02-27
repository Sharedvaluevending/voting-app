# Strategy Builder — Feature Plan

## Overview

New trading section (main nav, not Trench Warfare) where users can:
- Pick from 25+ indicators
- Adjust indicator settings (periods, multipliers)
- Combine indicators into custom rules
- Backtest strategies on historical data
- Save combinations and win rates

**Principle:** Additive only. No changes to existing backtest, trading engine, or live flows.

---

## Part 1: Indicator-Based Strategies (Defaults)

Using our 25+ indicators, here are **extra strategies** to offer as built-in presets. Users can start from these and tweak.

### Tier 1 — Simple (1–2 indicators)

| # | Strategy Name | Entry Rule | Exit Rule | Indicators Used |
|---|---------------|------------|-----------|------------------|
| 1 | **EMA Crossover** | EMA(9) crosses above EMA(21) | EMA(9) crosses below EMA(21) | EMA 9, 21 |
| 2 | **RSI Mean Reversion** | RSI < 30 (oversold) | RSI > 70 (overbought) | RSI 14 |
| 3 | **MACD Crossover** | MACD crosses above signal line | MACD crosses below signal | MACD 12,26,9 |
| 4 | **Stochastic Bounce** | Stoch K crosses above D in oversold (<20) | Stoch K crosses below D in overbought (>80) | Stochastic 14 |
| 5 | **Bollinger Bounce** | Price touches lower band in uptrend | Price touches upper band or RSI > 70 | Bollinger 20,2, RSI |
| 6 | **VWAP Reversion** | Price 2% below VWAP | Price at or above VWAP | VWAP |

### Tier 2 — Confluence (2–3 indicators)

| # | Strategy Name | Entry Rule | Exit Rule | Indicators Used |
|---|---------------|------------|-----------|------------------|
| 7 | **EMA + RSI Pullback** | Price > EMA21, pullback to EMA9, RSI 40–60 | RSI > 70 or price < EMA21 | EMA 9,21, RSI |
| 8 | **MACD + Trend** | MACD cross up AND price > EMA21 | MACD cross down | MACD, EMA 21 |
| 9 | **ADX Breakout** | ADX > 25, price breaks above resistance | ADX drops < 20 or price breaks support | ADX 14, S/R |
| 10 | **Bollinger Squeeze** | BB width < 20% of 50-bar avg (squeeze) | Break above upper band (long) or below lower (short) | Bollinger 20,2 |
| 11 | **Volume Confirmation** | Price breakout + volume > 1.5× avg | Volume climax or reversal | Volume, S/R |
| 12 | **Order Block + RSI** | Price at bull OB, RSI < 40 | RSI > 65 or price at bear OB | Order Blocks, RSI |

### Tier 3 — Advanced (3+ indicators)

| # | Strategy Name | Entry Rule | Exit Rule | Indicators Used |
|---|---------------|------------|-----------|------------------|
| 13 | **Triple Confluence** | Price > EMA9 > EMA21, RSI 40–60, MACD hist > 0 | MACD cross down OR RSI > 70 | EMA, RSI, MACD |
| 14 | **Divergence Reversal** | RSI bullish div + price at support | RSI bearish div or resistance | RSI, Divergence, S/R |
| 15 | **Structure Break** | Market structure BREAK_UP + volume confirm | Structure BREAK_DOWN or target hit | Market Structure, Volume |
| 16 | **Keltner Breakout** | Price breaks upper Keltner with volume | Price back inside channel | Keltner 20,2 |
| 17 | **Donchian Breakout** | Price breaks 20-period high | Price breaks 20-period low (trailing) | Donchian 20 |
| 18 | **Liquidity Sweep** | Price sweeps liquidity cluster below, reverses | Next liquidity cluster above | Liquidity Clusters |
| 19 | **FVG + Momentum** | Price enters bullish FVG, RSI > 50 | FVG filled or RSI < 40 | FVG, RSI |
| 20 | **Candlestick + MACD** | Bullish engulfing at support + MACD cross up | Bearish engulfing or MACD cross down | Candlestick patterns, MACD |
| 21 | **Chart Pattern Target** | Bull flag breakout, volume confirm | Measured move target or pattern invalidation | Chart patterns, Volume |
| 22 | **Premium/Discount** | Price in discount zone (< 50% range) | Price in premium zone (> 50%) | Premium/Discount, S/R |
| 23 | **Pivot Bounce** | Price at pivot support, RSI oversold | Price at pivot resistance | Pivot Points, RSI |
| 24 | **ATR Volatility** | ATR expansion after squeeze (vol breakout) | ATR contraction or TP | ATR 14 |
| 25 | **Multi-Divergence** | 2+ divergence types (RSI + MACD) bullish at support | 2+ bearish at resistance | RSI, MACD, OBV, Stoch div |

---

## Part 2: Implementation Plan

### Phase 1 — Foundation (no changes to existing code)

| Step | Task | Output |
|------|------|--------|
| 1.1 | Create `lib/indicators.js` — copy indicator math from trading-engine (EMA, RSI, MACD, etc.) with configurable params | Reusable indicator functions |
| 1.2 | Add Keltner, Donchian, Pivots, Fib to `lib/indicators.js` (from chart logic or new) | Full indicator set |
| 1.3 | Create `services/strategy-builder/rule-engine.js` — evaluates user-defined rules on candle data | Rule evaluator |
| 1.4 | Create `StrategyConfig` and `StrategyBacktestResult` models | DB schema for saved strategies |

### Phase 2 — Backtest Integration

| Step | Task | Output |
|------|------|--------|
| 2.1 | Create `services/strategy-builder/run-custom-backtest.js` — uses existing candle fetch + execution sim, custom signal source | New backtest path |
| 2.2 | Add API route `POST /api/strategy-builder/backtest` | Backtest endpoint |
| 2.3 | Wire rule engine to backtest — bar-by-bar: compute indicators, eval rules, emit BUY/SELL/HOLD | Working backtest |

### Phase 3 — UI

| Step | Task | Output |
|------|------|--------|
| 3.1 | Add nav link "Strategy Builder" (main nav, near Backtest) | Navigation |
| 3.2 | Create `views/strategy-builder.ejs` — indicator picker, rule builder, timeframe selector | Main page |
| 3.3 | Preset dropdown — 25 strategies above as starting templates | Quick start |
| 3.4 | Save/Load — save strategy config + last backtest result to DB | Persistence |
| 3.5 | Results table — win rate, trades, PnL, max drawdown per strategy | Results display |

### Phase 4 — Polish

| Step | Task | Output |
|------|------|--------|
| 4.1 | Indicator settings panel — period, multiplier, overbought/oversold levels | Configurable params |
| 4.2 | Multi-timeframe — 15m, 1h, 4h, 1d selector | TF support |
| 4.3 | Compare mode — run 2–3 strategies side-by-side | Comparison |

---

## Part 3: Technical Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     STRATEGY BUILDER (NEW)                       │
├─────────────────────────────────────────────────────────────────┤
│  lib/indicators.js          ← New: configurable indicator math   │
│  services/strategy-builder/                                     │
│    ├── rule-engine.js       ← New: eval user rules               │
│    ├── run-custom-backtest.js← New: backtest with custom signals  │
│    └── presets.js           ← New: 25 strategy definitions      │
│  models/StrategyConfig.js    ← New: saved strategies              │
│  models/StrategyBacktestResult.js ← New: backtest results        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ uses (read-only)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     EXISTING (UNCHANGED)                          │
├─────────────────────────────────────────────────────────────────┤
│  services/backtest.js       ← fetchHistoricalCandlesMultiTF       │
│  services/crypto-api.js     ← candle APIs                         │
│  services/backtest/         ← execution-simulator, trade-state   │
│  services/trading-engine.js ← NOT TOUCHED                        │
│  services/engines/signal-engine.js ← NOT TOUCHED                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 4: Rule Format (Example)

Strategy config stored as JSON:

```json
{
  "name": "EMA Crossover",
  "timeframe": "1h",
  "entry": {
    "type": "crossover",
    "indicator": "EMA",
    "params": { "fast": 9, "slow": 21 },
    "direction": "above"
  },
  "exit": {
    "type": "crossover",
    "indicator": "EMA",
    "params": { "fast": 9, "slow": 21 },
    "direction": "below"
  }
}
```

Or for confluence (AND of conditions):

```json
{
  "name": "Triple Confluence",
  "timeframe": "4h",
  "entry": {
    "type": "and",
    "conditions": [
      { "type": "above", "indicator": "EMA", "params": { "period": 9 }, "compareTo": "price" },
      { "type": "range", "indicator": "RSI", "params": { "period": 14 }, "min": 40, "max": 60 },
      { "type": "above", "indicator": "MACD_histogram", "params": {}, "value": 0 }
    ]
  },
  "exit": { "type": "or", "conditions": [...] }
}
```

---

## Part 5: File Checklist

| File | Action |
|------|--------|
| `lib/indicators.js` | Create |
| `services/strategy-builder/rule-engine.js` | Create |
| `services/strategy-builder/run-custom-backtest.js` | Create |
| `services/strategy-builder/presets.js` | Create |
| `models/StrategyConfig.js` | Create |
| `models/StrategyBacktestResult.js` | Create |
| `views/strategy-builder.ejs` | Create |
| `voting-app.js` | Add route + nav link |
| `views/partials/header.ejs` | Add nav item |

---

## Part 6: Estimated Scope

| Phase | Effort | Risk to Existing |
|-------|--------|------------------|
| Phase 1 — Foundation | 2–3 days | None |
| Phase 2 — Backtest | 1–2 days | None |
| Phase 3 — UI | 2–3 days | None |
| Phase 4 — Polish | 1–2 days | None |

**Total:** ~7–10 days for full feature.

---

---

## Part 7: Auto-Trade Mode Selector (New)

Add a setting so users can choose which signal system powers auto-trade (paper + live):

| Option | Description |
|--------|--------------|
| **Original** | Use current scoring engine (0–100, 6 categories, regime gating). Default. |
| **Indicators** | Use Strategy Builder rules (when built). User picks a saved strategy. |
| **Both** | Run both; open when either system signals (OR logic) or when both agree (AND logic). |

**Where:** Performance / Settings page, in the Auto-Trade section.

**Schema:** `user.settings.autoTradeSignalMode`: `'original'` \| `'indicators'` \| `'both'`  
**If both:** `user.settings.autoTradeBothLogic`: `'or'` \| `'and'`

---

## Part 8: Top 3 Trading — Why It Fails (Review)

### What’s happening

Top 3 Whole Market coins are scored and shown on the dashboard, but manual trading often fails. Root causes:

### 1. Confluence gate

Trade is allowed only when:
- Score ≥ 55
- Confluence ≥ 1 (if score ≥ 58) or ≥ 2 (if score 52–57)

Top 3 use **history-based analysis** (CoinGecko close prices → fake OHLCV). That often yields:
- `confluenceLevel` 0 or 1
- So even with score 55–57, the gate blocks the trade.

### 2. Live price

`fetchLivePrice(coinId)`:
1. Tries Bitget with `symbol + 'USDT'` (from `registerScannerCoinMeta`)
2. Tries Kraken with `KRAKEN_PAIRS[coinId]` — **only defined for TRACKED_COINS**
3. Falls back to cache — top 3 coins are not in the main refresh

For top 3, Kraken fallback is skipped. If Bitget doesn’t list the symbol (e.g. STETHUSDT), live price fails → “Live price unavailable” → trade blocked.

### 3. Bitget coverage

Bitget may not list all top-80 coins. Some (e.g. staked-ether) use different symbols or are missing.

### Fixes (recommended)

| Fix | Effort | Impact |
|-----|--------|--------|
| **A. Relax confluence for top 3** | Low | Allow trade when score ≥ 55 and confluence ≥ 1 for scanner coins |
| **B. Add Kraken pairs for common top-80** | Medium | Extend `KRAKEN_PAIRS` for tron, toncoin, staked-ether, etc. |
| **C. Dynamic Kraken pair** | Medium | For scanner coins, try `{SYMBOL}USD` when Bitget fails |
| **D. Fetch real candles for top 3** | Higher | Use Bitget/Kraken OHLCV for top 3 so analysis matches tracked coins |

**Quick win:** A + B. Relax confluence for non-tracked coins and add ~15–20 common top-80 Kraken pairs.

---

## Next Steps

1. Review this plan.
2. Confirm which of the 25 strategies to ship in v1 (or all).
3. Decide on rule format complexity (simple crossover vs full AND/OR).
4. Approve to start Phase 1.
5. Decide on Top 3 fixes: A only, A+B, or full D.
