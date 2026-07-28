// One-off backfill: missions whose payout lifecycle advanced status into a
// completed_* state without stamping completedAt (pre-completedAtStamp code)
// kept surfacing as "upcoming" in applicant-review badges. Stamp completedAt
// from startAt (the mission ran then), falling back to createdAt.
//
// Run:
//   DATABASE_URL="$LIVE_PROD_DATABASE_URL" ALLOW_EXTERNAL_WRITES=1 \
//     pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-mission-completed-at.ts
import pg from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  if (process.env.ALLOW_EXTERNAL_WRITES !== "1") throw new Error("ALLOW_EXTERNAL_WRITES=1 required");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query(
      `UPDATE missions
         SET completed_at = COALESCE(start_at, created_at)
       WHERE status IN ('completed', 'completed_players_paid', 'completed_paid')
         AND completed_at IS NULL
       RETURNING id, title, status, completed_at`,
    );
    console.log(`Backfilled ${res.rowCount} missions:`);
    for (const r of res.rows) console.log(`  #${r.id} [${r.status}] ${r.title} -> ${r.completed_at?.toISOString?.() ?? r.completed_at}`);
  } finally {
    await client.end();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
