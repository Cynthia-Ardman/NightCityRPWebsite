/**
 * CI migration runner.
 *
 * Applies pending DB migrations and exits with code 0 on success, 1 on
 * failure.  Mirrors the advisory-lock logic in
 * artifacts/api-server/src/lib/runMigrations.ts but without the web-server
 * dependencies so it can run standalone (via `tsx`) in CI.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/src/ci-migrate.ts
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "@workspace/db";

// Same advisory-lock key as the api-server uses — concurrent boots wait
// instead of double-applying.
const MIGRATION_LOCK_KEY = 0x6e637270; // "ncrp"

function findMigrationsFolder(): string {
  // Walk upward from cwd so this works from any directory inside the monorepo.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "lib/db/migrations");
    if (existsSync(path.join(candidate, "meta/_journal.json"))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate lib/db/migrations (searched upward from ${process.cwd()})`,
  );
}

const migrationsFolder = findMigrationsFolder();
console.log(`[ci-migrate] migrations folder: ${migrationsFolder}`);

const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  await migrate(db, { migrationsFolder });
  console.log("[ci-migrate] migrations applied (or already up to date)");
} finally {
  await client
    .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
    .catch(() => {});
  client.release();
  await pool.end();
}
