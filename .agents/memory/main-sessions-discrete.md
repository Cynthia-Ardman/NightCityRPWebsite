---
name: Main Sessions are discrete weekly rows, not a recurrence
description: Why the calendar runs out of Main Sessions and how to extend coverage.
---

Main Sessions (`events.event_type === "session"`, titled `NCRP Main Event: Session NN`)
run every Sunday but are stored as ONE event row per week — each with its own
`discord_event_id` — NOT as a single row with `recurrence_rule`. So the calendar
only shows sessions as far out as rows physically exist.

**Why:** They mirror real per-week Discord scheduled events (each week is a
distinct Discord event), so a recurrence rule would not map cleanly to Discord
sync. Other recurring events DO use `recurrence_rule`; sessions are the exception.

**How to apply:** To extend Main Session coverage, create more rows — don't reach
for recurrence. Core logic is `backfillMainSessions({horizonDays,dryRun})` in
`eventsService.ts`: clones the latest non-cancelled session forward (one week +
incrementing the trailing number) to a 90-day horizon via `createEvent()` so the
Discord push stays gated on the live flag. Idempotent (dedups by UTC day key,
no-ops once coverage reaches the horizon), with a maxIterations hard cap. Keep
start at 21:00 UTC (=2pm Pacific, DST-stable by adding fixed 7-day deltas to the
UTC anchor). Two callers share it: the manual script
`scripts/backfill-main-sessions.ts` (DRY_RUN / HORIZON_DAYS env) and the
`main_session_backfill` cron.

**Automated:** `main_session_backfill` job (jobs.ts) runs daily at **06:37 UTC**.
It is intentionally NOT in `liveSystemByJob` (website rows must be created in Test
mode too, like discord_event_sync) and has NO bot_config kill switch (it creates
calendar rows, not money). The 06:37 (off the */10 boundary) is deliberate: it
must never coincide with a `discord_event_sync` tick, because a new row's
`createEvent`→Discord-push briefly exists before its `discord_event_id` is linked,
and a concurrent reconcile importer could re-import that just-pushed Discord event
as a DUPLICATE row. (This create-vs-reconcile race is pre-existing for ALL
event-creation paths, not unique to backfill; de-conflicting the schedule just
avoids widening it.)

## Imported sessions land as "social" — promote by title

When the SAME Discord scheduled event is seen from the Discord side FIRST (e.g. a
fresh deploy whose DB imported the schedule from Discord instead of authoring it),
the import path defaults `event_type` to `"social"` — it has no signal that the row
is the headline weekly game. That silently drops NPC sign-up (`eventNeedsNpcs`
derives off `"session"`), and it recurs every week as each new Sunday imports.

**Why:** `event_type` is website-authoritative — Discord has no session/social
concept, so the reconcile NEVER pulls it down and it is NOT part of
`eventContentHash` (title/desc/location/start/end only). Dev had these as
`"session"` only because they were *created* on-site via `createEvent`; prod
*imported* them → `"social"`.

**How to apply:** Classify by title. `isMainSessionTitle()` (regex
`/main event\b.*\bsession\b/i`) + `classifyImportedEventType()` in `eventsService.ts`
set the import default, AND a promote-only self-heal in the reconcile linked-row
loop flips existing `social`→`session` for Main-Session-titled rows. Because
`event_type` isn't in the content hash, update it independently (like the
recurrence backfill) — it never triggers a spurious Discord push. The
`discord_event_sync` cron (every 10 min, website-writes always run) makes prod
self-correct after deploy with no manual re-typing or direct prod DB write.


## Former index detail (full)
one event row per Sunday (own discord id), NOT recurrence_rule; extend via backfill-main-sessions.ts. Discord-IMPORTED sessions default event_type='social' (drops NPC signup) → classify by title + promote-only self-heal in reconcile.
