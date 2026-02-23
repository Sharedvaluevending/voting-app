# Main Platform (BTC, XRP, etc.) – Recommendations to Improve Win Rate & PnL

Based on 7-day trade review: 65 trades, 53.8% win rate, **-$1,790 total PnL**

---

## Trade Review Summary

| Metric | Value |
|--------|-------|
| Trades | 65 |
| Win rate | 53.8% |
| Total PnL | **-$1,790** |
| STOPPED_OUT | 23 |
| TRAILING_TP_EXIT | 24 |
| CLOSED_MANUAL | 17 |
| TP1_HIT | 1 |

**By strategy (PnL):**
- breakout: **-$1,631** (5W/7L) – main drag
- UNI: -$850 (5W/5L)
- AVAX: -$536 (1W/5L)
- INJ: -$408 (2W/3L)
- momentum: **+$559** (12W/5L)
- swing: **+$434** (8W/3L)
- POL: **+$912** (7W/1L)

**Insight:** Win rate > 50% but PnL negative because losses are larger than wins. breakout strategy and a few coins drive most of the drawdown.

---

## Settings & Toggles – Recommendations

### 1. **Expectancy filter – ON**
- **Current:** Default OFF
- **Recommendation:** Turn ON, min expectancy 0.15
- **Why:** Block strategies with negative expectancy. breakout is clearly negative; this would filter it once you have enough history.

### 2. **Excluded coins**
- **Current:** User can exclude coins manually
- **Recommendation:** Exclude or down-weight: AVAX, UNI, INJ, NEAR, DOT based on recent performance
- **Why:** These coins are net losers in the sample. Reduce exposure until they improve.

### 3. **Strategy-level block (code)**
- **Recommendation:** Add a “strategy block” or “strategy cooldown” when a strategy has lost X trades in a row or has negative expectancy
- **Why:** breakout is -$1,631. A simple “block breakout after 3 consecutive losses” or “block when strategy expectancy < 0” would have saved a lot.

### 4. **Min R:R filter – ON**
- **Current:** Default OFF
- **Recommendation:** Turn ON, min R:R 1.2–1.5
- **Why:** Avoid low R:R trades where one loss wipes several wins.

### 5. **Price-action confluence – ON**
- **Current:** Default OFF
- **Recommendation:** Turn ON
- **Why:** Require order block, FVG, or liquidity cluster. Fewer trades, higher conviction.

### 6. **Volume confirmation – ON**
- **Current:** Default OFF
- **Recommendation:** Turn ON
- **Why:** Require relative volume > 1.0. Avoid thin, low-conviction moves.

### 7. **Funding rate filter – ON**
- **Current:** Default OFF
- **Recommendation:** Turn ON
- **Why:** Skip crowded trades (e.g. skip LONG when funding > 0.15%).

### 8. **Correlation filter – ON**
- **Current:** Default OFF
- **Recommendation:** Turn ON
- **Why:** Avoid opening ETH + MATIC (or other highly correlated pairs) at the same time.

### 9. **Drawdown sizing – ON**
- **Current:** Default OFF
- **Recommendation:** Turn ON, threshold 10%
- **Why:** Halve position size after 10% drawdown to limit damage in bad streaks.

### 10. **Max daily loss – set**
- **Current:** 0 (off)
- **Recommendation:** Set to 5–10%
- **Why:** Stop trading for the day after a large loss.

### 11. **Coin weights – ON**
- **Current:** Optional
- **Recommendation:** Turn ON, load from backtest
- **Why:** Favor POL, ARB, momentum, swing; reduce weight on coins that underperform.

### 12. **Auto-trade min score**
- **Current:** 52
- **Recommendation:** Raise to 55–58
- **Why:** Fewer trades, higher average quality.

### 13. **Cooldown hours**
- **Current:** 4
- **Recommendation:** 6–8 for same coin/direction
- **Why:** Avoid re-entering the same coin too soon after a loss.

### 14. **Trailing stop behavior**
- **Observation:** TRAILING_TP_EXIT includes both wins and losses
- **Recommendation:** Review logic – trailing stop should lock profit, not turn winners into losers. Consider tightening trail or adding a “min profit before trail activates” rule.

### 15. **Score re-check – keep ON**
- **Current:** ON by default
- **Recommendation:** Keep ON
- **Why:** Exit or reduce when score collapses. Important for cutting bad trades.

### 16. **Partial TP – keep ON**
- **Current:** ON (40/30/30)
- **Recommendation:** Keep ON
- **Why:** Lock in profit at TP1; let the rest run.

### 17. **Breakeven at 0.75R – keep ON**
- **Current:** ON
- **Recommendation:** Keep ON
- **Why:** Protects capital once trade is in profit.

### 18. **DCA – OFF**
- **Current:** Default OFF
- **Recommendation:** Keep OFF unless you have strong evidence it helps
- **Why:** Can increase exposure to losing trades.

---

## Code-Level Recommendations (Future)

1. **Strategy block list:** Allow blocking strategies (e.g. breakout) when they fail a performance threshold.
2. **Per-coin performance tracking:** Auto-suggest excluded coins based on rolling win rate / PnL.
3. **Trailing stop review:** Ensure trailing stop only activates after a minimum profit (e.g. 0.5R) and does not turn winners into losers.
4. **Trade review script:** Extend `scripts/review-main-trades.js` with `--by-strategy`, `--by-coin`, and `--hours` for ongoing analysis.

---

## Quick Wins (No Code)

| Action | Impact |
|--------|--------|
| Exclude AVAX, UNI, INJ, NEAR, DOT | High |
| Turn ON Expectancy filter | High |
| Turn ON Min R:R 1.2 | Medium |
| Turn ON Price-action confluence | Medium |
| Turn ON Volume confirmation | Medium |
| Raise auto-trade min score to 56 | Medium |
| Set max daily loss 5% | Medium |
| Turn ON Drawdown sizing | Medium |
| Load coin weights from backtest | Medium |

---

## Summary

The main issue is not win rate (53.8%) but **loss size vs win size**. breakout and a few coins drive most losses. Turning on quality filters (expectancy, min R:R, price-action, volume), excluding weak coins, and using coin weights should improve results without code changes.
