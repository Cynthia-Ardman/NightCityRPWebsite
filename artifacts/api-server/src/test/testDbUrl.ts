// Derives test-database URLs from DATABASE_URL. Kept dependency-free so it can
// be imported from both vitest.config.ts and globalSetup without pulling in the
// app/db singletons.

// The shared base test database name: the real database name with a `_test`
// suffix. Used as the stem for per-invocation databases below.
export function testDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required to derive the test database URL");
  const u = new URL(raw);
  const name = u.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) u.pathname = `/${name}_test`;
  return u.toString();
}

// Derives a unique, throwaway test-database URL for a single vitest invocation
// by appending a caller-supplied token to the base `_test` name. Giving every
// run its own database means two concurrent runs (e.g. a manual run while the
// `test` validation workflow is also running) can never TRUNCATE each other's
// data mid-flight. Postgres database names are capped at 63 bytes, so the token
// is kept short.
export function uniqueTestDatabaseUrl(token: string): string {
  const u = new URL(testDatabaseUrl());
  const name = u.pathname.replace(/^\//, "");
  const safeToken = token.replace(/[^a-z0-9_]/gi, "").toLowerCase();
  u.pathname = `/${name}_${safeToken}`;
  return u.toString();
}

// Derives a per-worker database URL from this invocation's base (template) URL
// by appending the vitest worker id (VITEST_POOL_ID). Each forked worker gets
// its own database so files can run in parallel without sharing a database or
// clobbering each other via the per-test TRUNCATE. The db is dependency-free so
// this can run in a setup file *before* the @workspace/db singleton is imported.
export function workerDatabaseUrl(baseUrl: string, poolId: string | number): string {
  const u = new URL(baseUrl);
  const name = u.pathname.replace(/^\//, "");
  const id = String(poolId).replace(/[^0-9]/g, "") || "1";
  u.pathname = `/${name}_w${id}`;
  return u.toString();
}
