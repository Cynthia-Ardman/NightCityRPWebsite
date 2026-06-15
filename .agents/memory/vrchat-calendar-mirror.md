---
name: VRChat calendar mirror
description: How website events are cross-posted to the NCRP VRChat group calendar as a third downstream target, and the gating/concurrency rules that govern it.
---
Website events are mirrored to the NCRP VRChat group calendar as a THIRD downstream
target beside Discord (website is the source of truth). Only eventType session/social
qualify (Main Sessions + social); missions are deliberately SKIPPED.

**Triple gate — all three must hold, and it is independent of the missions live flag:**
- kill-switch `bot_config.vrchat_calendar_sync_enabled` — must be a strict JSON
  boolean `true` (NOT the string "true"); default OFF. The admin toggle writes a
  real boolean. **Why:** the flag reader compares `value === true`, so a stringy
  "true" silently reads as disabled.
- deployment write-gate: `REPLIT_DEPLOYMENT=1 || ALLOW_EXTERNAL_WRITES=1`.
- VRChat creds present (username/password/TOTP).

**Gate-closed must be a true no-op.** When disabled, the CRUD apply path returns the
event unchanged BEFORE touching any vrchat* column, so a gated edit never clobbers a
previously stored vrchatCalendarId / vrchatSyncError / vrchatSyncedHash.

**Concurrent create race (the easy bug here).** Two independent paths mirror the same
row: the CRUD path (create/update/cancel) and the cron reconcile sweep. Both can read
vrchatCalendarId = null and each mint a NEW calendar id, leaking one orphaned VRChat
event. **How to apply:** persist a freshly-minted id with a guarded conditional update
(claim only WHERE the id column is still null); if the claim loses, delete the calendar
event you just created (compensating delete) and keep the winner's id — never blind
update-by-id on the create branch.

**Reconcile also tears down, not just backfills.** The sweep selects qualifying rows OR
any row still carrying a vrchatCalendarId, so rows cancelled or retyped away while sync
was off get their entry deleted and the id nulled once sync is re-enabled. It is bounded
per cycle to respect the rate limit.

**Never throws.** All sync errors are captured into events.vrchatSyncError (+ the shared
session lastError); the creation notification fires only on first create; past events
(endAt < now) are never backfilled.
