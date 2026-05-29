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
 *
 * Promotion matching is deliberately strict to avoid over-promoting unrelated
 * historical missions that happen to share a title for the same character. A
 * completed mission is only promoted when there is a mission-kind wallet credit
 * for the SAME character whose:
 *   - amount equals the mission's payout (payout_eddies, which must be > 0), AND
 *   - memo is exactly "Mission: <title>", AND
 *   - created_at is within a few minutes of the mission row (the credit and the
 *     mission row are written in the same POST /fixer/missions request).
 * Before promoting, the script reports any ambiguous matches (a completed
 * mission matching more than one distinct credit) for manual review, and after
 * running it asserts that no legacy tokens remain.
 */

// How close (in minutes) the wallet credit must have been written to the
// mission row to be considered the payment for that mission.
const MATCH_WINDOW_MINUTES = 10;

// Shared predicate: does completed mission `m` have a matching mission credit?
const matchPredicate = sql`
  m.payout_eddies > 0
  AND EXISTS (
    SELECT 1 FROM wallet_transactions w
    WHERE w.kind = 'mission'
      AND w.character_id = m.character_id
      AND w.amount = m.payout_eddies
      AND w.memo = 'Mission: ' || m.title
      AND abs(extract(epoch FROM (w.created_at - m.created_at))) <= ${MATCH_WINDOW_MINUTES} * 60
  )
`;

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

  // Surface ambiguous promotions BEFORE applying them: completed missions whose
  // strict predicate matches more than one distinct mission credit. These are
  // the only rows where the strict match could still be wrong, so they are
  // reported for manual review rather than silently promoted/skipped.
  const ambiguous = await db.execute(sql`
    SELECT m.id, m.character_id, m.title, m.payout_eddies, count(w.id)::int AS matches
    FROM mission_log m
    JOIN wallet_transactions w
      ON w.kind = 'mission'
      AND w.character_id = m.character_id
      AND w.amount = m.payout_eddies
      AND w.memo = 'Mission: ' || m.title
      AND abs(extract(epoch FROM (w.created_at - m.created_at))) <= ${MATCH_WINDOW_MINUTES} * 60
    WHERE m.status = 'completed' AND m.payout_eddies > 0
    GROUP BY m.id, m.character_id, m.title, m.payout_eddies
    HAVING count(w.id) > 1
    ORDER BY matches DESC
  `);

  // Promote any completed mission that actually paid a character through the
  // portal, using the strict match predicate above.
  const promoted = await db.execute(sql`
    UPDATE mission_log m
    SET status = 'completed_and_paid'
    WHERE m.status = 'completed' AND ${matchPredicate}
  `);

  const after = await db.execute(
    sql`SELECT status, count(*)::int AS n FROM mission_log GROUP BY status ORDER BY n DESC`,
  );

  console.log("paid -> completed_and_paid:", paid.rowCount);
  console.log("canceled/failed -> cancelled:", cancelled.rowCount);
  console.log("planned -> pending:", pending.rowCount);
  console.log("completed (portal-paid) -> completed_and_paid:", promoted.rowCount);
  if (ambiguous.rows.length > 0) {
    console.warn(
      `\nWARNING: ${ambiguous.rows.length} completed mission(s) matched more than one ` +
        `mission credit (same character, title, and amount within the time window). ` +
        `These were promoted to completed_and_paid; review them if a false match is suspected:`,
    );
    console.warn(ambiguous.rows);
  }
  console.log("\nfinal distribution:", after.rows);

  // Post-migration assertion: no legacy status tokens may remain. Fail loudly
  // so a partial/broken run can't pass silently.
  const leftover = await db.execute(sql`
    SELECT status, count(*)::int AS n FROM mission_log
    WHERE status NOT IN ('pending', 'completed', 'completed_and_paid', 'cancelled')
    GROUP BY status ORDER BY n DESC
  `);
  if (leftover.rows.length > 0) {
    console.error("\nERROR: legacy status tokens still present after migration:", leftover.rows);
    throw new Error("migration incomplete: legacy status tokens remain");
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
