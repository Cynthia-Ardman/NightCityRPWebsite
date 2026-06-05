---
name: Wallet int4 ceiling
description: Wallet/account balances are int4; where the overflow guard lives and which paths remain unguarded.
---

Wallet and account balances are stored as Postgres `integer` (int4), max
**2,147,483,647**: `users.wallet_balance`, `stores.balance`, `ripperdocs.balance`,
plus `wallet_transactions.previous_balance/new_balance`. There is no 2-million cap
anywhere — the only ceiling is the column type.

**The guard:** `applyWalletDelta` (lib/economy.ts) is the single entry point for
website-originated wallet credits. It rejects `amount > 0 && proposed >
MAX_WALLET_BALANCE` (= 2,147,483,647) with `{ ok:false, status:"exceeds_max" }`
*before* the mode branch, the UB call, and any DB write. Sibling to its existing
overdraw (negative) guard. `stores.ts` maps `exceeds_max` to 400; other credit
callers (saleOffers, breach) inherit it through their generic `!ok` branches.

**Why:** before the guard, a large credit would overflow int4 and throw at write
time (a 500) instead of failing cleanly.

**Still-open overflow vectors (intentionally not guarded):**
- `runEconomyReconcile` / `reconcileOneUser` mirror external UnbelievaBoat totals
  with absolute/relative writes — if UB ever exceeds int4 these can still throw.
- The pre-read check is not fully race-proof near the ceiling (no DB-level
  `WHERE wallet_balance <= max - delta`).
- Migrating the columns to `bigint` would remove the ceiling entirely.

**How to apply:** any NEW wallet-credit path should route through
`applyWalletDelta` to inherit the guard; don't write `users.wallet_balance`
directly. If you touch the reconcile paths, consider capping/rejecting
UB-derived writes above the int4 max there too.
