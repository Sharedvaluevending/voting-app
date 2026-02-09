# Strategies & Signals — Current State & Plan

## What You Have Now

### 4 strategies (style-based)
| Strategy         | ID (engine)   | Best in regime   | Focus |
|------------------|--------------|------------------|--------|
| Trend Following  | trend_follow | trending         | 1D/4H trend + ADX |
| Breakout         | breakout     | compression      | 1H volatility + structure |
| Mean Reversion   | mean_revert  | ranging          | 1H momentum + structure |
| Momentum         | momentum     | trending         | 1H momentum + volume |

### 3 timeframes
- **1H** (25% weight) — 168 candles from Binance  
- **4H** (35% weight) — 100 candles  
- **1D** (40% weight) — 30 candles  

### 5 regimes
- trending, compression, ranging, volatile, mixed  

### One signal per coin
The engine picks the **single best** strategy per coin and outputs one signal (STRONG_BUY / BUY / SELL / STRONG_SELL / HOLD).

---

## What’s Missing (diversity & horizon)

- **Scalping** — Very short-term (minutes to 1H), small targets. Needs **5m or 15m** candles; you only have 1h/4h/1d.
- **Swing** — Multi-day holds, 4H/1D focus. You have the timeframes but no dedicated “swing” strategy that emphasizes 4H/1D and longer structure.
- **Position** — Longer-term (weeks), 1D (and eventually 1W) bias. No 1W data or dedicated position strategy.
- **Multiple signals per coin** — Right now you only show the top strategy; you could show 2–3 strategy views (e.g. “Trend: BUY, Mean reversion: HOLD”) for more diverse signals.

---

## Bug to fix first

- **Strategy ID mismatch:** Trading engine uses `mean_revert`, learning engine and DB use `mean_reversion`. Mean Reversion trade outcomes are **not** recorded to the correct strategy.  
- **Fix:** Use one ID everywhere. Prefer `mean_revert` in both `trading-engine.js` and `learning-engine.js` (and in DB on next init), or add `mean_revert` as an alias when recording.

---

## Plan to make signals “next level” robust

### Phase 1 — Fixes & regime coverage (quick)
1. **Unify strategy ID** — Use `mean_revert` in learning-engine and StrategyWeight defaults so outcomes record correctly.
2. **Regime coverage in learning** — Add `compression` and `mixed` to `StrategyWeight.performance.byRegime` so all 5 regimes are tracked.

### Phase 2 — More timeframes (more signals)
3. **Add 15m candles** (Binance supports `15m`).  
   - Fetch 15m alongside 1h/4h/1d (e.g. 96 candles for 24h).  
   - Use 15m in the engine for a “short-term” score (e.g. 15m + 1H) so you can detect scalping-style setups.
4. **Optional: Add 1W candles** (e.g. 52 candles).  
   - Use for “position” bias and to avoid fighting the weekly trend.

### Phase 3 — New strategy types (diversity)
5. **Scalping strategy**  
   - New strategy id: `scalping`.  
   - Scores mainly from **15m + 1H**: tight structure, high volatility, quick momentum, volume spike.  
   - Bonus in regimes: `volatile` or `compression`.  
   - Learning engine: add `scalping` to `DEFAULT_STRATEGIES` and ensure it’s in the DB.

6. **Swing strategy**  
   - New strategy id: `swing`.  
   - Scores mainly from **4H + 1D**: trend, structure, momentum on higher timeframes.  
   - Bonus in `trending` and `compression`.  
   - Add to learning engine and DB.

7. **Position strategy (optional)**  
   - New strategy id: `position`.  
   - Scores from **1D** (and 1W when added): macro trend, 1D structure.  
   - Add to learning engine and DB.

### Phase 4 — Richer signal output (optional)
8. **Multi-strategy view**  
   - For each coin, compute scores for all strategies (current four + new ones).  
   - Return or display **top 2–3** strategies with their signal and strength (e.g. “Trend: STRONG_BUY 78, Swing: BUY 62, Scalping: HOLD 45”).  
   - Lets users see diverse signals and choose by style (scalping vs swing vs trend).

9. **Label by horizon**  
   - Tag signals with suggested horizon: e.g. “Scalping (15m/1H)”, “Swing (4H/1D)”, “Position (1D)”.  
   - Helps users match signals to their preferred style.

---

## Suggested order of work

| Step | Task                                      | Effect |
|------|-------------------------------------------|--------|
| 1    | Fix mean_revert / mean_reversion ID       | Learning engine tracks Mean Reversion correctly |
| 2    | Add compression + mixed to byRegime       | Full regime stats for all strategies |
| 3    | Add 15m candles + scalping strategy       | Real scalping-style signals |
| 4    | Add swing strategy (4H/1D focus)          | Clear swing-style signals |
| 5    | (Optional) Add 1W + position strategy     | Long-term bias and diversity |
| 6    | (Optional) Multi-strategy view per coin   | More diverse signals in UI/API |

If you tell me which phase you want to do first (e.g. “Phase 1 only” or “Phase 1 + 2 + 3”), I can implement it step by step in the repo.
