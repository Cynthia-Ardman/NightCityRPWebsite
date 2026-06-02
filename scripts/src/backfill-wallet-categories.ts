/**
 * Backfill wallet_transactions.category and link historical (account-level)
 * rows to a character when the owner has exactly one character.
 *
 * - category: derived from (kind, memo) via classifyWalletCategory. Overwritten
 *   on every run (it is a pure derivation, so reruns are no-ops once stable).
 * - character_id: only set on kind='historical' rows that are still unlinked
 *   (character_id IS NULL) AND whose owner has exactly ONE character. Players
 *   with multiple characters stay at the account level — the legacy bot tracked
 *   money per Discord account, so there is no way to attribute a payment to a
 *   specific character for multi-character players.
 *
 * Target selection (matches the other importers):
 *   - default            → DATABASE_URL            (dev)
 *   - IMPORT_TARGET=live → LIVE_PROD_DATABASE_URL  (the Neon DB the site uses)
 *
 * Read-only against the legacy bot DB; this only writes to the target portal DB.
 */
import pg from "pg";
import { classifyWalletCategory } from "@workspace/db";

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
    // ---- 1) Classify every row ----
    const rows = (
      await client.query<{ id: number; kind: string | null; memo: string | null }>(
        `SELECT id, kind, memo FROM wallet_transactions`,
      )
    ).rows;
    console.log(`Loaded ${rows.length} wallet_transactions rows.`);

    const byCategory = new Map<string, number[]>();
    for (const r of rows) {
      const cat = classifyWalletCategory(r.kind, r.memo);
      let arr = byCategory.get(cat);
      if (!arr) {
        arr = [];
        byCategory.set(cat, arr);
      }
      arr.push(r.id);
    }

    let updated = 0;
    for (const [cat, ids] of byCategory) {
      // Only write rows whose category actually changes, so reruns are no-ops.
      const res = await client.query(
        `UPDATE wallet_transactions
           SET category = $1
         WHERE id = ANY($2::int[])
           AND (category IS DISTINCT FROM $1)`,
        [cat, ids],
      );
      updated += res.rowCount ?? 0;
    }
    console.log("\nCategory distribution:");
    for (const [cat, ids] of [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${cat.padEnd(12)} ${ids.length}`);
    }
    console.log(`category rows changed this run: ${updated}`);

    // ---- 2) Link historical rows to single-character owners ----
    const link = await client.query(
      `UPDATE wallet_transactions wt
          SET character_id = sub.cid
         FROM (
           SELECT u.id AS uid, MIN(c.id) AS cid
           FROM users u
           JOIN characters c ON c.owner_id = u.id
           GROUP BY u.id
           HAVING COUNT(*) = 1
         ) sub
        WHERE wt.kind = 'historical'
          AND wt.character_id IS NULL
          AND wt.user_id = sub.uid`,
    );
    console.log(`\nhistorical rows linked to a single character this run: ${link.rowCount}`);

    // ---- Summary ----
    const summary = await client.query(
      `SELECT
         count(*) FILTER (WHERE kind='historical') AS historical_total,
         count(*) FILTER (WHERE kind='historical' AND character_id IS NOT NULL) AS historical_linked,
         count(*) FILTER (WHERE category IS NULL) AS uncategorized
       FROM wallet_transactions`,
    );
    console.log("\nFinal state:", JSON.stringify(summary.rows[0]));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
