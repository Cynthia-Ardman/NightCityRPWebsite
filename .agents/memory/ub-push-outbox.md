---
name: UB push outbox (mirror writes to UnbelievaBoat)
description: How wallet changes reach UnbelievaBoat — durable per-user-ordered idempotent ub_push_outbox with drain + cron; test/dev envs suppress pushes. How to test wallet paths.
---

# UB push outbox

The website wallet is authoritative; every `applyWalletDelta` enqueues a `ub_push_outbox` row (userId, discordId, amount, reason, ledgerId, status pending|inflight|pushed|suppressed, attempts, nextAttemptAt) **inside the same tx** as the balance/ledger write. A fire-and-forget drain (`kickUbPushDrain`) runs after each write and a 1-minute cron sweeps the rest.

Drain rules:
- Per-user FIFO by `id`: a user's rows push strictly in order; a failure backs off (`nextAttemptAt`, attempts++) and BLOCKS that user's later rows (never reorder — signs matter).
- `pushed` advances `lastSyncedUbBalance` by the amount so reconcile computes zero delta.
- Environments where external writes are disallowed (dev/tests: not REPLIT_DEPLOYMENT and no ALLOW_EXTERNAL_WRITES) mark rows `suppressed` and DON'T advance the baseline.

Testing wallet paths (the pattern used across the api-server suite):
- Never assert `patchBalance` mock calls for player money — assert `users.walletBalance` and `ub_push_outbox` rows (disambiguate by `reason` prefix or `amount`; rows may already be `suppressed` by the async drain — accept pending|suppressed, or poll).
- Fund a user by setting `walletBalance` (+ `lastSyncedUbBalance`) directly.
- Force a CREDIT failure via int4 overflow: set the target near `MAX_WALLET_BALANCE` (2_147_483_647) so the credit `exceeds_max`. Force a DEBIT failure by leaving the wallet empty (self-heal getBalance mocked null → insufficient).
- `applyWalletDelta` requires `discordId` and `reason` in its input; direct-call tests must pass them.

Ops: admin has GET /admin/wallet/mirror-health + POST /admin/wallet/mirror-push. Prod DDL for the table/indexes was applied manually to the live DB (drizzle push covers dev).
