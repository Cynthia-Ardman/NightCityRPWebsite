---
name: NCRP database targets
description: Three Postgres DBs are reachable from this workspace — which is which, and which one the live site actually uses.
---

This workspace can reach THREE distinct Postgres databases. Mixing them up has cost real time. Always confirm the host before any write.

- `DATABASE_URL` → **dev DB** (Replit-managed helium*). NOT connected to anything live. Local workflows (api-server, ncrp-portal:web) read this.
- `LIVE_PROD_DATABASE_URL` → **live prod DB** (Neon `ep-*.neon.tech`). This is what nightcityroleplay.com actually reads/writes. All "real" data lives here.
- `PROD_DATABASE_URL` → **legacy** NightCityBot DB (host `ep-cool-pine-*`). Read-only historical source. **STALE snapshot**: its `balance_history`/activity logs stop ~2026-05-27. Same lineage/ids as the newer copy below (ids 1..N match byte-for-byte) but truncated.
- `OLD_BOT_DATABASE_URL` → **newer copy of the same NightCityBot DB** (host `ep-cool-hat-*`), current through "today" (e.g. 2026-06-02). Same schema + same id lineage as `PROD_DATABASE_URL` but with the extra rows the stale snapshot is missing. **Prefer this over `PROD_DATABASE_URL` for any bot backfill/import.** Was shared by the user in plaintext chat (recommend rotating). Still starts 2026-05-01 — the bot only began line-item logging then; pre-2026 economy history was never stored as transactions anywhere.
- Bot mirror tables in the portal are the `bot_*` family (`bot_balance_history`, `bot_attendance_log`, `bot_business_open_log`, `bot_actor_attendance`, `bot_cyberware_status`, `bot_cyberware_weekly_runs`, etc.). `scripts/src/import-bot-activity.ts` does an **additive** (ON CONFLICT DO NOTHING) refresh of the activity-log mirrors from `OLD_BOT_DATABASE_URL`; linkage is per-player via `user_id` (Discord ID → portal `users.id`). `bot_cyberware_status` is a per-user STATE table — additive import only adds new users, it will NOT refresh existing weeks-counters (that needs an explicit DO UPDATE / `backfill-cyberware-status.ts`).

**Why:** earlier in the project all "import to prod" work landed in `DATABASE_URL` (dev) by accident because the env name `PROD_DATABASE_URL` made it sound like the live target. It is not.

**How to apply:**
- Any write that's supposed to hit the live site MUST use `LIVE_PROD_DATABASE_URL`.
- `scripts/sync-from-prod.ts` reads from `LIVE_PROD_DATABASE_URL` and overwrites dev — run it to make dev mirror prod for testing.
- `scripts/src/import-cyberware-inventory.ts` has an `assertTargetDbAllowed()` guard: refuses to run against a non-helium host unless `IMPORT_TARGET=prod` is also set. Apply the same guard pattern to any future destructive importer.
- Replit's standard "publish-time schema diff dev→prod" does NOT apply to this project — the live DB is on Neon, not Replit-managed. Schema/data changes for prod must be applied explicitly via a script pointed at `LIVE_PROD_DATABASE_URL`.
- For prod schema sync prefer a **scoped, additive, idempotent** DDL script (`CREATE TABLE/INDEX IF NOT EXISTS` for only the new tables, in a transaction) over `drizzle-kit push` — push diffs the WHOLE schema and would propose ALTER/DROP against tables that have drifted from manual prod work. Snapshot `information_schema.columns` before/after and fail closed. `executeSql` can't be used here (prod target is read-only in that tool).

**Live vs dev schema parity / full mirror (verified 2026-06-01):**
- The live (`LIVE_PROD_DATABASE_URL`) and dev (`DATABASE_URL`) **public schemas now match byte-for-byte** (60 app tables identical; live only additionally has `_system.replit_database_migrations_v1`). The `sync-from-prod.ts` comment claiming prod tracks inventory/wallet ownership by `user_id` while dev uses `character_id` is **STALE** — `inventory_items` is identical (has both `character_id` and `owner_id`) in both.
- For a TRUE one-to-one TEST-site copy use `scripts/mirror-live-to-dev.sh` (pnpm `mirror-from-live`): `pg_dump --schema=public` from live → DROP+recreate dev `public` → restore → force 6 `*_live_mode` flags OFF. pg_dump emits its own `CREATE SCHEMA public;` (sed-strip it since we pre-create). `--schema=public` deliberately skips `_system` so Replit's dev migration tracking is untouched. Live DB is tiny (~18 MB) so it's seconds.
- `sync-from-prod.ts` remains the *curated* 8-table dev seed; `mirror-from-live` is the *full* mirror for the community test site.

**Test-site URL (NOT a deployment):** the safe community TEST site is the FREE dev workspace URL = `https://$REPLIT_DEV_DOMAIN` (a `*.worf.replit.dev` host), only up while the workspace runs. It is NOT a `*.repl.app` / `*.replit.app` URL — those are published deployments (= live). Probed 2026-06-01: `nightcityinterface.repl.app` doesn't exist (TLS unrecognized name), `nightcityinterface.replit.app` 404s (no deployment), live site is `nightcityroleplay.com`.
