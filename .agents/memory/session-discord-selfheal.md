---
name: Main Session Discord self-heal
description: Why/where backfillMainSessions back-fills Discord events for website-only session rows, closing gaps left by a Live-off window.
---

`backfillMainSessions()` (eventsService.ts) has a `healUnsyncedSessions` pass that
pushes any FUTURE, non-cancelled `event_type='session'` row with a null
`discord_event_id` to Discord (when Live), then links it.

**Why:** session rows are created by `createEvent`, whose Discord push is gated on
the shared mission `ctx.live`. If the daily `main_session_backfill` cron runs while
Live is OFF (e.g. a go-live window), the calendar rows exist but never get a Discord
event — and `reconcileDiscordEvents` deliberately SKIPS website-only rows ("owned by
the create/edit path"), so nothing ever back-fills them. That left Sessions 70–79 on
the calendar with no Discord events while 67–69 and 80 had them.

**How to apply:**
- The heal runs BEFORE the horizon early-returns, so it fires even when coverage
  already reaches the horizon (the gap can sit entirely below the latest row).
- It counts a row healed only on a genuine push (`discordEventId && !discordSyncError`),
  so a suppressed/failed write is reported as still-unsynced, not silently healed.
- dryRun lists would-heal titles without touching Discord.
- Remember Discord writes are deployment-gated (see discord-deployment-gated-writes.md).
