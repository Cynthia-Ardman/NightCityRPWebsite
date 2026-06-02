// Applies the database-level append-only history guards
// (lib/db/sql/immutable_history.sql) to the database pointed at by
// DATABASE_URL. Idempotent — safe to run on every post-merge / deploy.
//
// Run: pnpm --filter @workspace/scripts run db:guards
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.resolve(__dirname, "../../lib/db/sql/immutable_history.sql");

// Must stay in sync with the table list in immutable_history.sql.
const EXPECTED_TABLES = [
  "bot_rent_payment_events",
  "bot_balance_history",
  "bot_actor_attendance",
  "bot_attendance_log",
  "audit_log",
  "activity_events",
] as const;
const REQUIRED_TRIGGERS = ["trg_ncrp_block_mutation", "trg_ncrp_block_truncate"];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const sql = fs.readFileSync(SQL_PATH, "utf8");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(sql);

    // Which expected tables actually exist in this database.
    const present = new Set<string>();
    for (const t of EXPECTED_TABLES) {
      const r = await c.query(`SELECT to_regclass($1) AS reg`, [`public.${t}`]);
      if (r.rows[0]?.reg) present.add(t);
    }

    // All guard triggers in the public schema (incl. TRUNCATE, which is not in
    // information_schema.triggers — query pg_trigger directly).
    const trgRows = (
      await c.query(`
        SELECT c.relname AS tbl, t.tgname AS trg
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND t.tgname LIKE 'trg_ncrp_block%'
           AND NOT t.tgisinternal`)
    ).rows as { tbl: string; trg: string }[];
    const byTable = new Map<string, Set<string>>();
    for (const { tbl, trg } of trgRows) {
      if (!byTable.has(tbl)) byTable.set(tbl, new Set());
      byTable.get(tbl)!.add(trg);
    }

    // Every expected table that exists must carry BOTH required triggers.
    const failures: string[] = [];
    for (const t of EXPECTED_TABLES) {
      if (!present.has(t)) {
        console.log(`  - ${t}: table not present (skipped)`);
        continue;
      }
      const have = byTable.get(t) ?? new Set<string>();
      const missing = REQUIRED_TRIGGERS.filter((x) => !have.has(x));
      if (missing.length) failures.push(`${t} (missing: ${missing.join(", ")})`);
      else console.log(`  - ${t}: guarded (UPDATE/DELETE + TRUNCATE)`);
    }

    if (present.size === 0) {
      console.error("ERROR: none of the expected history tables exist — refusing to claim guards are installed");
      process.exit(1);
    }
    if (failures.length) {
      console.error("ERROR: append-only guards incomplete on:");
      for (const f of failures) console.error(`    ${f}`);
      process.exit(1);
    }
    console.log(`Append-only history guards verified on ${present.size} table(s).`);
  } catch (e) {
    console.error("Failed to apply history guards:", e);
    await c.end().catch(() => {});
    process.exit(1);
  }
  await c.end();
  process.exit(0);
}

main();
