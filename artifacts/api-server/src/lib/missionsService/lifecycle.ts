import type { Request } from "express";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, missions, type Mission } from "@workspace/db";
import { logger } from "../logger";
import { recordAudit } from "../audit";
import {
  postToChannel,
  deleteGuildScheduledEvent,
  listGuildScheduledEvents,
} from "../discord";
import { getMissionContext } from "../missionsConfig";
import { buildMissionUrl, type MissionViewer } from "./statuses";
import { syncMissionDiscordEvent } from "./discordSync";

// ===========================================================================
// WORKFLOW TRANSITIONS (Task #62) — draft → proposal → approved → posted.
// ===========================================================================

export type TransitionResult =
  | { ok: true }
  | { ok: false; error: string; httpStatus: number };

/** Fixer submits a draft for staff review (draft → proposal). */
export async function submitMissionProposal(missionId: number, viewer: MissionViewer, req?: Request): Promise<TransitionResult> {
  const [m] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!m) return { ok: false, error: "Mission not found", httpStatus: 404 };
  // Trial fixers may only submit missions they personally own; full managers
  // may submit any draft.
  if (!viewer.isManager && m.fixerId !== viewer.id) {
    return { ok: false, error: "You can only submit your own missions", httpStatus: 403 };
  }
  if (m.workflowState !== "draft") {
    return { ok: false, error: `Can only submit a draft (current: ${m.workflowState})`, httpStatus: 409 };
  }
  // Job Type is a required field for a real mission; enforce it at the gate so a
  // draft can't advance into the approval pipeline without one.
  if (!m.jobType) {
    return { ok: false, error: "Job Type is required before submitting for approval", httpStatus: 400 };
  }
  await db
    .update(missions)
    .set({ workflowState: "proposal", updatedAt: new Date() })
    .where(eq(missions.id, missionId));
  await recordAudit({
    req,
    actorId: viewer.id,
    action: "mission_submitted",
    category: "mission",
    targetType: "mission",
    targetId: String(missionId),
    message: `Submitted mission "${m.title}" as a proposal`,
  });
  return { ok: true };
}

/**
 * Permanently delete a DRAFT mission. Owning trial fixer or any manager; only
 * drafts can be hard-deleted — anything further along its lifecycle must be
 * cancelled (status='cancelled') instead so its history/Discord event survive.
 * FK children (assignments, applications, NPC sign-ups, breach puzzles) cascade.
 */
export async function deleteMission(missionId: number, viewer: MissionViewer, req?: Request): Promise<TransitionResult> {
  // Lock the row and re-check the draft gate inside the transaction so a
  // concurrent submit (draft → proposal) can't slip past a stale read and let
  // us hard-delete a mission that just advanced in its lifecycle.
  let deletedTitle: string | null = null;
  const result = await db.transaction(async (tx): Promise<TransitionResult> => {
    const [m] = await tx
      .select()
      .from(missions)
      .where(eq(missions.id, missionId))
      .for("update");
    if (!m) return { ok: false, error: "Mission not found", httpStatus: 404 };
    // Trial fixers may only delete missions they personally own; full managers
    // may delete any draft.
    if (!viewer.isManager && m.fixerId !== viewer.id) {
      return { ok: false, error: "You can only delete your own missions", httpStatus: 403 };
    }
    if (m.workflowState !== "draft") {
      return {
        ok: false,
        error: `Only draft missions can be deleted (current: ${m.workflowState}). Cancel it instead.`,
        httpStatus: 409,
      };
    }
    await tx.delete(missions).where(eq(missions.id, missionId));
    deletedTitle = m.title;
    return { ok: true };
  });
  if (result.ok) {
    await recordAudit({
      req,
      actorId: viewer.id,
      action: "mission_deleted",
      category: "mission",
      targetType: "mission",
      targetId: String(missionId),
      message: `Deleted draft mission "${deletedTitle ?? missionId}"`,
    });
  }
  return result;
}

/** Archivist/admin approves a proposal (proposal → approved). */
export async function approveMission(missionId: number, viewer: MissionViewer, req?: Request): Promise<TransitionResult> {
  const [m] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!m) return { ok: false, error: "Mission not found", httpStatus: 404 };
  if (m.workflowState !== "proposal") {
    return { ok: false, error: `Can only approve a proposal (current: ${m.workflowState})`, httpStatus: 409 };
  }
  await db
    .update(missions)
    .set({ workflowState: "approved", updatedAt: new Date() })
    .where(eq(missions.id, missionId));
  await recordAudit({
    req,
    actorId: viewer.id,
    action: "mission_approved",
    category: "mission",
    targetType: "mission",
    targetId: String(missionId),
    message: `Approved mission "${m.title}"`,
  });
  // Approval publishes the mission to the public board in one step: an archivist
  // (or admin) approves from the Pending Requests queue and the mission goes
  // live (Open) immediately, without a separate manual "post" action.
  return postMission(missionId, viewer, req);
}

/**
 * Post an approved mission: make it public (workflowState → posted), open it for
 * play (status → open), and sync the Discord event. Audit-logged.
 */
export async function postMission(missionId: number, viewer: MissionViewer, req?: Request): Promise<TransitionResult> {
  const [m] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!m) return { ok: false, error: "Mission not found", httpStatus: 404 };
  if (m.workflowState !== "approved") {
    return { ok: false, error: `Can only post an approved mission (current: ${m.workflowState})`, httpStatus: 409 };
  }
  const nextStatus = m.status === "cancelled" ? "open" : m.status === "open" ? m.status : "open";
  const updated: Mission = { ...m, workflowState: "posted", status: nextStatus };
  const ctx = await getMissionContext();
  // Atomically claim the approved→posted transition: the conditional WHERE
  // guards against two concurrent post/approve requests both passing the read
  // check above and each firing the Discord event + sign-up announcement. Only
  // the request that flips the row proceeds with side effects.
  const claimed = await db
    .update(missions)
    .set({ workflowState: "posted", status: nextStatus, updatedAt: new Date() })
    .where(and(eq(missions.id, missionId), eq(missions.workflowState, "approved")))
    .returning({ id: missions.id });
  if (claimed.length === 0) {
    return { ok: false, error: "Mission was already posted", httpStatus: 409 };
  }
  const sync = await syncMissionDiscordEvent(updated, ctx, m.imageUrl);
  // Persist the Discord sync result only while the mission is still posted: a
  // concurrent revert-to-draft can win the row back while we were talking to
  // Discord, and drafts must never own a scheduled event. If we lost the race,
  // tear down whatever event we just created so it isn't orphaned.
  const persisted = await db
    .update(missions)
    .set({
      discordEventId: sync.discordEventId,
      discordSyncError: sync.discordSyncError,
      updatedAt: new Date(),
    })
    .where(and(eq(missions.id, missionId), eq(missions.workflowState, "posted")))
    .returning({ id: missions.id });
  if (persisted.length === 0) {
    if (sync.discordEventId && ctx.live) {
      try {
        await deleteGuildScheduledEvent(sync.discordEventId);
      } catch (err) {
        logger.error({ err, missionId, eventId: sync.discordEventId }, "Failed to tear down orphaned mission event after lost post race");
      }
    }
    return { ok: false, error: "Mission changed state while posting — refresh and try again", httpStatus: 409 };
  }
  await recordAudit({
    req,
    actorId: viewer.id,
    action: "mission_posted",
    category: "mission",
    targetType: "mission",
    targetId: String(missionId),
    message: `Posted mission "${m.title}" to the public board`,
  });
  // Announce the newly opened mission (with a link) to the sign-up channel so
  // players know it's accepting PC applications. Live-gated and fail-safe: a
  // delivery miss never blocks the post action (postToChannel also no-ops
  // outside deployments). Only announce when the mission is actually open —
  // and never for private missions (they exist only for staff + roster).
  // Re-read visibility AFTER the posted claim: a concurrent PATCH could flip
  // the mission private while we were syncing Discord, and the stale pre-claim
  // row must not leak a public sign-up announcement.
  const [fresh] = await db
    .select({ visibility: missions.visibility })
    .from(missions)
    .where(eq(missions.id, missionId));
  if (nextStatus === "open" && (fresh?.visibility ?? m.visibility) !== "private") {
    const url = buildMissionUrl(missionId);
    const content = `**New mission open for sign-ups — ${m.title}**\n${url}`;
    try {
      if (ctx.live) {
        await postToChannel(ctx.signupChannelId, content);
      } else {
        logger.info(
          { missionId, channel: ctx.signupChannelId },
          "[test mode] would post mission sign-up announcement",
        );
      }
    } catch (err) {
      logger.error({ err, missionId }, "Mission sign-up announcement failed");
    }
  }
  return { ok: true };
}

/**
 * Return an approved/posted mission to DRAFT so the fixer can rework it and
 * resubmit through the approval pipeline. Tears down the public Discord
 * scheduled event (drafts are staff-only and never own one); application and
 * roster rows are kept as-is — they simply become visible again if the mission
 * is later re-approved and re-posted. Completed or cancelled missions cannot
 * be reverted (un-complete or leave cancelled history intact instead).
 */
export async function revertMissionToDraft(missionId: number, viewer: MissionViewer, req?: Request): Promise<TransitionResult> {
  const [m] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!m) return { ok: false, error: "Mission not found", httpStatus: 404 };
  if (m.workflowState !== "approved" && m.workflowState !== "posted") {
    return {
      ok: false,
      error: `Only an approved or posted mission can be returned to draft (current: ${m.workflowState})`,
      httpStatus: 409,
    };
  }
  if (m.completedAt) {
    return { ok: false, error: "This mission is completed — un-complete it before returning it to draft", httpStatus: 409 };
  }
  if (m.status === "cancelled") {
    return { ok: false, error: "Cancelled missions cannot be returned to draft", httpStatus: 409 };
  }
  // Atomically claim the transition (mirrors postMission): the conditional
  // WHERE re-checks every guard so a concurrent complete/cancel/post can't
  // slip past the reads above and get silently clobbered back to draft.
  const claimed = await db
    .update(missions)
    .set({ workflowState: "draft", status: "open", updatedAt: new Date() })
    .where(
      and(
        eq(missions.id, missionId),
        inArray(missions.workflowState, ["approved", "posted"]),
        isNull(missions.completedAt),
        ne(missions.status, "cancelled"),
      ),
    )
    .returning({ id: missions.id });
  if (claimed.length === 0) {
    return { ok: false, error: "Mission changed state — refresh and try again", httpStatus: 409 };
  }
  // Drafts never own a Discord scheduled event: sync against the new draft
  // state tears down any existing event (live-gated, never throws). Re-read
  // the row AFTER the claim — a concurrent postMission may have persisted a
  // discordEventId between our initial read and the claim, and syncing from
  // the stale snapshot would skip the teardown entirely.
  const [fresh] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!fresh) return { ok: false, error: "Mission not found", httpStatus: 404 };
  const ctx = await getMissionContext();
  const sync = await syncMissionDiscordEvent(fresh, ctx, fresh.imageUrl);
  if (sync.discordEventId !== fresh.discordEventId || sync.discordSyncError !== fresh.discordSyncError) {
    // Conditional on still being a draft so we never clobber the event id of
    // a mission that has already raced forward through re-approval.
    await db
      .update(missions)
      .set({ discordEventId: sync.discordEventId, discordSyncError: sync.discordSyncError, updatedAt: new Date() })
      .where(and(eq(missions.id, missionId), eq(missions.workflowState, "draft")));
  }
  await recordAudit({
    req,
    actorId: viewer.id,
    action: "mission_reverted_to_draft",
    category: "mission",
    targetType: "mission",
    targetId: String(missionId),
    message: `Returned mission "${m.title}" to draft`,
  });
  return { ok: true };
}

// ===========================================================================
// DISCORD SCHEDULING CONFLICT CHECK (Task #62) — fail-safe, never blocks.
// ===========================================================================

export interface ConflictCheckResult {
  checked: boolean;
  conflicts: { id: string; name: string; startAt: string; endAt: string | null }[];
  error: string | null;
}

/**
 * Look for existing Discord scheduled events that overlap the proposed window.
 * Fail-safe: if Discord can't be reached, returns checked=false with an error
 * message for staff — it never blocks creation/rescheduling.
 */
export async function checkDiscordEventConflict(opts: {
  startAt: Date;
  durationMinutes: number;
  excludeEventId?: string | null;
}): Promise<ConflictCheckResult> {
  const res = await listGuildScheduledEvents();
  if (!res.ok) return { checked: false, conflicts: [], error: res.error };
  const start = opts.startAt.getTime();
  const end = start + Math.max(1, opts.durationMinutes) * 60_000;
  const conflicts = res.events
    .filter((e) => e.id !== opts.excludeEventId)
    .map((e) => {
      const eStart = new Date(e.scheduledStartTime).getTime();
      const eEnd = e.scheduledEndTime ? new Date(e.scheduledEndTime).getTime() : eStart + 60 * 60_000;
      return { e, eStart, eEnd };
    })
    .filter(({ eStart, eEnd }) => eStart < end && eEnd > start)
    .map(({ e }) => ({
      id: e.id,
      name: e.name,
      startAt: e.scheduledStartTime,
      endAt: e.scheduledEndTime,
    }));
  return { checked: true, conflicts, error: null };
}
