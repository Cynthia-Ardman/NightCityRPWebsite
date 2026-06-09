// One-off / repeatable backfill: ensure Main Session events exist on the
// calendar ~3 months out.
//
// Main Sessions run every Sunday but are stored as DISCRETE events (one row per
// week, each with its own Discord scheduled-event), NOT a recurrence rule. So
// the calendar only shows as far out as rows exist. This finds the latest
// session, then clones it forward one week + one session-number at a time
// ("Session 69" → "Session 70") until coverage reaches the horizon.
//
// The actual work lives in backfillMainSessions() in eventsService.ts (shared
// with the daily main_session_backfill cron). Uses createEvent(), so each new
// row goes through the normal Discord sync path (gated on the live flag) exactly
// like a staff-created event.
//
// Idempotent: only fills Sundays AFTER the latest existing session, and skips
// any week that already has a session row.
//
// Usage (from repo root):
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-main-sessions.ts
//
// DRY_RUN=1 prints what it would create without writing.
// HORIZON_DAYS=120 overrides the default 90-day (≈3 month) horizon.

export {};

import { pool } from "@workspace/db";
import { backfillMainSessions } from "../lib/eventsService";

const DRY_RUN = process.env.DRY_RUN === "1";
const HORIZON_DAYS = Number(process.env.HORIZON_DAYS ?? "90");

async function main() {
  console.log(`Horizon: ${HORIZON_DAYS} days out${DRY_RUN ? " [DRY RUN]" : ""}`);
  const r = await backfillMainSessions({ horizonDays: HORIZON_DAYS, dryRun: DRY_RUN });
  if (r.reason) {
    console.log(r.reason);
  }
  for (const t of r.titles) {
    console.log(`  ${DRY_RUN ? "[dry] would create" : "[ ok ] created"} "${t}"`);
  }
  for (const t of r.healedTitles) {
    console.log(`  ${DRY_RUN ? "[dry] would push to Discord" : "[ ok ] pushed to Discord"} "${t}"`);
  }
  console.log(
    `Done. ${DRY_RUN ? "Would create" : "Created"} ${r.created} session(s); ` +
      `${DRY_RUN ? "would push" : "pushed"} ${r.healed} unsynced session(s) to Discord.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error("backfill-main-sessions failed:", err);
  process.exit(1);
});
