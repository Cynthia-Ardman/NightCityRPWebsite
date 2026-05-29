import { execSync } from "node:child_process";
import pg from "pg";
import { testDatabaseUrl } from "./testDbUrl";

// Runs once before the whole test run: ensures the dedicated test database
// exists and the current Drizzle schema is pushed into it. Tests then connect
// to this database (via DATABASE_URL overridden in vitest.config.ts) and
// truncate tables between cases — they never touch the real dev/prod data.
export default async function setup(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL must be set to run the API test suite");

  const testUrl = testDatabaseUrl();
  const dbName = new URL(testUrl).pathname.replace(/^\//, "");

  // Create the test database if it doesn't exist yet (connect to the real DB
  // only to issue CREATE DATABASE — no schema/data is touched there).
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  // Push the current schema into the test database (idempotent).
  execSync("pnpm --filter @workspace/db run push-force", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testUrl },
  });
}
