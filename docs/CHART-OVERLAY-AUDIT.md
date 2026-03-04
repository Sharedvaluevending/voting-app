# Chart Overlay Audit

## Summary

Audit of all overlay toggles in chart dropdown menus (Overlays, Levels, Patterns, Advanced) for:
1. **Rendering** — draws on chart when enabled
2. **Zoom** — scales and redraws correctly
3. **Pan** — follows chart when panning
4. **Timeframe switching** — recalculates and redraws for new timeframe

## Overlays Audited

### Overlays
| Toggle | Rendering | Zoom | Pan | Timeframe | Notes |
|--------|-----------|------|-----|-----------|-------|
| Volume | ✓ | ✓ | ✓ | ✓ | Histogram series, native LWC |
| Bollinger Bands | ✓ | ✓ | ✓ | ✓ | Line series |
| Moving Averages | ✓ | ✓ | ✓ | ✓ | Line series |
| Keltner Channel | ✓ | ✓ | ✓ | ✓ | Line series |
| Donchian Channel | ✓ | ✓ | ✓ | ✓ | Line series |
| Fibonacci | ✓ | ✓ | ✓ | ✓ | Price lines |

### Levels
| Toggle | Rendering | Zoom | Pan | Timeframe | Notes |
|--------|-----------|------|-----|-----------|-------|
| Support/Resistance | ✓ | ✓ | ✓ | ✓ | Price lines |
| POC (Volume) | ✓ | ✓ | ✓ | ✓ | Price lines |
| Pivot Points | ✓ | ✓ | ✓ | ✓ | Price lines |

### Patterns
| Toggle | Rendering | Zoom | Pan | Timeframe | Notes |
|--------|-----------|------|-----|-----------|-------|
| Chart Patterns | ✓ | ✓ | ✓ | ✓ | Line series + markers |
| Action Badges | ✓ | ✓ | ✓ | ✓ | Markers |
| Candlestick Patterns | ✓ | ✓ | ✓ | ✓ | Markers |

### Advanced
| Toggle | Rendering | Zoom | Pan | Timeframe | Notes |
|--------|-----------|------|-----|-----------|-------|
| Order Blocks | ✓ | ✓ | ✓ | ✓ | Price lines + canvas zones |
| Fair Value Gaps | ✓ | ✓ | ✓ | ✓ | Price lines + canvas zones |
| Liquidity Clusters | ✓ | ✓ | ✓ | ✓ | Price lines |
| VWAP | ✓ | ✓ | ✓ | ✓ | Price line |
| Premium/Discount | ✓ | ✓ | ✓ | ✓ | Equilibrium price line |
| Swing Points | ✓ | ✓ | ✓ | ✓ | Markers |
| Market Structure | ✓ | ✓ | ✓ | ✓ | Text overlay |
| Session Markers | ✓ | ✓ | ✓ | ✓ | Canvas bands |
| Gap Markers | ✓ | ✓ | ✓ | ✓ | Canvas |
| Volume Profile | ✓ | ✓ | ✓ | ✓ | Canvas |
| RSI | ✓ | ✓ | ✓ | ✓ | Sub-pane chart |
| MACD | ✓ | ✓ | ✓ | ✓ | Sub-pane chart |

## Fixes Applied

1. **indicator-zones-canvas DPR scaling** — Canvas (OB zones, FVG zones, Sessions, Gaps, Volume Profile) was drawn at 1:1 CSS pixels while the canvas buffer used `devicePixelRatio`. On high-DPI displays this caused misalignment and blur. Added `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` and `ctx.restore()` so drawing matches the scaled canvas.

2. **Explicit renderZoneOverlays on timeframe switch** — Added a direct call to `renderZoneOverlays()` in the timeframe-update block so canvas overlays (OB, FVG, Sessions, Gaps, VP) always redraw with new data, even if `addPriceLines` throws partway through.

## Architecture Notes

- **Lightweight Charts series** (BB, MA, Keltner, Donchian, Chart Patterns): Native LWC; zoom/pan/timeframe handled by library.
- **Price lines** (Fib, S/R, POC, Pivots, OB, FVG, Liq, VWAP, Premium): Attached to main series; follow zoom/pan; redrawn on timeframe via `addPriceLines`.
- **Canvas overlays** (OB/FVG zones, Sessions, Gaps, VP): Drawn on `indicator-zones-canvas`; redraw on `subscribeVisibleLogicalRangeChange` (zoom/pan) and on timeframe switch.
- **Markers** (Action Badges, Candlestick Patterns, Swing Points): `setMarkers` on main series; follow zoom/pan; redrawn via `applyActionMarkers` on timeframe switch.
