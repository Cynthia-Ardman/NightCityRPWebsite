import { execSync } from "node:child_process";
import pg from "pg";
import { testDatabaseUrl, uniqueTestDatabaseUrl } from "./testDbUrl";

// How old (ms) an orphaned test database must be before the sweep will drop it.
// Generous so it can never touch a slow-but-live concurrent run (a full suite
// takes a few minutes); orphans only ever come from runs killed before their
// teardown could drop the database.
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Runs once before the whole test run: provisions a dedicated, throwaway test
// database unique to this vitest invocation, then pushes the current Drizzle
// schema into it. Tests connect to this database (via DATABASE_URL overridden
// in vitest.config.ts) and truncate tables between cases — they never touch the
// real dev/prod data, and two concurrent runs never share a database. The
// returned function drops the database when the run finishes.
export default async function setup(): Promise<() => Promise<void>> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL must be set to run the API test suite");

  // Prefer the URL chosen by vitest.config.ts so config, workers, and this
  // setup all agree on the same database. Fall back to deriving our own unique
  // name if it wasn't provided (e.g. globalSetup invoked in isolation).
  const testUrl =
    process.env.TEST_DATABASE_URL ??
    uniqueTestDatabaseUrl(`${process.pid.toString(36)}_${Date.now().toString(36)}`);
  const dbName = new URL(testUrl).pathname.replace(/^\//, "");

  // Create a fresh database for this run (connect to the real DB only to issue
  // CREATE/DROP DATABASE — no schema/data is touched there). The name is unique
  // per invocation, but DROP-then-CREATE guards against a leftover from a run
  // that was killed before teardown.
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await sweepOrphanedTestDbs(admin, dbName);
    await dropDatabase(admin, dbName);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  // Push the current schema into the throwaway database.
  execSync("pnpm --filter @workspace/db run push-force", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testUrl },
  });

  // Teardown: drop the throwaway database so they don't accumulate.
  return async () => {
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await dropDatabase(cleanup, dbName);
    } finally {
      await cleanup.end();
    }
  };
}

// Drops leftover per-invocation test databases from runs that were killed
// before their teardown ran (e.g. when the `test` validation workflow is
// restarted mid-run). A database is only dropped if it is BOTH older than
// ORPHAN_MAX_AGE_MS (its creation timestamp is encoded in the name) AND has no
// active connections — so a live concurrent run can never be swept, even during
// the brief moment between test files when it holds no connections.
async function sweepOrphanedTestDbs(client: pg.Client, currentDbName: string): Promise<void> {
  const base = new URL(testDatabaseUrl()).pathname.replace(/^\//, ""); // e.g. "heliumdb_test"
  const { rows } = await client.query<{ datname: string; conns: string }>(
    `SELECT d.datname,
            (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname) AS conns
       FROM pg_database d
      WHERE d.datname LIKE $1`,
    [`${base}\\_%`],
  );

  const now = Date.now();
  for (const { datname, conns } of rows) {
    if (datname === currentDbName) continue;
    if (Number(conns) > 0) continue;
    const ts = parseTimestampFromName(datname, base);
    if (ts === null || now - ts < ORPHAN_MAX_AGE_MS) continue;
    try {
      await dropDatabase(client, datname);
    } catch {
      // Best-effort: ignore (e.g. a concurrent run grabbed it first).
    }
  }
}

// Extracts the base36 creation timestamp encoded as the final `_<time>` segment
// of a per-invocation test database name (see vitest.config.ts token format).
// Returns null if the name doesn't match the expected shape.
function parseTimestampFromName(datname: string, base: string): number | null {
  const suffix = datname.slice(base.length + 1); // strip "<base>_"
  const last = suffix.split("_").pop();
  if (!last) return null;
  const ms = parseInt(last, 36);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// Drops a database, first terminating any lingering connections so the DROP
// can't fail with "database is being accessed by other users".
async function dropDatabase(client: pg.Client, dbName: string): Promise<void> {
  await client.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName],
  );
  await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
}
