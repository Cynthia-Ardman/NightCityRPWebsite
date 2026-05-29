import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

/**
 * One-time migration to the four-status mission model:
 *   pending | completed | completed_and_paid | cancelled
 *
 * Legacy/imported tokens are mapped as follows:
 *   - paid                       -> completed_and_paid  (prod importer's "paid")
 *   - canceled / failed          -> cancelled
 *   - planned                    -> pending
 *   - completed (portal-paid)    -> completed_and_paid  (has a matching
 *                                   mission-kind wallet credit)
 *   - completed (everything else) stays completed
 *
 * Idempotent: re-running only touches rows still on a legacy token, and the
 * portal-paid promotion only matches completed rows that have a mission
 * wallet credit.
 */
async function main() {
  const paid = await db.execute(
    sql`UPDATE mission_log SET status = 'completed_and_paid' WHERE status = 'paid'`,
  );
  const cancelled = await db.execute(
    sql`UPDATE mission_log SET status = 'cancelled' WHERE status IN ('canceled', 'failed')`,
  );
  const pending = await db.execute(
    sql`UPDATE mission_log SET status = 'pending' WHERE status = 'planned'`,
  );
  // Promote any completed mission that actually paid a character through the
  // portal (wallet credit kind='mission', memo "Mission: <title>").
  const promoted = await db.execute(sql`
    UPDATE mission_log m
    SET status = 'completed_and_paid'
    WHERE m.status = 'completed'
      AND EXISTS (
        SELECT 1 FROM wallet_transactions w
        WHERE w.kind = 'mission'
          AND w.character_id = m.character_id
          AND w.amount > 0
          AND w.memo = 'Mission: ' || m.title
      )
  `);

  const after = await db.execute(
    sql`SELECT status, count(*)::int AS n FROM mission_log GROUP BY status ORDER BY n DESC`,
  );

  console.log("paid -> completed_and_paid:", paid.rowCount);
  console.log("canceled/failed -> cancelled:", cancelled.rowCount);
  console.log("planned -> pending:", pending.rowCount);
  console.log("completed (portal-paid) -> completed_and_paid:", promoted.rowCount);
  console.log("final distribution:", after.rows);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
