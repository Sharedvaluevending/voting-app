# Push Notifications for Trades & Action Badges

**Date:** 2026-03-04

## Overview

Get notified on your phone when:
- **Trade opened** — new position (paper or live)
- **Trade closed** — position closed (TP, SL, score exit, etc.)
- **Action badges** — BE (breakeven), TS (trailing stop), LOCK, DCA, EXIT, PP, RP

## Setup

### 1. Web Push (Phone Notifications) — Free

1. Generate VAPID keys:
   ```bash
   npx web-push generate-vapid-keys
   ```

2. Add to `.env`:
   ```
   VAPID_PUBLIC_KEY=your-public-key
   VAPID_PRIVATE_KEY=your-private-key
   VAPID_MAILTO=mailto:support@yoursite.com
   ```

3. **HTTPS required** — Web Push only works over HTTPS (or localhost).

4. Go to **Performance → Trading Settings → Push & SMS Notifications** and click **Enable Push (Phone)**.

5. Allow notifications when the browser prompts.

### 2. SMS via Email (Free) — Optional

Many US carriers support email-to-SMS. Format: `number@gateway`

| Carrier | Gateway |
|---------|---------|
| Verizon | @vtext.com |
| AT&T | @txt.att.net |
| T-Mobile | @tmomail.net |
| Sprint | @messaging.sprintpcs.com |

1. Configure SMTP in `.env` (MAIL_HOST, MAIL_USER, MAIL_PASS).

2. Add your SMS email in Performance → e.g. `5551234567@vtext.com`.

3. Save settings.

## User Settings

- **Trade opened** — notify when a new trade opens (default: ON)
- **Trade closed** — notify when a trade closes (default: ON)
- **Action badges** — notify when BE, TS, LOCK, DCA, EXIT fire (default: OFF)

## Why It Wasn't Working Before

The `notifyTradeOpen` and `notifyTradeClose` settings existed but were never wired to any notification logic. The implementation is now complete.
