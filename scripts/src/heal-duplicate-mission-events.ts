import pg from "pg";

// One-off heal for the calendar "same event shown twice" bug: an `events` row
// and a `missions` row can share the same Discord scheduled-event id (the event
// was imported from Discord first, then a mission was created for / linked to
// the same Discord event). The calendar merges missions + events, so the shared
// Discord event renders as two chips on the same day. The mission system owns
// the Discord lifecycle, so the event row is the duplicate: cancel it (hides it
// from the calendar — listEvents excludes cancelled) and UNLINK its Discord id
// so the events reconcile never tears down the mission's live Discord event.
//
// This mirrors the auto-heal now built into reconcileDiscordEvents; the script
// just applies it immediately to a given database. Idempotent.
//
// Usage:
//   TARGET=dev  pnpm --filter @workspace/scripts exec tsx src/heal-duplicate-mission-events.ts
//   TARGET=live pnpm --filter @workspace/scripts exec tsx src/heal-duplicate-mission-events.ts

async function main() {
  const target = (process.env.TARGET ?? "dev").toLowerCase();
  const connectionString =
    target === "live" ? process.env.LIVE_PROD_DATABASE_URL : process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`No connection string for TARGET=${target}`);
    process.exit(1);
  }
  const ssl = target === "live" ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString, ssl, max: 2 });

  const preview = await pool.query(
    `SELECT e.id, e.title, e.status, e.discord_event_id, m.id AS mission_id, m.title AS mission_title
       FROM events e
       JOIN missions m ON m.discord_event_id = e.discord_event_id
      WHERE e.discord_event_id IS NOT NULL
        AND e.status <> 'cancelled'
      ORDER BY e.id`,
  );
  console.log(`[${target}] duplicate event rows owned by a mission: ${preview.rows.length}`);
  for (const r of preview.rows) {
    console.log(
      `  event ${r.id} "${r.title}" (${r.status}) <-> mission ${r.mission_id} "${r.mission_title}" [disc ${r.discord_event_id}]`,
    );
  }

  if (preview.rows.length === 0) {
    console.log(`[${target}] nothing to heal.`);
    await pool.end();
    process.exit(0);
  }

  const upd = await pool.query(
    `UPDATE events e
        SET status = 'cancelled',
            discord_event_id = NULL,
            discord_sync_error = NULL,
            discord_synced_at = now()
       FROM missions m
      WHERE m.discord_event_id = e.discord_event_id
        AND e.discord_event_id IS NOT NULL
        AND e.status <> 'cancelled'
      RETURNING e.id`,
  );
  console.log(`[${target}] healed ${upd.rowCount} event row(s).`);
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
