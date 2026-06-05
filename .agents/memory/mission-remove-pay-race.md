---
name: Mission roster-removal vs payout race
description: Why removeAssignedPlayer must re-check the paid/processing guard under a row lock.
---
Removing an accepted player from a mission (delete mission_assignments row +
flip application to withdrawn) must re-read the assignment with
`SELECT ... .for("update")` INSIDE the transaction and re-assert
paymentStatus not in (paid, processing) before deleting.

**Why:** payMissionPlayers claims a row via a conditional UPDATE (acquires the
row lock). A top-level check-then-act read can be overtaken by a concurrent
payout flipping the row to 'processing', so a pre-tx-only 409 guard lets a
delete race with money movement and orphan the payout.

**How to apply:** any roster mutation that competes with payout (remove,
reassign) must contend on the same assignment row lock. Invariant to test: a
player is never both paid AND removed (remove-vs-pay Promise.all test in
missions.test.ts).
