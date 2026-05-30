---
name: Request review approve/reject race
description: Both approve AND reject of a reviewable request must lock the row and re-check status, or one clobbers the other.
---

When a request/submission has both an approve path (with side effects) and a
reject path, the reject path must NOT be a plain `select status === 'pending'`
then unconditional `update by id`. Concurrent approve+reject can interleave:
reject reads stale `pending`, approve commits its side effect + sets `approved`,
then reject's update overwrites to `rejected` while the effect is already applied.

**Rule:** put reject in the same `db.transaction` + `SELECT ... FOR UPDATE` +
pending-status guard pattern as approve. Return 409 if the locked row is no
longer pending.

**Why:** approve in custom_requests does FOR UPDATE and materializes
housing/inventory before flipping status; an unlocked reject silently broke the
invariant that status reflects whether the effect was applied.

**How to apply:** any time you add a second mutating transition for the same
row's status field, mirror the locking the first transition uses — don't assume
"reject applies nothing" means it can skip the lock.
