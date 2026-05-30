/**
 * Import legacy actor attendance from the old Discord bot.
 *
 * Reads `actor_attendance` from PROD_DATABASE_URL (the legacy bot source,
 * read-only) and inserts into `bot_actor_attendance` in DATABASE_URL.
 * Idempotent: dedups on the legacy serial id (botId) via onConflictDoNothing.
 *
 *   pnpm tsx scripts/src/import-actor-attendance.ts
 */
import pg from "pg";
import { db, botActorAttendance } from "@workspace/db";

async function main() {
  const PROD = process.env.PROD_DATABASE_URL;
  if (!PROD) {
    console.error("PROD_DATABASE_URL not set");
    process.exit(1);
  }
  const prod = new pg.Client({ connectionString: PROD });
  await prod.connect();
  console.log("connected to legacy source (read-only)");

  try {
    await run(prod);
  } finally {
    await prod.end();
  }
  process.exit(0);
}

async function run(prod: pg.Client) {
  const { rows } = await prod.query<{
    id: string;
    user_id: string;
    username: string | null;
    mission_id: string | null;
    mission_name: string | null;
    fixer_id: string | null;
    fixer_username: string | null;
    pay_amount: string | null;
    acted_at: Date;
  }>(
    `SELECT id, user_id, username, mission_id, mission_name,
            fixer_id, fixer_username, pay_amount, acted_at
     FROM actor_attendance`,
  );
  console.log(`legacy actor_attendance rows: ${rows.length}`);

  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const botId = Number(r.id);
    if (!Number.isFinite(botId) || !r.user_id || !r.acted_at) {
      skipped++;
      continue;
    }
    const res = await db
      .insert(botActorAttendance)
      .values({
        botId,
        userId: r.user_id,
        username: r.username,
        missionId: r.mission_id,
        missionName: r.mission_name,
        fixerId: r.fixer_id,
        fixerUsername: r.fixer_username,
        payAmount: Number(r.pay_amount ?? 0) || 0,
        actedAt: r.acted_at,
      })
      .onConflictDoNothing({ target: botActorAttendance.botId })
      .returning({ id: botActorAttendance.id });
    if (res.length > 0) inserted++;
  }

  console.log(`inserted ${inserted}, skipped ${skipped} (invalid), ${rows.length - inserted - skipped} already present`);
}

main().catch((e) => {
  console.error("import failed:", (e as Error).message);
  process.exit(1);
});
