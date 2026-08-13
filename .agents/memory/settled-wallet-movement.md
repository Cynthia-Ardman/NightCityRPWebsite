---
name: Settled wallet movement (RETIRED pattern) + informational backfill rows
description: recordSettledWalletMovement is retired — all wallet paths now use applyWalletDelta. Kept for the safe informational-backfill recipe and the unseeded-baseline edge case.
---

# RETIRED: direct-UB + settled-ledger pattern

Historically mission/actor payouts called UB `patchBalance` directly and then wrote a "settled" ledger row (`recordSettledWalletMovement`). That pattern is **gone**: the website wallet is now authoritative and every wallet path (including mission pay, `gate:"none"`) routes through `applyWalletDelta`, which writes balance + ledger + `ub_push_outbox` enqueue in one tx. Do NOT reintroduce direct `patchBalance` calls for player wallets (bank moves excepted).

Still-relevant lessons:

**Unseeded baseline edge case:** when `lastSyncedUbBalance IS NULL`, never set it as a side effect of a payment path — the first reconcile's seed branch sets the full UB total; seeding early permanently strands the pre-existing UB balance.

**Informational history backfill (prod one-offs):** to retroactively surface old payouts, insert purely informational `wallet_transactions` rows (`syncStatus:"synced"`, same idempotency key as the live path, `createdAt = paid_at`) and leave `previousBalance`/`newBalance`, `walletBalance`, and `lastSyncedUbBalance` untouched. Safe because the authoritative balance is the `users.walletBalance` COLUMN, not a SUM of ledger rows. Use an `--apply`-gated tsx script against `LIVE_PROD_DATABASE_URL` with `ON CONFLICT (idempotency_key) DO NOTHING`.

**Admin discoverability:** mission payout audit rows are `category:"mission"`; the Admin Audit Log has mission + Payouts sub-tabs filtering the payout actions.
