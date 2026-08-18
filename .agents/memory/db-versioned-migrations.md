---
name: Versioned DB migrations
description: Schema changes ship as generated drizzle migrations; how baseline resolution, deploy-time migrate, and the remaining push-force usage fit together.
---

Schema management moved from drizzle push to versioned migrations (Aug 2026).

- `lib/db/migrations/` holds generated SQL + journal; `pnpm --filter @workspace/db run generate` / `run migrate`. Never push dev/prod anymore.
- **Baseline resolution:** `pnpm --filter @workspace/scripts run db:baseline-migrations <ENV_VAR_NAME>` marks migrations applied WITHOUT executing SQL — inserts sha256(file text) + journal `when` into `drizzle.__drizzle_migrations` (matches drizzle-orm node-postgres migrator, which compares latest created_at vs journal `when`). Run against dev (`DATABASE_URL`) and live prod (`LIVE_PROD_DATABASE_URL`) for 0000_baseline.
- **Deploy migrate:** api-server boot (`src/lib/runMigrations.ts`, called in index.ts BEFORE dynamically importing ./app) applies pending migrations when `REPLIT_DEPLOYMENT=1` or `RUN_DB_MIGRATIONS=1`; pg_advisory_lock serializes autoscale instances; failure exits instead of serving. Migrations folder found by walking up from cwd — the SQL files must exist on the deploy filesystem (not bundled).
- post-merge runs `migrate` (not push) then `db:guards`.
- `push-force` survives ONLY for the api-server test harness's throwaway template DBs.
- **Why:** economy tables hold real balances; push had no history/rollback and silently skipped partial-index predicate changes.
- **How to apply:** any schema edit must commit a generated migration alongside it; review generated SQL for the deploy traps (space-containing literals in expression indexes; partial-index predicate changes need explicit DROP/CREATE; no `CREATE INDEX CONCURRENTLY` — migrator wraps everything in one transaction).
