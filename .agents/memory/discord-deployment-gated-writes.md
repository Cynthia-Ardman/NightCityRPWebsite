---
name: Discord writes are deployment-gated
description: Outbound Discord writes (events, DMs, channel posts, role grants) only fire from the live deployment; dev/scripts silently no-op unless opted in.
---

`externalWritesAllowed()` in `discord.ts` gates EVERY outbound Discord WRITE
(create/modify/delete scheduled events, DMs, channel posts, role grant/remove).
It returns true only when `REPLIT_DEPLOYMENT === "1"` OR `ALLOW_EXTERNAL_WRITES === "1"`.

**Why:** the community test site runs in the Replit dev workspace with the SAME
bot token and can have Live-Mode flags inherited from a prod data sync — so the
token/live-flag alone is NOT a safe guard. The deployment flag is the real guard.
Reads (OAuth, role lookups, fetches) are NOT gated and work everywhere.

**How to apply:**
- Running a backfill/heal/sync script from the workspace (even pointed at the live
  prod DB) will NOT push to Discord — `createGuildScheduledEvent` etc. return
  `{ ok:false, error:"External Discord writes are disabled in this (test) environment" }`
  and the row gets a `discordSyncError` but no `discordEventId` (no partial link).
- To genuinely push from the workspace, prefix the run with `ALLOW_EXTERNAL_WRITES=1`
  (sanctioned opt-in). Otherwise deploy and let the deployed cron / admin "Run job"
  do it.
- Discord rate-limits scheduled-event creates hard (429, retry_after ~7-8s) and the
  client does NOT auto-retry — creating ~10 events needs several idempotent re-runs;
  the heal only re-targets still-unlinked rows so re-running is safe.
