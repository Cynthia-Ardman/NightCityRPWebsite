---
name: Event NPC lifecycle mirrors missions
description: How event NPC sign-ups gained the attended/no_show + per-person pay lifecycle, and the per-confirm-amount deviation from missions.
---
Events mirror the mission NPC lifecycle (signed_up|withdrawn|attended|no_show on event_npc_signups + payAmount/paymentStatus/paymentError/paidAt), but with one key deviation:

- **Per-confirm amount, not a fixed field.** Missions snapshot `mission.npcPayAmount`; events have NO fixed NPC pay amount, so `confirmEventNpcSignup` takes an `amount` per call (single FEE input on the staff roster). OpenAPI `ConfirmEventNpcSignupInput` allows amount>=0; the UI deliberately requires amount>0 before ATTENDED because attended is irreversible (pay-once dedup) and a default-0 click would silently lock an NPC at 0.

- **Payout reuses `payStandaloneActors`** (event-bound; dedups per (eventId,userId) via the PAID partial unique idx; gated on ctx.live). On the `skipped` result (already paid via another path) DO NOT write the new `amount` to payAmount — preserve the existing row's payAmount/paidAt, since this confirm disbursed nothing.

- **signupCount must stay active-only.** `loadSignupViews` now returns all non-withdrawn rows (so staff see history + players see their resolved status), so `toView` must compute `signupCount` from `state==='signed_up'` only — counting attended/no_show would inflate the calendar's "needs N NPCs" badge.

- audit category: there is no "event" AuditCategory; use "mission" with action `event.npc_attended` / `event.npc_no_show`.
