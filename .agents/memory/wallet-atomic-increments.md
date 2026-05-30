---
name: Wallet/venue balance atomic increments
description: Why money-balance writes must be relative SQL increments, not read-then-write absolute values.
---

# Wallet & venue balance writes must be atomic relative increments

Any code that updates `users.walletBalance`, `stores.balance`, or `ripperdocs.balance`
must write `SET balance = balance + <delta>` (drizzle `sql\`${col} + ${delta}\``),
NEVER read the balance, compute `prev + delta` in JS, and write that absolute value.

**Why:** the absolute read-then-write pattern loses updates under concurrent
requests for the same account — two deltas both read the same `prev` and the
later write clobbers the earlier one, which can mint or destroy money. UB itself
serializes its patches, but the website mirror write race is independent of UB.
A relative increment is correct regardless of write ordering.

**How to apply:** in `applyWalletDelta` (economy.ts) the finalize step increments
`walletBalance`; in `venueDepositWithdraw` (stores.ts) the venue leg increments
`balance`. `lastSyncedUbBalance` is set to `ub.total` best-effort — it can skew
under concurrency, but the reconciliation job corrects it.

**Concurrent withdraw guard:** the venue *debit* leg must be a guarded atomic
statement (`SET balance = balance - amt WHERE id = ? AND balance >= amt`) with a
returning/affected-rows check. Because the personal (UB) credit leg runs first,
a lost guard race must REVERSE that credit (a compensating `applyWalletDelta`
with `allowNegative` + a derived idempotency key) or the owner keeps minted
money. Plain atomic increment alone is NOT enough for the debited side.

**Known remaining gap (acceptable for the economy *foundation*):** venue
deposit/withdraw idempotency keys use `Date.now()`, so a client retry after a
network timeout is treated as a new op (no replay protection). Real idempotent
retry needs a client-supplied key. Only the venue owner can move venue money, so
concurrent same-venue ops are rare in practice.
