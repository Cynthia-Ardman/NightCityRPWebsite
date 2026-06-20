// One-off / repeatable backfill: ensure every currently-open
// mission has a Discord discussion thread, and seed a single current-state
// snapshot into any thread newly created by this run.
//
// "Open" = workflowState='posted' AND status NOT completed/cancelled AND no
// discordThreadId yet. For each, the shared ensureMissionThread() posts a fresh
// fixer job-proposal brief (reusing an already-stored brief message when one
// exists), starts a thread off it, and persists the linkage. discordThreadId is
// set ONLY when the thread helper returns non-null.
//
// The actual work lives in runMissionThreadBackfill() in missionsService.ts
// (shared with the admin "mission_thread_backfill" job). All writes go through
// the deployment-gated post helpers, so this is a pure no-op in the dev
// workspace unless ALLOW_EXTERNAL_WRITES=1 is set.
//
// Idempotent: it only ever targets missions still missing a thread, so a re-run
// never re-posts a brief, re-creates a thread, or duplicates a snapshot.
//
// Usage (from repo root):
//   pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-mission-threads.ts

export {};

import { pool } from "@workspace/db";
import { runMissionThreadBackfill } from "../lib/missionsService";

async function main() {
  const allowed = process.env.REPLIT_DEPLOYMENT === "1" || process.env.ALLOW_EXTERNAL_WRITES === "1";
  if (!allowed) {
    console.log(
      "Note: Discord writes are suppressed (not a deployment). This run will scan but make no posts. " +
        "Set ALLOW_EXTERNAL_WRITES=1 to force real writes against the configured Discord token.",
    );
  }
  const r = await runMissionThreadBackfill();
  console.log(
    `Done. Scanned ${r.scanned} open mission(s) missing a thread; ` +
      `created ${r.created} thread(s), seeded ${r.seeded} snapshot(s), failed ${r.failed}.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error("backfill-mission-threads failed:", err);
  process.exit(1);
});
