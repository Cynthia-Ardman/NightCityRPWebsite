import { and, or, eq, gt, lte, inArray, notInArray, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { db, missions, type Mission } from "@workspace/db";
import { logger } from "../logger";
import {
  postToChannel,
  createGuildScheduledEvent,
  modifyGuildScheduledEvent,
  deleteGuildScheduledEvent,
} from "../discord";
import { getMissionContext, type MissionExternalContext } from "../missionsConfig";
import {
  resolveAbsoluteImageUrl,
  HISTORY_STATUSES,
  ensureMissionThread,
  buildMissionThreadSnapshot,
  sleep,
  jobTypeLabel,
  eventTitle,
} from "./internal";

/**
 * Fire-and-forget wrapper used at mission creation: post the brief + start the
 * discussion thread. Never throws — a Discord miss must not block creation.
 */
export async function announceMissionThread(m: Mission, channelId: string): Promise<void> {
  try {
    await ensureMissionThread(m, channelId);
  } catch (err) {
    logger.warn({ err, missionId: m.id }, "announceMissionThread failed");
  }
}

/**
 * Backfill discussion threads for every currently-open mission.
 *
 * Walks posted, non-completed, non-cancelled missions whose Discord thread OR
 * its current-state snapshot is still missing, ensures each gets a thread
 * (idempotently — see ensureMissionThread), then posts a single consolidated
 * current-state snapshot (roster + pending applicants + active NPC sign-ups,
 * mentions suppressed) into the thread. Deployment-gated via the post helpers (a
 * pure no-op in the dev workspace unless ALLOW_EXTERNAL_WRITES=1).
 *
 * Restartable / honest accounting: a thread is only ever created once (the row's
 * discordThreadId gates that), and the snapshot is gated separately on
 * discordThreadSnapshotAt. Crucially, postToChannel returns null (it does NOT
 * throw) on a rate-limit / permission / transient failure, so the snapshot
 * marker is set ONLY when it returns a real message id — a failed post is left
 * un-marked and re-attempted on the next run rather than silently counted as
 * seeded. A short delay between writes keeps the run under Discord's rate limits.
 */
// Shared target query for the backfill run AND the admin maintenance dry-run,
// so the preview always matches exactly what a live run would touch.
export async function listMissionThreadBackfillTargets(limit = 500): Promise<Mission[]> {
  return db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.workflowState, "posted"),
        // Private missions never get a public forum thread.
        ne(missions.visibility, "private"),
        notInArray(missions.status, HISTORY_STATUSES),
        // Needs a thread, or has one but no snapshot yet (retry partial failures).
        or(isNull(missions.discordThreadId), isNull(missions.discordThreadSnapshotAt)),
      ),
    )
    .orderBy(missions.id)
    .limit(limit);
}

export async function runMissionThreadBackfill(opts: { limit?: number } = {}): Promise<{
  scanned: number;
  created: number;
  seeded: number;
  failed: number;
}> {
  const ctx = await getMissionContext();
  const targets = await listMissionThreadBackfillTargets(opts.limit ?? 500);

  let scanned = 0;
  let created = 0;
  let seeded = 0;
  let failed = 0;
  for (const m of targets) {
    scanned += 1;
    let wrote = false;
    try {
      const r = await ensureMissionThread(m, ctx.threadChannelId);
      if (r.created) created += 1;
      // No thread id => writes are suppressed (dev/test) or the thread couldn't
      // be created this run; nothing to seed, leave the row for a later run.
      if (!r.threadId) continue;
      wrote = r.created;
      // Seed the snapshot only when it hasn't been recorded yet.
      if (!m.discordThreadSnapshotAt) {
        const snapshot = await buildMissionThreadSnapshot(m.id);
        const snapId = await postToChannel(r.threadId, snapshot, undefined, { parse: [] });
        if (snapId) {
          // Mark ONLY on a confirmed post id (postToChannel returns null, not a
          // throw, on failure) so a rejected post is retried next run.
          await db.update(missions).set({ discordThreadSnapshotAt: new Date() }).where(eq(missions.id, m.id));
          seeded += 1;
          wrote = true;
        } else {
          failed += 1;
          logger.warn({ missionId: m.id }, "mission thread snapshot post returned no id; will retry next run");
        }
      }
    } catch (err) {
      failed += 1;
      logger.error({ err, missionId: m.id }, "mission thread backfill failed");
    }
    // Throttle only when real writes actually happened (a no-op dev run skips this).
    if (wrote) await sleep(1200);
  }
  return { scanned, created, seeded, failed };
}

/**
 * Find posted, non-cancelled missions starting within the next hour that
 * haven't been announced yet, and post an "actors needed" call to the NPC
 * announcement channel. In Test mode it logs instead of posting. Idempotent.
 */
export async function runMissionNpcAnnouncements(): Promise<{ announced: number }> {
  const ctx = await getMissionContext();
  const now = new Date();
  const horizon = new Date(now.getTime() + 60 * 60_000);
  const due = await db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.workflowState, "posted"),
        ne(missions.status, "cancelled"),
        // Private missions never fire public "actors needed" calls.
        ne(missions.visibility, "private"),
        isNull(missions.npcAnnouncedAt),
        isNotNull(missions.startAt),
        // NPCs may be asked to gather earlier than the player start; announce
        // ~1h before whichever time NPCs actually need to show up.
        gt(sql`coalesce(${missions.npcStartAt}, ${missions.startAt})`, now),
        lte(sql`coalesce(${missions.npcStartAt}, ${missions.startAt})`, horizon),
      ),
    );
  let announced = 0;
  for (const m of due) {
    const npcStart = m.npcStartAt ?? m.startAt;
    const startUnix = npcStart ? Math.floor(npcStart.getTime() / 1000) : null;
    const lines = [
      `**Actors Needed — ${m.title}**`,
      m.jobType ? `Job type: ${jobTypeLabel(m.jobType)}` : null,
      m.location ? `Location: ${m.location}` : null,
      startUnix ? `${m.npcStartAt ? "NPCs gather" : "Starts"}: <t:${startUnix}:R>` : null,
      m.requestedSkills ? `Requested skills: ${m.requestedSkills}` : null,
      `React or reach out to the fixer if you can NPC for this mission.`,
    ].filter(Boolean);
    const content = lines.join("\n");
    try {
      if (ctx.live) {
        await postToChannel(ctx.npcAnnouncementChannelId, content);
      } else {
        logger.info({ missionId: m.id, channel: ctx.npcAnnouncementChannelId }, "[test mode] would post NPC announcement");
      }
      await db
        .update(missions)
        .set({ npcAnnouncedAt: new Date() })
        .where(eq(missions.id, m.id));
      announced += 1;
    } catch (err) {
      logger.error({ err, missionId: m.id }, "NPC announcement failed");
    }
  }
  return { announced };
}

// ===========================================================================
// DISCORD EVENT SYNC (gated by Test/Live mode)
// ===========================================================================

/**
 * Create/update/delete the linked Discord scheduled event to match the
 * mission's current state. Always routed through the Test/Live gate: in Test
 * mode nothing fires and any stale event id is left as-is. Never throws —
 * failures are persisted to `discordSyncError` for staff and returned.
 */
export async function syncMissionDiscordEvent(
  mission: Mission,
  ctx: MissionExternalContext,
  imageUrl: string | null,
): Promise<{ discordEventId: string | null; discordSyncError: string | null }> {
  // Test mode: do not touch Discord at all.
  if (!ctx.live) {
    return { discordEventId: mission.discordEventId, discordSyncError: null };
  }

  // Only POSTED, PUBLIC missions appear publicly and own a Discord event.
  // Drafts / proposals / approved missions stay off Discord until the fixer
  // posts them, even if a start time is already set. Private missions never
  // get a Discord event (and flipping a posted mission to private tears an
  // existing one down).
  const shouldExist =
    mission.workflowState === "posted" &&
    mission.status !== "cancelled" &&
    mission.visibility !== "private" &&
    !!mission.startAt;

  // Cancelled or unscheduled: tear down any existing event.
  if (!shouldExist) {
    if (!mission.discordEventId) return { discordEventId: null, discordSyncError: null };
    const res = await deleteGuildScheduledEvent(mission.discordEventId);
    return res.ok
      ? { discordEventId: null, discordSyncError: null }
      : { discordEventId: mission.discordEventId, discordSyncError: res.error };
  }

  // The Discord scheduled event is the "Actors Needed" call, so it starts at
  // the NPC gather time when one is set (never later than the mission start).
  const missionStart = mission.startAt!;
  const startAt =
    mission.npcStartAt && mission.npcStartAt.getTime() < missionStart.getTime() ? mission.npcStartAt : missionStart;
  const endAt = new Date(missionStart.getTime() + Math.max(1, mission.durationMinutes) * 60_000);
  const input = {
    name: eventTitle(mission.title),
    description: mission.description ?? null,
    location: mission.location ?? "Night City",
    startAt,
    endAt,
    imageUrl: resolveAbsoluteImageUrl(imageUrl),
  };

  // Update existing or create new.
  const res = mission.discordEventId
    ? await modifyGuildScheduledEvent(mission.discordEventId, input)
    : await createGuildScheduledEvent(input);
  if (res.ok) return { discordEventId: res.id, discordSyncError: null };
  // Keep the old id on failure so a later retry can still modify it.
  return { discordEventId: mission.discordEventId, discordSyncError: res.error };
}
