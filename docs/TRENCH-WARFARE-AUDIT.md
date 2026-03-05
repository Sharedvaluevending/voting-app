# Trench Warfare Audit

Audit of Trench Warfare (Solana memecoin scalping bot): trading logic, math, and new toggles.

---

## Trading Logic — LONG Only (Correct)

Trench Warfare is **LONG-only**. It buys tokens and sells them. No shorts — correct for Solana DEX memecoins (no native shorting).

- **Entry:** BUY token (swap SOL → token or paper USD → token)
- **Exit:** SELL token (swap token → SOL or paper sell)

---

## Math Verification

### PnL (Long)
- **Entry:** `amountIn` USD spent, `tokenAmount = amountIn / slippedEntry`, `slippedEntry = entryPrice * (1 + 0.008)`
- **Exit:** `valueOut = tokenAmount * slippedPrice`, `slippedPrice = currentPrice * (1 - 0.008)`
- **PnL:** `valueOut - amountIn` ✓
- **PnL %:** `((slippedPrice - entryPrice) / entryPrice) * 100` ✓

### Stop Loss / Take Profit
- **SL:** `pnlPct <= -sl` → sell ✓
- **TP:** `pnlPct >= tp` → sell ✓ (skipped when useTrailingTP)
- **Trailing:** `dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100`; sell when `dropFromPeak >= adaptiveTrail` ✓

### Breakeven
- When `pnlPct >= breakevenAt`, set `breakevenTriggered`
- If `breakevenTriggered` and `pnlPct <= 0` → sell ✓

---

## New Toggles Added

| Toggle | Purpose |
|--------|---------|
| **Trailing Take Profit** | When enabled, skip fixed TP; exit profit only via trailing stop |
| **Volume Filter** | Require min 24h volume (minVolume24hUsd, default 25k) |
| **Volatility Filter** | Skip tokens with 24h change outside range (min/max %) |

### Strategy-Aware Bounds (API)
- **Memecoin:** TP 1–5%, SL 1–5%, hold 2–5 min
- **Scalping:** TP 5–50%, SL 3–30%, hold 5–15 min

---

## Entry Filters Flow

1. Blacklist
2. **Volume filter** (when enabled): `volume24h >= minVolume24hUsd`
3. **Volatility filter** (when enabled): `minVolatility24hPercent <= priceChange24h <= maxVolatility24hPercent`
4. Max 24h change, min liquidity, max top10 holders (Mobula)
5. Rug protection (insiders, bundlers, snipers, dev holdings)

---

## Exit Logic Order

1. Stop loss (`pnlPct <= -sl`)
2. Take profit (`pnlPct >= tp`) — skipped if useTrailingTP
3. Breakeven stop (if triggered and `pnlPct <= 0`)
4. Early bail (down at halfway hold)
5. Stale position (flat at 70% hold)
6. Time limit
7. Trailing stop (drop from peak >= trail)
