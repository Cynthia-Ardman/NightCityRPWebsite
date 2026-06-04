---
name: Event actor payout pay-once
description: How non-mission EVENT actor payouts enforce pay-once, separate from mission payouts
---

`mission_actor_payments` is reused for BOTH mission actor pay AND non-mission EVENT
payouts (missionId null). Event payouts now also carry `eventId`.

**Rule:** pay-once for events is a SEPARATE partial unique index
`mission_actor_event_paid_unique_idx` on `(event_id, user_id) WHERE payment_status='paid' AND event_id IS NOT NULL` — distinct from the mission index `mission_actor_paid_unique_idx` on (mission_id,user_id). `payStandaloneActors` only applies `onConflictDoNothing` (target+`where:` matching that predicate) when `eventId != null`; the legacy standalone path (eventId null, e.g. ad-hoc Pay Actors page) stays UNGUARDED by design (same actor legitimately plays many sessions).

**Why:** an NPC must be payable exactly once per event; a no-show left unchecked must
stay payable later, and an already-paid NPC must be locked. The shared table + shared
service meant the obvious single guard would have wrongly blocked legitimate repeat ad-hoc payouts.

**How to apply:** event-bound payouts pass `eventId` through route→service; `getEventDetail`
returns `paidActorUserIds` (manager-only) so the EventDetail roster locks paid NPCs and only
submits checked+unpaid ids. Skipped (already-paid) inserts increment `result.skipped`.
Reservation is paid-row-before-UB then flip-to-failed (same pattern as the rest of the file);
a failed payout leaves no 'paid' row so it remains retryable.
