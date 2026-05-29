---
name: api-server test harness
description: How the api-server vitest integration tests are wired and how to run them reliably.
---

# api-server vitest integration harness

Backend tests run against a **separate** `*_test` Postgres DB (derived from DATABASE_URL in `src/test/testDbUrl.ts`), schema provisioned once in `globalSetup.ts` via `pnpm --filter @workspace/db run push-force`, and reset per-test with `TRUNCATE ... RESTART IDENTITY CASCADE`. `vitest.config.ts` sets `fileParallelism: false` and blanks external-service tokens for safety.

Auth in tests: `buildTestApp()` (`src/test/app.ts`) swaps only session loading for an `x-test-user` header that hydrates `req.user`; the REAL `requireAuth`/`requireRole`/`requireAnyRole` still run, so role gating is genuinely exercised. Seed via `createUser/createAdmin/createCharacter` (`src/test/testDb.ts`).

**Running:**
- Per-file is fast and reliable: `pnpm --filter @workspace/api-server exec vitest run <file>`.
- The FULL suite (`pnpm --filter @workspace/api-server run test`) can exceed a 120s shell-tool limit because every file forks fresh (re-transform/import) plus the one-time schema push. Run it with an internal `timeout` redirecting to a file, then grep the file — don't rely on streamed stdout.
- **Do NOT pass `--reporter=basic`** — the custom reporter fails to load (ERR_LOAD_URL) in this Vite/Vitest setup. Use the default reporter.
- **Full/aggregate runs are flaky** (`pnpm -r --if-present run test` or the bare api-server `test` with no file arg): the run can die *silently right after* `push-force` ("Changes applied" is the last line, no test output, process gone) — not OOM. The CI-style validation harness uses `pnpm -r run test`, so it intermittently reports the *whole* `directory-guns` file as failing with 401 (auth) / empty GET / 500 — the signature of tests hitting a test DB whose schema/seed was lost mid-run, NOT a code defect. Reproduce/verify per-file instead; the same files pass 13/13 reliably in isolation. If validation fails this way but per-file passes + typecheck is clean, it's the harness, not your change.

**Why:** locks side-effect contracts (ledger rows, audit rows, cascade deletes, 502-with-no-write on provider failure) that unit tests alone can't catch; currency provider (`../lib/unbelievaboat`) is `vi.mock`ed so no test hits the real API.
