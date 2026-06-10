---
name: Economy disabled symptom
description: Diagnosing "command failed" on dashboard income WORK/SLUT and where the economy on/off controls live.
---

# Dashboard income "command failed" = economy disabled

The dashboard INCOME card WORK/SLUT buttons route payouts through `applyWalletDelta`, which is gated by the economy tri-state in `lib/economy.ts`:

- `economy_enabled` (bot_config kill switch) — absent/false => mode `disabled` => every economy action returns `{ok:false,status:"disabled"}`.
- `economy` LiveSystem (`master_live_mode` AND `economy_live_mode`) — decides `test` (dry-run, no real eddies) vs `enabled` (live).

So a generic "command failed" on the income card almost always means the **economy is disabled** (kill switch off), NOT a 500. The route returns a structured 502 ("Could not complete WORK right now"), and the frontend falls back to "Command failed" when it can't read `response.data.error`.

**Why:** all three project DBs default these flags OFF (fail-safe), and for a long time there was NO admin UI to turn the economy on. `economy` is a real `LiveSystem` in `lib/liveMode.ts` (LIVE_SYSTEMS) but was missing from the AdminDashboard `LIVE_MODE_SYSTEMS` switchboard list, and `economy_enabled` had no AutobillSwitch — so the whole economy was un-toggleable from the UI.

**How to apply:** to make WORK/SLUT actually pay, an admin must (Jobs tab) ENABLE the "Economy System" kill switch, then (Live Mode switchboard) set MASTER + Economy to LIVE for real eddies (or leave TEST for dry-run). Both controls now exist in `AdminDashboard.tsx`. The backend already accepted `economy` via the generic bot-config PUT and the live-mode PUT (LIVE_SYSTEMS) — only the OpenAPI spec + frontend needed wiring.
