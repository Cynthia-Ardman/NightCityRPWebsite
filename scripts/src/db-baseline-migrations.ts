/**
 * Mark already-applied Drizzle migrations as applied in a target database
 * WITHOUT running their SQL. Used for baseline resolution: the 0000_baseline
 * migration describes schema that dev + live prod already have (built up via
 * drizzle-kit push), so `drizzle-kit migrate` must consider it applied rather
 * than trying to re-create every table.
 *
 * Usage:
 *   tsx scripts/src/db-baseline-migrations.ts DATABASE_URL
 *   tsx scripts/src/db-baseline-migrations.ts LIVE_PROD_DATABASE_URL
 *
 * The argument is the NAME of the env var holding the connection string, so
 * the URL itself never appears on a command line. Idempotent: rows already
 * present (matched by hash) are skipped.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../lib/db/migrations");

const envVarName = process.argv[2];
if (!envVarName) {
  console.error("Usage: tsx db-baseline-migrations.ts <ENV_VAR_NAME>");
  process.exit(1);
}
const url = process.env[envVarName];
if (!url) {
  console.error(`Env var ${envVarName} is not set`);
  process.exit(1);
}

type JournalEntry = { idx: number; when: number; tag: string };
const journal = JSON.parse(
  readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
) as { entries: JournalEntry[] };

async function main() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const host = new URL(url!).hostname;
  console.log(`Target: ${envVarName} (host ${host})`);
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
         id SERIAL PRIMARY KEY,
         hash text NOT NULL,
         created_at bigint
       )`,
    );
    for (const entry of journal.entries) {
      const sql = readFileSync(
        path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
        "utf8",
      );
      const hash = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query(
        `SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = $1`,
        [hash],
      );
      if (existing.rowCount) {
        console.log(`  ${entry.tag}: already marked applied, skipping`);
        continue;
      }
      await client.query(
        `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [hash, entry.when],
      );
      console.log(`  ${entry.tag}: marked as applied (no SQL executed)`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
