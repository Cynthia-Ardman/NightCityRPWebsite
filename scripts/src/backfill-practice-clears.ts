/**
 * Backfill breach_practice_clears from the existing breach_practice_stats
 * aggregate so the practice leaderboard keeps its current standings when it
 * switches from "one best time per player" to ranking individual runs.
 *
 * For each stats row with a non-null fastest_clear_ms we seed ONE clear run
 * (the player's best known time). It is the most we can faithfully reconstruct
 * from the aggregate — going forward, every winning run is recorded on its own.
 *
 * Idempotent: a clear row is only seeded when no clear with that exact
 * (user, difficulty, time) already exists, so reruns are no-ops. Matching on the
 * exact best time (rather than the user/difficulty pair) also preserves the
 * legacy best even if the player already recorded other runs after rollout.
 *
 * Target selection (matches the other importers):
 *   - default            → DATABASE_URL            (dev)
 *   - IMPORT_TARGET=live → LIVE_PROD_DATABASE_URL  (the Neon DB the site uses)
 */
import pg from "pg";

const targetIsLive = process.env.IMPORT_TARGET === "live";
const TARGET = targetIsLive
  ? process.env.LIVE_PROD_DATABASE_URL
  : process.env.DATABASE_URL;

if (!TARGET) {
  console.error(
    targetIsLive
      ? "IMPORT_TARGET=live but LIVE_PROD_DATABASE_URL is not set"
      : "DATABASE_URL (dev target) is not set",
  );
  process.exit(1);
}

async function main() {
  const client = new pg.Client({ connectionString: TARGET });
  await client.connect();
  console.log(`Target: ${targetIsLive ? "LIVE (LIVE_PROD_DATABASE_URL)" : "dev (DATABASE_URL)"}`);
  try {
    const res = await client.query(
      `INSERT INTO breach_practice_clears (user_id, difficulty, clear_ms, created_at)
       SELECT s.user_id, s.difficulty, s.fastest_clear_ms, s.updated_at
         FROM breach_practice_stats s
        WHERE s.fastest_clear_ms IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM breach_practice_clears c
             WHERE c.user_id = s.user_id
               AND c.difficulty = s.difficulty
               AND c.clear_ms = s.fastest_clear_ms
          )`,
    );
    console.log(`Seeded ${res.rowCount ?? 0} clear run(s) from existing best times.`);

    const summary = await client.query(
      `SELECT difficulty, count(*) AS runs
         FROM breach_practice_clears
        GROUP BY difficulty
        ORDER BY difficulty`,
    );
    console.log("\nClear runs per difficulty:");
    for (const r of summary.rows) {
      console.log(`  ${String(r.difficulty).padEnd(12)} ${r.runs}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
