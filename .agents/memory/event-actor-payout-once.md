---
name: Event actor payout pay-once
description: How non-mission EVENT actor payouts enforce pay-once, separate from mission payouts
---

`mission_actor_payments` is reused for BOTH mission actor pay AND non-mission EVENT
payouts (missionId null). Event payouts now also carry `eventId`.

**Rule:** pay-once for events is per (event, user, OCCURRENCE), via TWO partial unique
indexes (occurrence_start_at is nullable, so one index can't cover both):
- `mission_actor_event_paid_unique_idx` (event_id,user_id) WHERE paid AND event_id NOT NULL AND occurrence_start_at IS NULL (legacy rows)
- `mission_actor_event_occ_paid_unique_idx` (event_id,user_id,occurrence_start_at) WHERE paid AND event_id NOT NULL AND occurrence_start_at IS NOT NULL

`payStandaloneActors` resolves the occurrence for event-bound payouts (recurring event →
input.occurrenceStartAt ?? event.startAt; non-recurring → null) and picks the matching
`onConflictDoNothing` target. The legacy standalone path (eventId null, e.g. ad-hoc Pay
Actors page) stays UNGUARDED by design (same actor legitimately plays many sessions).

**Why:** a recurring social (e.g. daily Haywood Social) must let the SAME NPC be paid on
every occurrence but never twice for one occurrence; a no-show left unchecked must
stay payable later. A single (event,user) guard blocked next week's payout — legacy
NULL paid rows only dedupe against other NULL rows (harmless, no backfill needed).

**How to apply:** event-bound payouts pass `eventId` through route→service; `getEventDetail`
returns `paidActorUserIds` (manager-only) so the EventDetail roster locks paid NPCs and only
submits checked+unpaid ids. Skipped (already-paid) inserts increment `result.skipped`.
Reservation is paid-row-before-UB then flip-to-failed (same pattern as the rest of the file);
a failed payout leaves no 'paid' row so it remains retryable.
