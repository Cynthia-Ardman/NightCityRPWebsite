// Runs FIRST (before ./setup.ts) and, crucially, before any module imports
// @workspace/db. The db/pool singleton reads DATABASE_URL at import time, so we
// must rewrite DATABASE_URL to point at THIS worker's dedicated database before
// that import happens. Each vitest worker (VITEST_POOL_ID) gets its own database
// — provisioned in globalSetup — so test files can run in parallel without
// sharing a database or clobbering each other via the per-test TRUNCATE.
//
// Keep this file free of any @workspace/* imports that transitively load the db
// singleton, or the rewrite would come too late.
import { workerDatabaseUrl } from "./testDbUrl";

const base = process.env.DATABASE_URL;
if (base) {
  const poolId = process.env.VITEST_POOL_ID ?? "1";
  process.env.DATABASE_URL = workerDatabaseUrl(base, poolId);
}
