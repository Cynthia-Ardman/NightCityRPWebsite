/**
 * Additive import of bot activity logs from the up-to-date NightCityBot copy.
 *
 * Source: BOT_SOURCE_DATABASE_URL ?? OLD_BOT_DATABASE_URL (the newer bot DB
 * copy, read-only). Target: DATABASE_URL (portal dev DB).
 *
 * Populates these read-only bot mirror tables:
 *   - bot_attendance_log       (from attendance_log)
 *   - bot_business_open_log     (from business_open_log)
 *   - bot_actor_attendance      (from actor_attendance)
 *   - bot_cyberware_weekly_runs (from cyberware_weekly_runs)
 *   - bot_cyberware_status      (from cyberware_status)
 *
 * PURELY ADDITIVE: every insert uses ON CONFLICT DO NOTHING, so existing rows
 * are never overwritten. cyberware_status is a per-user state table — existing
 * user rows are preserved as-is (only genuinely new users are added).
 *
 * Idempotent: safe to rerun. Linkage is per-player via user_id (Discord ID),
 * which maps to portal users.id.
 *
 *   pnpm --filter @workspace/scripts exec tsx src/import-bot-activity.ts
 */
import pg from "pg";

function assertDevTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (target) is required.");
  const targetHost = new URL(url).host;
  const sourceUrl =
    process.env.BOT_SOURCE_DATABASE_URL ?? process.env.OLD_BOT_DATABASE_URL;
  if (!sourceUrl)
    throw new Error("OLD_BOT_DATABASE_URL (or BOT_SOURCE_DATABASE_URL) is required.");
  const sourceHost = new URL(sourceUrl).host;
  for (const [name, v] of Object.entries({
    OLD_BOT_DATABASE_URL: process.env.OLD_BOT_DATABASE_URL,
    PROD_DATABASE_URL: process.env.PROD_DATABASE_URL,
    LIVE_PROD_DATABASE_URL: process.env.LIVE_PROD_DATABASE_URL,
  })) {
    if (v && new URL(v).host === targetHost) {
      throw new Error(
        `Refusing to write: DATABASE_URL host matches ${name}. Target must be the portal dev DB, not a source/live DB.`,
      );
    }
  }
  return { targetHost, sourceUrl, sourceHost };
}

type Counts = { received: number; inserted: number };

async function chunkInsert(
  target: pg.Client,
  sql: (placeholders: string) => string,
  perRowParams: (r: any) => unknown[],
  rows: any[],
  cols: number,
): Promise<Counts> {
  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((r, ri) => {
      const ph = Array.from({ length: cols }, (_, ci) => `$${ri * cols + ci + 1}`);
      params.push(...perRowParams(r));
      return `(${ph.join(",")})`;
    });
    const res = await target.query(sql(tuples.join(",")), params);
    inserted += res.rowCount ?? 0;
  }
  return { received: rows.length, inserted };
}

async function main() {
  const { targetHost, sourceUrl, sourceHost } = assertDevTarget();
  const source = new pg.Client({ connectionString: sourceUrl });
  const target = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await source.connect();
  await target.connect();
  console.log(`Source: ${sourceHost}  ->  Target (dev): ${targetHost}`);

  const out: Record<string, Counts> = {};

  // 1) attendance_log -> bot_attendance_log  (dedup user_id + logged_at)
  {
    const { rows } = await source.query(
      `SELECT user_id, logged_at FROM attendance_log WHERE user_id IS NOT NULL AND logged_at IS NOT NULL`,
    );
    out.bot_attendance_log = await chunkInsert(
      target,
      (ph) =>
        `INSERT INTO bot_attendance_log (user_id, logged_at) VALUES ${ph}
         ON CONFLICT (user_id, logged_at) DO NOTHING`,
      (r) => [r.user_id, r.logged_at],
      rows,
      2,
    );
  }

  // 2) business_open_log -> bot_business_open_log  (dedup user_id + opened_at)
  {
    const { rows } = await source.query(
      `SELECT user_id, opened_at FROM business_open_log WHERE user_id IS NOT NULL AND opened_at IS NOT NULL`,
    );
    out.bot_business_open_log = await chunkInsert(
      target,
      (ph) =>
        `INSERT INTO bot_business_open_log (user_id, opened_at) VALUES ${ph}
         ON CONFLICT (user_id, opened_at) DO NOTHING`,
      (r) => [r.user_id, r.opened_at],
      rows,
      2,
    );
  }

  // 3) actor_attendance -> bot_actor_attendance  (dedup bot_id)
  {
    const { rows } = await source.query(
      `SELECT id, user_id, username, mission_id, mission_name,
              fixer_id, fixer_username, pay_amount, acted_at
       FROM actor_attendance WHERE user_id IS NOT NULL AND acted_at IS NOT NULL`,
    );
    let inserted = 0;
    for (const r of rows) {
      const botId = Number(r.id);
      if (!Number.isFinite(botId)) continue;
      const res = await target.query(
        `INSERT INTO bot_actor_attendance
           (bot_id, user_id, username, mission_id, mission_name,
            fixer_id, fixer_username, pay_amount, acted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (bot_id) DO NOTHING`,
        [
          botId, r.user_id, r.username, r.mission_id, r.mission_name,
          r.fixer_id, r.fixer_username, Number(r.pay_amount ?? 0) || 0, r.acted_at,
        ],
      );
      inserted += res.rowCount ?? 0;
    }
    out.bot_actor_attendance = { received: rows.length, inserted };
  }

  // 4) cyberware_weekly_runs -> bot_cyberware_weekly_runs  (dedup bot_id)
  {
    const { rows } = await source.query(
      `SELECT id, run_at, checkup_ids, paid_ids, unpaid_ids
       FROM cyberware_weekly_runs ORDER BY run_at`,
    );
    let inserted = 0;
    for (const r of rows) {
      const res = await target.query(
        `INSERT INTO bot_cyberware_weekly_runs
           (bot_id, run_at, checkup_ids, paid_ids, unpaid_ids)
         VALUES ($1,$2,to_jsonb($3::text[]),to_jsonb($4::text[]),to_jsonb($5::text[]))
         ON CONFLICT (bot_id) DO NOTHING`,
        [r.id, r.run_at, r.checkup_ids ?? [], r.paid_ids ?? [], r.unpaid_ids ?? []],
      );
      inserted += res.rowCount ?? 0;
    }
    out.bot_cyberware_weekly_runs = { received: rows.length, inserted };
  }

  // 5) cyberware_status -> bot_cyberware_status  (ADDITIVE ONLY: preserve existing)
  {
    const { rows } = await source.query(
      `SELECT user_id, weeks, last_processed, updated_at FROM cyberware_status WHERE user_id IS NOT NULL`,
    );
    let inserted = 0;
    for (const r of rows) {
      const res = await target.query(
        `INSERT INTO bot_cyberware_status (user_id, weeks, last_processed, updated_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id) DO NOTHING`,
        [r.user_id, r.weeks ?? 0, r.last_processed, r.updated_at],
      );
      inserted += res.rowCount ?? 0;
    }
    out.bot_cyberware_status = { received: rows.length, inserted };
  }

  console.table(out);
  await source.end();
  await target.end();
  console.log("Done (additive, no overwrites).");
}

main().catch((err) => {
  console.error("import-bot-activity failed:", err);
  process.exit(1);
});
