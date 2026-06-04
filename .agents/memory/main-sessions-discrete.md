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
for recurrence. `artifacts/api-server/src/scripts/backfill-main-sessions.ts` clones
the latest session forward (one week + incrementing the trailing number) up to a
90-day horizon, via `createEvent()` so Discord sync stays gated on the live flag.
It's idempotent (re-run = no-op once coverage reaches the horizon). Keep start at
21:00 UTC (=2pm Pacific, DST-stable by adding fixed 7-day deltas to the UTC anchor).
This is a manual run today; an automated cron to keep N weeks always populated is a
reasonable future improvement.
