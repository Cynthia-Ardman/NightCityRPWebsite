// One-off backfill: populate closed_outcome on already-closed review rows.
//
// Closing used to overwrite status with "closed" and lose the resolved outcome
// (approved / rejected / cancelled). New closes now persist it; this script
// recovers it for legacy rows where it is derivable, and leaves it NULL (the
// UI keeps the generic CLOSED badge) where it is not:
//
// - custom_requests: applied_ref set => the approved effect was committed =>
//   'approved'. Otherwise use the request_closed audit message, which embeds
//   the pre-close status: "(rejected)" / "(cancelled)" / "(approved)".
// - character_sheets: a 'sheet_closed_applied' audit row => materialized on
//   close => 'approved'. Remaining closed sheets went through the archive
//   branch (whose old audit message unhelpfully logged "(closed)"), so fall
//   back to the row itself — but only when the evidence is unambiguous:
//   a full decision stamp (decided_at AND decision_by) => 'rejected'; no
//   decision stamp at all (all three decision fields null) => 'cancelled'
//   (player withdrawal never stamps a decision). Mixed/partial stamps stay
//   NULL and keep the generic CLOSED badge.
// - pending_character_edits: the edit_closed audit message embeds the
//   pre-close status: "(approved)" / "(rejected)" / "(cancelled)".
//
// Idempotent: every UPDATE is guarded by closed_outcome IS NULL.
// Run: pnpm --filter @workspace/api-server exec tsx scripts/backfill-closed-outcome.ts
import pg from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 15000,
    statement_timeout: 60000,
    query_timeout: 60000,
  });
  await client.connect();

  // --- custom_requests ---
  const reqApplied = await client.query(`
    UPDATE custom_requests
    SET closed_outcome = 'approved'
    WHERE status = 'closed' AND closed_outcome IS NULL AND applied_ref IS NOT NULL
  `);
  console.log(`custom_requests approved via applied_ref: ${reqApplied.rowCount}`);

  const reqAudit = await client.query(`
    UPDATE custom_requests cr
    SET closed_outcome = a.outcome
    FROM (
      SELECT DISTINCT ON (target_id) target_id,
        CASE
          WHEN message LIKE '%(approved)%' THEN 'approved'
          WHEN message LIKE '%(rejected)%' THEN 'rejected'
          WHEN message LIKE '%(cancelled)%' THEN 'cancelled'
        END AS outcome
      FROM audit_log
      WHERE action = 'request_closed' AND target_type = 'custom_request'
      ORDER BY target_id, created_at DESC
    ) a
    WHERE cr.status = 'closed' AND cr.closed_outcome IS NULL
      AND a.target_id = cr.id::text AND a.outcome IS NOT NULL
  `);
  console.log(`custom_requests via audit_log: ${reqAudit.rowCount}`);

  // --- character_sheets ---
  const sheetApplied = await client.query(`
    UPDATE character_sheets cs
    SET closed_outcome = 'approved'
    WHERE status = 'closed' AND closed_outcome IS NULL
      AND EXISTS (
        SELECT 1 FROM audit_log a
        WHERE a.action = 'sheet_closed_applied' AND a.target_type = 'sheet' AND a.target_id = cs.id::text
      )
  `);
  console.log(`character_sheets approved via sheet_closed_applied audit: ${sheetApplied.rowCount}`);

  const sheetArchived = await client.query(`
    UPDATE character_sheets
    SET closed_outcome = CASE
      WHEN decided_at IS NOT NULL AND decision_by IS NOT NULL THEN 'rejected'
      WHEN decided_at IS NULL AND decision_by IS NULL AND overridden_by IS NULL THEN 'cancelled'
    END
    WHERE status = 'closed' AND closed_outcome IS NULL
      AND EXISTS (
        SELECT 1 FROM audit_log a
        WHERE a.action = 'sheet_closed' AND a.target_type = 'sheet' AND a.target_id = character_sheets.id::text
      )
      AND (
        (decided_at IS NOT NULL AND decision_by IS NOT NULL)
        OR (decided_at IS NULL AND decision_by IS NULL AND overridden_by IS NULL)
      )
  `);
  console.log(`character_sheets archived (rejected/cancelled): ${sheetArchived.rowCount}`);

  // --- pending_character_edits ---
  const editAudit = await client.query(`
    UPDATE pending_character_edits pe
    SET closed_outcome = a.outcome
    FROM (
      SELECT DISTINCT ON (target_id) target_id,
        CASE
          WHEN message LIKE '%(approved)%' THEN 'approved'
          WHEN message LIKE '%(rejected)%' THEN 'rejected'
          WHEN message LIKE '%(cancelled)%' THEN 'cancelled'
        END AS outcome
      FROM audit_log
      WHERE action = 'edit_closed' AND target_type = 'pending_character_edit'
      ORDER BY target_id, created_at DESC
    ) a
    WHERE pe.status = 'closed' AND pe.closed_outcome IS NULL
      AND a.target_id = pe.id::text AND a.outcome IS NOT NULL
  `);
  console.log(`pending_character_edits via audit_log: ${editAudit.rowCount}`);

  const remaining = await client.query(`
    SELECT
      (SELECT count(*) FROM custom_requests WHERE status='closed' AND closed_outcome IS NULL) AS requests,
      (SELECT count(*) FROM character_sheets WHERE status='closed' AND closed_outcome IS NULL) AS sheets,
      (SELECT count(*) FROM pending_character_edits WHERE status='closed' AND closed_outcome IS NULL) AS edits
  `);
  console.log("still NULL (unrecoverable, keep CLOSED badge):", remaining.rows[0]);

  await client.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
