---
name: Account merge wallet transfer retry
description: Why the account-merge eddies transfer must derive its amount from the existing debit ledger row, not the live balance.
---

The admin "Merge accounts" tool (POST /admin/maintenance/merge-account) folds a DROP
user into a KEEP user: repoint all user-id refs (Phase A), transfer eddies on
UnbelievaBoat via two applyWalletDelta calls (Phase B), then delete the drop users
row (Phase C, cascade).

**Rule:** Phase B must NOT gate on the *current* drop wallet balance. Look up the
existing debit ledger row by its stable idempotency key
(`account-merge:<drop>-><keep>:out`) and use `abs(that row.amount)` as the
authoritative planned amount; only fall back to `drop.walletBalance` when no debit
row exists yet.

**Why:** If a run debits drop (balance now 0) but the credit to keep fails, a naive
rerun recomputes the amount from `drop.walletBalance` (= 0), skips Phase B entirely,
and proceeds to delete drop — the eddies are stranded/lost. applyWalletDelta is
idempotent per key (synced→duplicate, failed→retried, pending→abort), so re-driving
both legs with the planned amount safely completes the credit without double-debiting.

**How to apply:** Any multi-leg money move guarded by "only run if amount > 0" where
the source balance mutates between legs has this trap. Derive the plan from a durable
record (the first leg's ledger row), never from the live balance, and abort (never
delete/finalize) unless every leg returns ok+synced/duplicate.
