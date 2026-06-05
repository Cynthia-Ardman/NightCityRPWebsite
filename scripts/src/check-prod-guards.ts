import pg from "pg";
const { Pool } = pg;

const prod = new Pool({
  connectionString: process.env.LIVE_PROD_DATABASE_URL,
  max: 2,
  ssl: { rejectUnauthorized: false },
});

const NEW_TABLES = [
  "events", "event_npc_signups", "mission_npc_signups",
  "guidebook_pages", "guidebook_pending_edits",
  "breach_puzzles", "breach_practice_clears", "breach_practice_stats",
  "review_comments", "review_seen", "catalog_districts", "bot_rent_payment_events",
];
const PARENTS = ["users", "characters", "missions"];

async function main() {
  const fn = await prod.query(
    `SELECT proname FROM pg_proc WHERE proname = 'ncrp_block_history_mutation'`,
  );
  console.log("guard fn ncrp_block_history_mutation present in prod:", fn.rowCount! > 0);

  const t = await prod.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
    [NEW_TABLES],
  );
  const existing = new Set(t.rows.map((r) => r.table_name));
  console.log("NEW tables that ALREADY exist in prod (should be NONE):",
    NEW_TABLES.filter((n) => existing.has(n)).join(", ") || "(none)");

  const p = await prod.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
    [PARENTS],
  );
  const parents = new Set(p.rows.map((r) => r.table_name));
  console.log("Parent tables present in prod:",
    PARENTS.map((n) => `${n}=${parents.has(n)}`).join(", "));

  await prod.end();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
