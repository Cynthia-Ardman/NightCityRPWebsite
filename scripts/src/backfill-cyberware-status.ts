/**
 * Backfill bot_cyberware_status + bot_cyberware_weekly_runs in the portal DB
 * from the legacy NightCityBot DB (PROD_DATABASE_URL — different schema, the
 * source tables are named cyberware_status / cyberware_weekly_runs without
 * the `bot_` prefix).
 *
 * The portal's dashboard "weeks since last checkup" used to read only
 * characters.last_checkup_at, which is per-character and was never populated
 * by the legacy bot — so every user looked like they'd "never" had a checkup.
 * The bot tracks this per-USER (one row keyed on discord_id) and the portal
 * mirrors that in bot_cyberware_status; this script just copies the data
 * across.
 *
 * Target DB is DATABASE_URL by default. Set IMPORT_TARGET=prod and point
 * DATABASE_URL at LIVE_PROD_DATABASE_URL to push to the live site.
 *
 * Idempotent: upserts by primary key, safe to rerun.
 */
import pg from "pg";

function assertTargetAllowed() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (target).");
  const host = new URL(url).host;
  const looksDev = /helium|replit\.dev|replit\.com|localhost|127\.0\.0\.1/i.test(host);
  if (!looksDev && process.env.IMPORT_TARGET !== "prod") {
    console.error(
      `Refusing to write to ${host}: not a dev-looking host. Set IMPORT_TARGET=prod to override.`,
    );
    process.exit(2);
  }
  if (looksDev && process.env.IMPORT_TARGET === "prod") {
    console.error(
      `IMPORT_TARGET=prod set but DATABASE_URL host ${host} looks like dev. Refusing.`,
    );
    process.exit(2);
  }
  return host;
}

async function main() {
  const targetHost = assertTargetAllowed();
  const legacyUrl = process.env.PROD_DATABASE_URL;
  if (!legacyUrl) throw new Error("PROD_DATABASE_URL (legacy bot DB) is required.");

  const source = new pg.Client({ connectionString: legacyUrl });
  const target = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await source.connect();
  await target.connect();
  console.log(`Source: ${new URL(legacyUrl).host}  →  Target: ${targetHost}`);

  const cs = await source.query(
    `SELECT user_id, weeks, last_processed, updated_at FROM cyberware_status`,
  );
  console.log(`cyberware_status: ${cs.rows.length} rows`);
  let csUpserts = 0;
  for (const r of cs.rows) {
    await target.query(
      `INSERT INTO bot_cyberware_status (user_id, weeks, last_processed, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET
         weeks = EXCLUDED.weeks,
         last_processed = EXCLUDED.last_processed,
         updated_at = EXCLUDED.updated_at`,
      [r.user_id, r.weeks ?? 0, r.last_processed, r.updated_at],
    );
    csUpserts++;
  }
  console.log(`  upserted ${csUpserts} cyberware_status rows`);

  // weekly_runs has a serial PK on the portal side; use legacy id as bot_id
  // (unique) for idempotency on rerun.
  const wr = await source.query(
    `SELECT id, run_at, checkup_ids, paid_ids, unpaid_ids FROM cyberware_weekly_runs ORDER BY run_at`,
  );
  console.log(`cyberware_weekly_runs: ${wr.rows.length} rows`);
  let wrUpserts = 0;
  for (const r of wr.rows) {
    // Source columns are text[]; portal mirror stores them as jsonb. Cast
    // through to_jsonb() so an empty array becomes [] (not null).
    await target.query(
      `INSERT INTO bot_cyberware_weekly_runs (bot_id, run_at, checkup_ids, paid_ids, unpaid_ids)
       VALUES ($1,$2,to_jsonb($3::text[]),to_jsonb($4::text[]),to_jsonb($5::text[]))
       ON CONFLICT (bot_id) DO UPDATE SET
         run_at = EXCLUDED.run_at,
         checkup_ids = EXCLUDED.checkup_ids,
         paid_ids = EXCLUDED.paid_ids,
         unpaid_ids = EXCLUDED.unpaid_ids`,
      [r.id, r.run_at, r.checkup_ids ?? [], r.paid_ids ?? [], r.unpaid_ids ?? []],
    );
    wrUpserts++;
  }
  console.log(`  upserted ${wrUpserts} weekly_runs rows`);

  await source.end();
  await target.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
