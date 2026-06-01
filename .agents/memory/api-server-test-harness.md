---
name: api-server test harness
description: How the api-server vitest integration tests are wired and how to run them reliably.
---

# api-server vitest integration harness

Backend tests run against a **separate** `*_test` Postgres DB (derived from DATABASE_URL in `src/test/testDbUrl.ts`), reset per-test with `TRUNCATE ... RESTART IDENTITY CASCADE`. `vitest.config.ts` blanks external-service tokens for safety.

**Parallelism (files run in parallel):** `globalSetup.ts` provisions a per-invocation *template* DB (`<base>_<pid36>_<time36>`), pushes the Drizzle schema into it ONCE (`push-force`), then clones it into one DB per vitest worker via `CREATE DATABASE <tpl>_w<n> TEMPLATE <tpl>` (instant copy). `vitest.config.ts` pins `pool:"forks"` + `min/maxWorkers = VITEST_WORKER_COUNT` (= capped CPU count, ≤4) so `VITEST_POOL_ID` is 1-indexed and contiguous up to that count; the count is passed to globalSetup via `process.env.VITEST_WORKER_COUNT`. Each worker rewrites `DATABASE_URL` to its own `_w<poolId>` clone in `src/test/workerDbEnv.ts` — listed FIRST in `setupFiles`, BEFORE `setup.ts`, and importing NO `@workspace/*` (the `@workspace/db` pool singleton reads DATABASE_URL at import, so the rewrite must precede it). Teardown drops every `_w<n>` clone + template; killed runs (SIGTERM/SIGKILL skip teardown) orphan DBs that the 1-hour `sweepOrphanedTestDbs` cleans (its `parseTimestampFromName` strips a trailing `_w<n>` so a live concurrent run's clones stay protected by their real timestamp during connection-free windows). Vitest 4 removed `poolOptions`; use top-level `maxWorkers`/`minWorkers`. Wall time ~265s serial → ~173s with 4 workers (long-tail files like jobs-autobill/missions dominate). Pre-existing bare `heliumdb_test` (no `_<token>`) is untouched by the harness.

Auth in tests: `buildTestApp()` (`src/test/app.ts`) swaps only session loading for an `x-test-user` header that hydrates `req.user`; the REAL `requireAuth`/`requireRole`/`requireAnyRole` still run, so role gating is genuinely exercised. Seed via `createUser/createAdmin/createCharacter` (`src/test/testDb.ts`).

**Running:**
- Per-file is fast and reliable: `pnpm --filter @workspace/api-server exec vitest run <file>`.
- The FULL suite (~173s) still exceeds a 120s shell-tool limit. Run it with an internal `timeout` redirecting to a file, then grep the file — don't rely on streamed stdout.
- **Do NOT pass `--reporter=basic`** — the custom reporter fails to load (ERR_LOAD_URL) in this Vite/Vitest setup. Use the default reporter.
- The full suite (`pnpm --filter @workspace/api-server run test`) now runs files in parallel and passes 25/25 (422 tests) in ~173s; safe to run as a whole.
- **Historical (now fixed) aggregate-run flake:** before per-worker DBs, parallel/overlapping `pnpm -r run test` runs shared ONE test DB, so one run's per-test TRUNCATE wiped another's seed/schema mid-flight — surfacing as `directory-guns` 401/empty-GET/500, or `missions.test.ts` `Cannot read properties of undefined (reading 'paymentStatus')` + `Failed query: insert into "mission_actor_payments"`. These were harness artifacts, NOT code defects, and the per-worker template-clone DBs (see Parallelism above) eliminate them. If you see this signature again, suspect the worker-DB isolation (a leaked `@workspace/db` import before workerDbEnv.ts, or pool ids exceeding the provisioned clone count), not the route code.

**Why:** locks side-effect contracts (ledger rows, audit rows, cascade deletes, 502-with-no-write on provider failure) that unit tests alone can't catch; currency provider (`../lib/unbelievaboat`) is `vi.mock`ed so no test hits the real API.
