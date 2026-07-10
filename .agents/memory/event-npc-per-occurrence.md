---
name: Event NPC signups are per-occurrence
description: Recurring events expand client-side; NPC signups must be scoped to one occurrence via occurrence_start_at, with legacy NULL rows meaning "current startAt".
---

Recurring events are stored as ONE row with a recurrence rule; the portal expands occurrences client-side (`expandOccurrences`). Any per-user state on an event (NPC signups, and any future per-user flags) must therefore be scoped to a concrete occurrence, or the UI will badge every projected future occurrence.

**Design:**
- `event_npc_signups.occurrence_start_at` (nullable timestamptz); partial unique index on `(event_id, user_id, coalesce(occurrence_start_at,'epoch'))` WHERE state='signed_up'.
- Legacy NULL-occurrence rows semantically mean "the event's CURRENT startAt occurrence" everywhere (Discord rolls startAt forward), so they self-heal without backfill.
- Signup defaults occurrence to `event.startAt`; occurrence-scoped withdraw matches exact occurrence OR legacy-NULL rows; omitted occurrence = withdraw all (legacy client behavior).
- `EventView.mySignup` = current-occurrence signup only (detail page); `EventView.myOccurrences: string[]` = all active occurrence ISOs (calendar/home badging via `myOccurrenceSet(...).has(occ.getTime())` in `eventRecurrence.ts`).

**How to apply:** any new UI surface that badges "signed up" on an expanded occurrence must check `myOccurrences`, NOT `mySignup`; any new signup entry point must pass the occurrence ISO it is rendering.
