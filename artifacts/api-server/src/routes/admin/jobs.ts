import type { IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, jobRuns } from "@workspace/db";
import { runJob } from "../../lib/jobs";
import { adminOnly } from "./shared";

export function registerJobs(router: IRouter): void {
  router.get("/admin/jobs", adminOnly, async (_req, res): Promise<void> => {
    const rows = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(50);
    res.json(rows);
  });

  router.post("/admin/jobs/run", adminOnly, async (req, res): Promise<void> => {
    const job = String(req.body?.job ?? "");
    if (!["cyberware_humanity", "monthly_rent", "role_sync", "eviction_sweep", "discord_event_sync", "main_session_backfill", "mission_thread_backfill", "notification_prune", "character_snapshot", "session_reset"].includes(job)) {
      res.status(400).json({ error: "Unknown job" });
      return;
    }
    const result = await runJob(job as "cyberware_humanity" | "monthly_rent" | "role_sync" | "eviction_sweep" | "discord_event_sync" | "main_session_backfill" | "mission_thread_backfill" | "notification_prune" | "character_snapshot" | "session_reset");
    res.json(result);
  });
}
