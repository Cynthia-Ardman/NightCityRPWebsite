import { and, eq, lt } from "drizzle-orm";
import { db, pool, missions } from "@workspace/db";

/**
 * ONE-TIME backfill to run when the mission workflow feature (Task #62) is
 * deployed to a database that already holds missions.
 *
 * The new `workflow_state` column is added with a `draft` default, so on schema
 * push every existing row silently becomes `draft` — which hides it from
 * players. Those rows are all pre-feature missions that were already live, so
 * they must be flipped to `posted`.
 *
 * Safety / rerunnability: we anchor to a FIXED cutoff (the feature's deploy
 * timestamp), NOT "now". Only missions created before the cutoff are touched,
 * so any genuine drafts created after the feature shipped are never clobbered,
 * no matter when (or how often) this script runs.
 *
 * Set FEATURE_DEPLOY_CUTOFF to the deploy time (ISO 8601) before running, e.g.:
 *   FEATURE_DEPLOY_CUTOFF=2026-05-29T00:00:00Z \
 *     pnpm --filter scripts exec tsx src/backfill-mission-workflow-state.ts
 */

const CUTOFF_ENV = process.env.FEATURE_DEPLOY_CUTOFF;

async function main() {
  if (!CUTOFF_ENV) {
    console.error(
      "Refusing to run: set FEATURE_DEPLOY_CUTOFF to the feature deploy time (ISO 8601),\n" +
        "e.g. FEATURE_DEPLOY_CUTOFF=2026-05-29T00:00:00Z. This anchors the backfill so\n" +
        "drafts created after the feature shipped are never affected on reruns.",
    );
    process.exitCode = 1;
    return;
  }
  const cutoff = new Date(CUTOFF_ENV);
  if (Number.isNaN(cutoff.getTime())) {
    console.error(`Invalid FEATURE_DEPLOY_CUTOFF: ${CUTOFF_ENV}`);
    process.exitCode = 1;
    return;
  }

  const where = and(eq(missions.workflowState, "draft"), lt(missions.createdAt, cutoff));

  const stale = await db.select({ id: missions.id }).from(missions).where(where);
  console.log(`Pre-feature missions (created before ${cutoff.toISOString()}) to backfill -> posted: ${stale.length}`);
  if (stale.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const updated = await db
    .update(missions)
    .set({ workflowState: "posted" })
    .where(where)
    .returning({ id: missions.id });

  console.log(`Updated ${updated.length} mission(s) to workflow_state='posted'.`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
