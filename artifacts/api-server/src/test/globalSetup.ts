import { execSync } from "node:child_process";
import pg from "pg";
import { testDatabaseUrl, uniqueTestDatabaseUrl } from "./testDbUrl";

// How old (ms) an orphaned test database must be before the sweep will drop it.
// Generous so it can never touch a slow-but-live concurrent run (a full suite
// takes a few minutes); orphans only ever come from runs killed before their
// teardown could drop the database.
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Runs once before the whole test run. To let test files run in parallel, each
// vitest worker needs its OWN database (sharing one would let the per-test
// TRUNCATE in one worker wipe another worker's seed data mid-flight). So we:
//   1. Provision a throwaway *template* database unique to this invocation and
//      push the current Drizzle schema into it once.
//   2. Clone it (cheaply, via CREATE DATABASE ... TEMPLATE) into one database
//      per worker — `<template>_w1`, `<template>_w2`, ...  Each worker rewrites
//      DATABASE_URL to its own clone in src/test/workerDbEnv.ts.
// Tests truncate tables between cases and never touch real dev/prod data, and
// two concurrent invocations never share a database. The returned function
// drops every database this run created.
export default async function setup(): Promise<() => Promise<void>> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL must be set to run the API test suite");

  // Prefer the URL chosen by vitest.config.ts so config, workers, and this
  // setup all agree on the same database. Fall back to deriving our own unique
  // name if it wasn't provided (e.g. globalSetup invoked in isolation).
  const templateUrl =
    process.env.TEST_DATABASE_URL ??
    uniqueTestDatabaseUrl(`${process.pid.toString(36)}_${Date.now().toString(36)}`);
  const templateName = new URL(templateUrl).pathname.replace(/^\//, "");

  // How many per-worker clones to make — must cover every VITEST_POOL_ID the
  // run can hand out (pool ids are 1-indexed and contiguous up to the worker
  // count). vitest.config.ts pins forks min/max to this same number.
  const parsedWorkerCount = parseInt(process.env.VITEST_WORKER_COUNT ?? "1", 10);
  const workerCount = Number.isFinite(parsedWorkerCount) && parsedWorkerCount > 0 ? parsedWorkerCount : 1;
  const workerNames = Array.from({ length: workerCount }, (_, i) => `${templateName}_w${i + 1}`);

  // Create a fresh template database for this run (connect to the real DB only
  // to issue CREATE/DROP DATABASE — no schema/data is touched there). The name
  // is unique per invocation, but DROP-then-CREATE guards against a leftover
  // from a run that was killed before teardown.
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await sweepOrphanedTestDbs(admin, templateName);
    await dropDatabase(admin, templateName);
    await admin.query(`CREATE DATABASE "${templateName}"`);
  } finally {
    await admin.end();
  }

  // Push the current schema into the template database.
  execSync("pnpm --filter @workspace/db run push-force", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: templateUrl },
  });

  // Clone the fully-migrated template into one database per worker. CREATE
  // DATABASE ... TEMPLATE copies the schema instantly, so we only pay the
  // push-force cost once.
  const cloner = new pg.Client({ connectionString: adminUrl });
  await cloner.connect();
  try {
    for (const name of workerNames) {
      await dropDatabase(cloner, name);
      await createFromTemplate(cloner, name, templateName);
    }
  } finally {
    await cloner.end();
  }

  // Teardown: drop every database this run created so they don't accumulate.
  return async () => {
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      for (const name of workerNames) {
        await dropDatabase(cleanup, name);
      }
      await dropDatabase(cleanup, templateName);
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

// Extracts the base36 creation timestamp from a per-invocation test database
// name (see vitest.config.ts token format: `<base>_<pid36>_<time36>`). Per-worker
// clones append a `_w<n>` suffix (`<base>_<pid36>_<time36>_w<n>`); we strip that
// first so a live concurrent run's worker databases are still protected by their
// real (recent) timestamp during the brief windows they hold no connections.
// Returns null if the name doesn't match the expected shape.
function parseTimestampFromName(datname: string, base: string): number | null {
  const suffix = datname.slice(base.length + 1); // strip "<base>_"
  const parts = suffix.split("_");
  if (parts.length > 0 && /^w\d+$/.test(parts[parts.length - 1])) parts.pop(); // drop "_w<n>"
  const last = parts.pop();
  if (!last) return null;
  const ms = parseInt(last, 36);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// Clones a fully-migrated template database into `target` via CREATE DATABASE
// ... TEMPLATE (an instant schema copy). The source must have NO other
// connections: the push-force child that populated the template has exited, but
// its backend can linger briefly server-side (it isn't always reaped the
// instant the client process dies), which makes the clone fail with "source
// database is being accessed by other users". So we terminate any stragglers on
// the template and retry with backoff before each attempt.
async function createFromTemplate(
  client: pg.Client,
  target: string,
  template: string,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [template],
    );
    try {
      await client.query(`CREATE DATABASE "${target}" TEMPLATE "${template}"`);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastErr;
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
