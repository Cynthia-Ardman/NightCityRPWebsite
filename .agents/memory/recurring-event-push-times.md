---
name: Recurring event mirror pushes use next occurrence
description: Discord & VRChat reject past start times; recurring events with a rolled-past base start must push next-occurrence times.
---

Both mirrors 400 on past start times (Discord GUILD_SCHEDULED_EVENT_SCHEDULE_PAST; VRChat "Calendar Entry must start in the future"). A recurring event's stored base startAt goes stale once an occurrence begins (Discord rolls its copy forward; our row lags until the reconcile pull).

**Rule:** every outbound push of event times (Discord modify/create, VRChat calendar create/update, and the VRChat sweep's past-start skip check) must go through `withUpcomingOccurrenceTimes(event)` in eventsService.ts — it shifts startAt/endAt onto the next non-excluded occurrence (duration preserved) via the server-side expander `src/lib/eventRecurrence.ts` (port of the portal expander; keep in sync).

**Why:** live incident 2026-08 — recurring event pushed its past base time, both mirrors 400'd every cycle, errors surfaced to users.

**How to apply:** any NEW push path that reads event.startAt/endAt for an external write must use the shifted times. Synced hashes stay keyed on the STORED row (unshifted) so reconcile roll-forward semantics don't churn. Known gap: an exhausted series (count/until ended) returns unchanged past times, so pushes on it can still 400.
