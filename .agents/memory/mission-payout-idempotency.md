---
name: Mission payout idempotency
description: How mission player/actor payouts avoid double external payment under concurrency
---

Mission payouts call UnbelievaBoat (external, irreversible). Manual pay + auto-pay cron
(every 15 min) + overlapping cron ticks can race, so every payout path MUST acquire a
durable uniqueness guard BEFORE the external call, never after.

**Player pay (mission_assignments):** payment_status is free TEXT (not a pg enum), so use
a transient `'processing'` sentinel. Atomically claim each row with a conditional UPDATE
(`SET status='processing' WHERE id=? AND status IN ('unpaid','failed','simulated')
RETURNING id`); only the winner proceeds. Then set final status (paid/simulated/failed).

**Actor pay (mission_actor_payments):** there is a PARTIAL unique index on (mission,actor)
WHERE payment_status='paid'. Reserve the slot first by inserting a `'paid'` row with
`.onConflictDoNothing().returning()`; empty result = lost the race, skip. Then call UB; on
failure UPDATE the reserved row to `'failed'` (which releases the slot for retry).

**Why:** calling UB before the guard means two workers both pay, then one DB write loses —
real double payout with only one record. Under-pay (crash after reserve, before UB) is
recoverable by an admin; double-pay is not.

**Cron idempotency:** runMissionAutoPay selects missions where autoPayProcessedAt IS NULL,
but that alone does NOT prevent overlap — the row-level guards above are what make it safe.
