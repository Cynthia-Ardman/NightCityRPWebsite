// READ-ONLY diagnostic against live prod for phantom pending counts + calendar dupes.
import pg from "pg";

const prod = new pg.Pool({
  connectionString: process.env.LIVE_PROD_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

async function main() {
  console.log("=== character_sheets (actionable) ===");
  const sheets = await prod.query(
    `SELECT id, name, status, owner_id, created_at
       FROM character_sheets
      WHERE status IN ('pending','changes_requested')
      ORDER BY created_at`,
  );
  console.table(sheets.rows);

  console.log("\n=== custom_requests (actionable) ===");
  const reqs = await prod.query(
    `SELECT id, type, status, requested_by_id, character_id, created_at
       FROM custom_requests
      WHERE status IN ('pending','changes_requested')
      ORDER BY created_at`,
  );
  console.table(reqs.rows);

  console.log("\n=== pending_character_edits (actionable) ===");
  const edits = await prod.query(
    `SELECT id, character_id, status, submitted_by, submitted_at
       FROM pending_character_edits
      WHERE status IN ('pending','changes_requested')
      ORDER BY submitted_at`,
  );
  console.table(edits.rows);

  console.log("\n=== events needing NPCs (next 10 days) ===");
  const ev = await prod.query(
    `SELECT id, title, event_type, needs_npcs, status,
            start_at, discord_event_id, recurrence_rule
       FROM events
      WHERE needs_npcs IS TRUE
        AND start_at BETWEEN now() - interval '2 days' AND now() + interval '10 days'
      ORDER BY start_at`,
  );
  console.table(ev.rows);

  await prod.end();
  process.exit(0);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
