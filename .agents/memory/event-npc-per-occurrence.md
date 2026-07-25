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
- For RECURRING events, `toView` also scopes the manager roster (`signups`) and `signupCount` to the current occurrence (legacy NULL = current), and `getEventDetail.paidActorUserIds` only locks actors paid for the current occurrence (payments carry `occurrence_start_at`; pay-once is per occurrence — see event-actor-payout-once.md).
- Recurring startAt changes route through `handleRecurringNpcSignupsOnStartChange` (wired into staff PATCH + reconcile pull): delta <12h = time correction (restamp old/NULL active rows to new instant, withdraw collisions); ≥12h = roll-forward (pin legacy NULL rows to the OLD startAt so they do NOT follow the event to the next occurrence). Threshold is 12h, not 24h — a daily social crossing a DST boundary rolls forward only ~23h.

**NON-recurring events (no recurrenceRule) are exempt from per-occurrence scoping.** A single event's start-time edit used to orphan sign-ups (row stayed on the old instant → UI showed "not signed up" → duplicate row; the "Tony signed up twice" prod bug). Rules:
- Every startAt write path on a non-recurring event (staff PATCH, Discord reconcile pull) must call `restampNpcSignupsForStartChange` — re-stamps the oldest active row per user to the new start (NOT EXISTS collision guard), then withdraws every other active row `IS DISTINCT FROM` the new start (incl. legacy NULL dups).
- Signup pins occurrence to `event.startAt` (ignores client value) and self-heals stale rows before insert; withdraw ignores the occurrence filter; toView matches ANY active row as mySignup.

**Occurrence deep links:** GET /events/:id accepts optional `?occurrenceStartAt=ISO` (400 on invalid); for recurring events toView shifts startAt/endAt by the occurrence delta and scopes mySignup/roster/signupCount/paidActorUserIds to that occurrence (legacy NULL rows count only when occurrence == current startAt). Portal occurrence-expanded chips (DirectoryCalendar, Home lists + NPC session banner) link `/events/:id?occ=<ISO>` for recurring events; EventDetail reads `occ` via useSearch and passes params into useGetEvent with a params-varied query key (invalidations by bare `getGetEventQueryKey(id)` prefix-match all params variants). Signup/withdraw keep passing `data.startAt`, which is now the occurrence-shifted value. Links to base rows (FixerEvents table, AdminDashboard, MissionDetail) stay bare.

**How to apply:** any new UI surface that badges "signed up" on an expanded occurrence must check `myOccurrences`, NOT `mySignup`; any new signup entry point must pass the occurrence ISO it is rendering; any NEW code path that writes `events.startAt` must route through the re-stamp helper for non-recurring events.
