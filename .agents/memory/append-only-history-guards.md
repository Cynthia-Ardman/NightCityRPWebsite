---
name: Append-only history guards
description: DB-level triggers make the imported legacy history tables immutable; which tables are locked, which are deliberately not, and how the guard re-applies.
---

# Append-only history guards

DB-level immutability is enforced by `lib/db/sql/immutable_history.sql` — a
plpgsql function `ncrp_block_history_mutation()` that RAISEs (errcode 23001) on
UPDATE/DELETE/TRUNCATE, installed as `trg_ncrp_block_mutation` (BEFORE UPDATE OR
DELETE, row-level) + `trg_ncrp_block_truncate` (BEFORE TRUNCATE, statement-level)
on each locked table. INSERT stays open, so importers (which all use
`ON CONFLICT DO NOTHING`) can still append new rows.

Locked (immutable, INSERT-only): `bot_rent_payment_events`, `bot_balance_history`,
`bot_actor_attendance`, `bot_attendance_log`, `audit_log`, `activity_events`.

**Why these:** they are append-only by construction (grep finds zero `update()`/
`delete()` code paths) and have no inbound FK cascades (their actor/user columns
are plain text, not FK references), so a hard lock is pure upside and cannot break
character-delete/merge cascades.

**Deliberately NOT locked: `wallet_transactions`.** It is the live going-forward
ledger with a legitimate row lifecycle — reserve→sync, character-merge re-pointing
of `character_id`, and reservation ROLLBACK deletes. Critically, the autobill path
`jobs.ts chargePersonalFeeWithReservation` INSERTs a row that defaults to
`sync_status='synced'` and then DELETEs it if the UnbelievaBoat charge fails, so
`'synced'` is NOT a safe "permanent" signal — a status-based delete-block trigger
would break the rollback. Confirmed rows are protected by convention (only failed
reservations are deleted) plus the unique idempotency index `wt_idem_idx`.

**How to apply:** `pnpm --filter @workspace/scripts run db:guards` (runner
`scripts/src/apply-db-guards.ts`) — idempotent, and it FAILS if any expected table
that exists is missing either trigger. Wired into `scripts/post-merge.sh` AFTER
`pnpm --filter db push` so every merge/deploy re-asserts it. Drizzle `push` does
not manage triggers, so it leaves them intact. For prod, run the same script
against the live DATABASE_URL (not auto-applied to the deployed DB by push alone).

**Going-forward capture:** new rent/meds/etc. are written by the api-server
node-cron jobs (`jobs.ts`: monthly_rent 1st@04:00 UTC, cyberware_humanity
Mon@05:00 UTC, economy_reconcile every 30m) into `wallet_transactions`; the
dashboard merges legacy `bot_*` tables + `wallet_transactions` into one history.
