# Meme Bot: Plan to Get More Winners

Based on 48h trade review (200 trades, 14% win rate, -$207 PnL)

---

## Winner Patterns (What Works)

| Symbol | PnL% | Held | Exit |
|--------|------|------|------|
| JESTER | 48.2% | 0min | take_profit |
| Lobstar | 11.3% | 1min | take_profit |
| Orangutan | 5.7% | 2min | take_profit |
| Cadbury | 5.7% | 2min | take_profit |
| WILSON | 4.6% | 2min | take_profit |
| ALN | 4.6% | 4min | take_profit |
| BIG | 4.4% | 6min | take_profit |
| LobstoneW. | 9.6% | 13min | take_profit |
| SHRIMP | 13.9% | 9min | take_profit |
| ORANMAMA | 24.3% | 4min | take_profit |

**Key insight:** Winners hit TP in 0–6 min. Strong pump at entry → price continues up → TP hit fast.

---

## Loser Patterns (What Fails)

| Type | Count | Pattern |
|------|-------|---------|
| early_bail | 53 | Down 1–3% at 2–4 min, we cut |
| time_limit | 55 | Held to max, small loss at exit |
| stop_loss | 21 | Hit 2% SL, or instant rug (-63% to -90%) |

**Key insight:** Losers reverse within 2 min of entry. We enter, price dumps, we bail or hit SL.

---

## Root Cause

1. **Entry quality** – Too many weak candidates pass. We enter tokens that look OK but reverse.
2. **Rugs** – STRONG -63%, OMFG -11%, BIG -18%, SHRIMP -90%. One rug wipes many wins.
3. **Re-entry trap** – BIG: +4.4% win, then -17.9% loss on re-entry. Chasing winners.
4. **Volume/activity** – Winners may have stronger volume surge + more buyers.

---

## Plan: 6 Changes to Get More Winners

### 1. Require Volume Surge (High Impact)
**Current:** volSurge >= 0.5 gets 5 pts (optional)
**Change:** Reject memecoin if volSurge < 1.0 (vol1h must match or exceed avg hourly)
**Why:** Pumps need volume. Flat volume = weak signal.

### 2. Require Higher numBuyers (Medium Impact)
**Current:** numBuyers >= 5 gets 5 pts
**Change:** Require numBuyers >= 8 for memecoin (reject below)
**Why:** More buyers = more organic interest, less likely to reverse.

### 3. Cooldown After TP (High Impact)
**Current:** Winners get 1x cooldown (1h default)
**Change:** After TP, 2x cooldown for that token (don’t chase)
**Why:** BIG won +4.4% then we re-entered and lost -17.9%. Avoid chasing.

### 4. Prefer Jupiter Tokens with Organic Score (Medium Impact)
**Current:** Jupiter tokens have organicScore, we don’t use it for memecoin
**Change:** Bonus +10 pts when organicScore >= 50 (Jupiter only)
**Why:** Higher organic = less bot/sniper activity, more genuine pump.

### 5. Raise Min Score to 25 (Medium Impact)
**Current:** minScore = 15
**Change:** minScore = 25 for memecoin
**Why:** Fewer trades, higher quality. Top ~30% of candidates only.

### 6. Lower TP to 1.5% Option (Low Impact – Config)
**Current:** Default TP 2%
**Change:** Add UI option for 1.5% TP (lock in more small wins)
**Why:** Some winners hit 1.5% in 30s then reverse. Lower TP = more wins, smaller size.

---

## Implementation Priority

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 1 | Volume surge >= 1.0 required | Low | High |
| 2 | Cooldown 2x after TP | Low | High |
| 3 | numBuyers >= 8 required | Low | Medium |
| 4 | organicScore bonus | Low | Medium |
| 5 | minScore 25 | Low | Medium |
| 6 | 1.5% TP option | Low | Low |

---

## Already Implemented (Keep)

- 5m >= 0.5% required
- buyDominance >= 40% required
- 5m > 15% reject (already pumped)
- 5m/1h ratio reject (late entry)
- Auto-blacklist on -50% rug
- Big-loss cooldown 20 min
- Min liquidity 10k
- Momentum 0.3% required

---

## Metrics to Track

After implementing:
- Win rate (target: 20%+)
- Avg hold time for winners (target: < 4 min)
- early_bail count (should drop with better entries)
- Rug count (should stay low with filters)
