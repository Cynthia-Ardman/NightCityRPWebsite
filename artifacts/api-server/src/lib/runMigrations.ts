/**
 * Deploy-time database migrations.
 *
 * Applies any pending versioned migrations from lib/db/migrations before the
 * server starts serving. Runs only in production deployments
 * (REPLIT_DEPLOYMENT=1) or when explicitly requested (RUN_DB_MIGRATIONS=1) —
 * dev keeps its own flow (post-merge `pnpm --filter @workspace/db run migrate`
 * and the test harness's throwaway push-force databases).
 *
 * A Postgres advisory lock serializes concurrent instances (autoscale can boot
 * several at once); whoever wins applies the migrations, the rest wait on the
 * lock and then find nothing left to apply.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "@workspace/db";
import { logger } from "./logger";

// Arbitrary but stable app-wide lock key for migration runs.
const MIGRATION_LOCK_KEY = 0x6e637270; // "ncrp"

function findMigrationsFolder(): string {
  // Walk up from cwd so this works whether the process starts from the repo
  // root or from artifacts/api-server (dev workflow / deploy both covered).
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

export function shouldRunMigrations(): boolean {
  return (
    process.env.REPLIT_DEPLOYMENT === "1" ||
    process.env.RUN_DB_MIGRATIONS === "1"
  );
}

export async function runMigrations(): Promise<void> {
  const migrationsFolder = findMigrationsFolder();
  const client = await pool.connect();
  try {
    logger.info({ migrationsFolder }, "Acquiring migration advisory lock");
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await migrate(db, { migrationsFolder });
    logger.info("Database migrations applied (or already up to date)");
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => {});
    client.release();
  }
}
