/**
 * One-time cutover backfill for the staged review-ticket lifecycle.
 *
 * Background: approval/denial used to apply effects immediately. The new
 * lifecycle DEFERS effects to a fixer's explicit "Close ticket" action
 * (pending/changes_requested -> approved/rejected/cancelled -> closed). Any
 * row that was already terminal (approved/rejected/cancelled) under the OLD
 * flow has ALREADY had its effects applied, so it must be moved straight to
 * `closed` — otherwise the new Close endpoint would re-apply already-applied
 * effects (double materialization).
 *
 * Tables: custom_requests, pending_character_edits, character_sheets.
 *
 * Rerun-safety:
 *   - rejected / cancelled rows have NO effects, so they are closed
 *     unconditionally (safe to rerun).
 *   - approved custom_requests are closed only WHERE applied_ref IS NOT NULL
 *     (legacy rows that actually materialized; new-flow approved rows have a
 *     null applied_ref until Close, so a rerun won't touch them).
 *   - approved character_sheets are closed only WHERE character_id IS NOT NULL
 *     (legacy materialized sheets link a character; new-flow approved sheets
 *     are linked only at Close time).
 *   - approved pending_character_edits have no applied-marker column, so they
 *     are closed unconditionally. There must be NO new-flow approved-but-open
 *     edits when this runs — run it ONCE at cutover, before the new flow can
 *     produce approved-awaiting-close edits.
 *
 * Target DB is DATABASE_URL by default (dev). To run against live prod:
 *   IMPORT_TARGET=prod DATABASE_URL=<live prod url> pnpm exec tsx scripts/src/backfill-review-closed.ts
 *
 * Dry run (no writes, just counts):
 *   DRY_RUN=1 pnpm exec tsx scripts/src/backfill-review-closed.ts
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
  const dryRun = process.env.DRY_RUN === "1";
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`Target: ${targetHost}${dryRun ? "  (DRY RUN — no writes)" : ""}`);

  // Each entry: a human label + the WHERE clause that selects legacy terminal
  // rows still needing to be closed.
  const plan: { table: string; where: string }[] = [
    {
      table: "custom_requests",
      where:
        "status IN ('rejected','cancelled') OR (status = 'approved' AND applied_ref IS NOT NULL)",
    },
    {
      table: "pending_character_edits",
      where: "status IN ('approved','rejected','cancelled')",
    },
    {
      table: "character_sheets",
      where:
        "status IN ('rejected','cancelled') OR (status = 'approved' AND character_id IS NOT NULL)",
    },
  ];

  for (const { table, where } of plan) {
    const preview = await client.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE (${where}) AND status <> 'closed'`,
    );
    const n = preview.rows[0].n as number;
    console.log(`${table}: ${n} terminal row(s) to close`);
    if (n === 0 || dryRun) continue;
    const res = await client.query(
      `UPDATE ${table}
         SET status = 'closed', closed_at = now()
       WHERE (${where}) AND status <> 'closed'`,
    );
    console.log(`  closed ${res.rowCount} ${table} row(s)`);
  }

  await client.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
