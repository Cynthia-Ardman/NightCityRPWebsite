import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

// Reconciliation: claim unclaimed imported characters by matching their
// `legacy_discord_username` (the author's pre-migration Discord handle) to a
// portal user. Two complementary, idempotent phases:
//
//   Phase A — users-table match: normalized legacy handle == a portal user's
//             normalized username. Catches owners who have logged in.
//   Phase B — sibling propagation: an unclaimed character whose normalized
//             handle matches an ALREADY-OWNED character inherits that owner.
//             Strongest signal — a prior login/admin already vouched for the
//             handle->owner link, so it also covers owners whose CURRENT
//             username no longer resembles the legacy handle (e.g. owner
//             "Sliss_ [Takashi]" -> legacy "Sliss_"/"_sliss").
//
// Normalization (NORM): lowercase -> strip "<3"-style emoticons -> strip all
// non-alphanumerics. Folds the punctuation/format drift left by Discord's 2023
// username migration: "Vinnybot<3" -> "vinnybot", "moon.gothie" -> "moongothie",
// "_sliss"/"Sliss_" -> "sliss", "ItzKrypto" -> "itzkrypto".
//
// Safety: never clobbers an existing owner_id (COALESCE keeps it); only accepts
// a key that maps to exactly ONE owner (ambiguous keys skipped); requires a
// normalized key length >= 3. Sets claimed=true so the UNCLAIMED badge clears.
// See memory: nullable-owner-guards, auto-claim-legacy-username,
// importer-upsert-idempotency.

const NORM = (col: string) =>
  sql.raw(
    `regexp_replace(regexp_replace(lower(${col}), '<+3+', '', 'g'), '[^a-z0-9]', '', 'g')`,
  );

async function preview() {
  // Phase A candidates
  const a = await db.execute(sql`
    WITH norm_char AS (
      SELECT id, name, legacy_discord_username AS legacy, ${NORM("legacy_discord_username")} AS k
      FROM characters
      WHERE owner_id IS NULL
        AND legacy_discord_username IS NOT NULL AND legacy_discord_username <> ''
    ),
    unique_user AS (
      SELECT k, MIN(id) AS user_id, MIN(username) AS username
      FROM (SELECT id, username, ${NORM("username")} AS k FROM users) u
      WHERE length(k) >= 3
      GROUP BY k HAVING COUNT(DISTINCT id) = 1
    )
    SELECT c.id, c.name, c.legacy, uu.username AS owner_username
    FROM norm_char c JOIN unique_user uu ON uu.k = c.k
    ORDER BY c.id
  `);

  // Phase B candidates (owner null OR claimed false)
  const b = await db.execute(sql`
    WITH unique_owner AS (
      SELECT k, MIN(owner_id) AS owner_id
      FROM (
        SELECT owner_id, ${NORM("legacy_discord_username")} AS k
        FROM characters
        WHERE owner_id IS NOT NULL
          AND legacy_discord_username IS NOT NULL AND legacy_discord_username <> ''
      ) o
      WHERE length(k) >= 3
      GROUP BY k HAVING COUNT(DISTINCT owner_id) = 1
    ),
    targets AS (
      SELECT id, name, legacy_discord_username AS legacy, owner_id, claimed,
             ${NORM("legacy_discord_username")} AS k
      FROM characters
      WHERE (owner_id IS NULL OR claimed = false)
        AND legacy_discord_username IS NOT NULL AND legacy_discord_username <> ''
    )
    SELECT t.id, t.name, t.legacy, t.owner_id AS cur_owner,
           uo.owner_id AS new_owner, u.username AS owner_username
    FROM targets t
    JOIN unique_owner uo ON uo.k = t.k
    LEFT JOIN users u ON u.id = uo.owner_id
    ORDER BY u.username, t.id
  `);

  console.log(`Phase A (users-table match): ${a.rows.length} candidate(s)`);
  for (const r of a.rows as any[])
    console.log(`  #${r.id} ${r.name} [legacy:${r.legacy}] -> ${r.owner_username}`);
  console.log(`\nPhase B (sibling propagation): ${b.rows.length} candidate(s)`);
  for (const r of b.rows as any[]) {
    const tag = r.cur_owner ? "(flip claimed)" : "(new owner)";
    console.log(`  #${r.id} ${r.name} [legacy:${r.legacy}] -> ${r.owner_username} ${tag}`);
  }
}

async function apply() {
  // Phase A
  const a = await db.execute(sql`
    WITH unique_user AS (
      SELECT k, MIN(id) AS user_id
      FROM (SELECT id, ${NORM("username")} AS k FROM users) u
      WHERE length(k) >= 3
      GROUP BY k HAVING COUNT(DISTINCT id) = 1
    )
    UPDATE characters c
    SET owner_id = uu.user_id, claimed = true
    FROM unique_user uu
    WHERE c.owner_id IS NULL
      AND c.legacy_discord_username IS NOT NULL AND c.legacy_discord_username <> ''
      AND ${NORM("c.legacy_discord_username")} = uu.k
  `);

  // Phase B — keep existing owner_id when present, otherwise inherit; always claim.
  const b = await db.execute(sql`
    WITH unique_owner AS (
      SELECT k, MIN(owner_id) AS owner_id
      FROM (
        SELECT owner_id, ${NORM("legacy_discord_username")} AS k
        FROM characters
        WHERE owner_id IS NOT NULL
          AND legacy_discord_username IS NOT NULL AND legacy_discord_username <> ''
      ) o
      WHERE length(k) >= 3
      GROUP BY k HAVING COUNT(DISTINCT owner_id) = 1
    )
    UPDATE characters c
    SET owner_id = COALESCE(c.owner_id, uo.owner_id), claimed = true
    FROM unique_owner uo
    WHERE (c.owner_id IS NULL OR c.claimed = false)
      AND c.legacy_discord_username IS NOT NULL AND c.legacy_discord_username <> ''
      AND ${NORM("c.legacy_discord_username")} = uo.k
  `);

  const ac = (a as unknown as { rowCount?: number }).rowCount ?? 0;
  const bc = (b as unknown as { rowCount?: number }).rowCount ?? 0;
  console.log(`Phase A applied: ${ac} row(s)`);
  console.log(`Phase B applied: ${bc} row(s)`);
}

async function main() {
  const doApply = process.argv.includes("--apply");
  await preview();
  if (!doApply) {
    console.log(`\nDRY RUN — re-run with --apply to write these claims.`);
    return;
  }
  console.log("");
  await apply();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
