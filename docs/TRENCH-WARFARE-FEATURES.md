# Trench Warfare – Features & Platform Parity

## Added (this session)

- **Open Positions mobile**: Card layout on screens ≤600px; each position as a card with label/value pairs
- **Trade History mobile**: Same card layout for closed trades
- **Our Chart**: `/trench-chart/:tokenAddress` – embeds DexScreener chart for Solana tokens; links to DexScreener/Birdeye
- **Chart links**: Open Positions, Trade History, Meme Market Explorer – all link to our chart page
- **Block (blacklist)**: Quick blacklist button on each open position – bot skips token in future scans

## Platform trading features (main app) vs Trench

| Feature | Main (CEX) | Trench (DEX) |
|---------|------------|--------------|
| Chart with levels | ✓ `/chart/:coinId` | ✓ `/trench-chart/:tokenAddress` (DexScreener embed) |
| Entry/SL/TP display | ✓ Trades page | ✓ Positions (Entry, PnL) |
| Blacklist | ✓ Excluded coins | ✓ Block button on positions |
| Paper/Live mode | ✓ | ✓ |
| Auto-trade bot | ✓ | ✓ |
| Trade history | ✓ | ✓ |
| Analytics/equity curve | ✓ | ✓ |
| Walk-forward backtest | ✓ | — |
| Strategy weights | ✓ | — |
| SMC setups | ✓ | — |

## Possible future additions

- Copy TP/SL to clipboard from position
- Quick “Add to watchlist” for Meme Market Explorer tokens
- Rugcheck/honeypot score badge on token cards (API integration)
- Trade history: Chart link per closed trade (done)
- Similar/related tokens section (DexScreener API)
