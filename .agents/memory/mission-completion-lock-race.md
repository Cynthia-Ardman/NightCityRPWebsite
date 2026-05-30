---
name: Mission completion lock & payout TOCTOU
description: Why a mutable read-only lock (mission completion) must be re-checked atomically inside the paid-row reservation, not via a top-level check-then-act read.
---

# Completion lock vs. actor payout — atomic reservation

A "read-only" gate that can flip concurrently (e.g. missions.completedAt locking
actor payments) CANNOT be enforced with a top-of-function `select mission; if
completedAt return blocked;` followed later by the reservation + external payout.
That is check-then-act: a concurrent `setMissionCompleted` can commit between the
read and the reservation, and money still moves.

**Rule:** gate the *paid-row reservation itself* on the live gate, atomically, in
one statement:
`INSERT INTO mission_actor_payments (...) SELECT <constants> WHERE EXISTS (SELECT 1
FROM missions WHERE id=? AND completed_at IS NULL) ON CONFLICT DO NOTHING RETURNING id`.
Zero rows back ⇒ either already-paid (partial unique idx) or completed mid-flight ⇒
skip; both mean "no payout, no money moved". Keep the top-level check too as a fast
path / 409 source, but it is NOT the safety boundary.

**Why:** the INSERT...SELECT re-reads completed_at at statement-execution time
under READ COMMITTED, so any completion committed before it is honored — closing
the race — while the external UnbelievaBoat call still runs AFTER the reservation,
outside any lock (never hold a row lock across the network call).

**How to apply:** any future live payout path that touches an external money API
and is guarded by a mutable flag must use this reservation-with-EXISTS-guard
pattern, not a separate pre-read. Pairs with the existing reserve-before-external
idempotency rule (see mission-payout-idempotency.md).
