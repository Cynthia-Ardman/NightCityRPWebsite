import type { Request } from "express";
import { and, eq, desc, gt, lte, inArray, isNull, isNotNull, ne, sql } from "drizzle-orm";
import {
  db,
  missions,
  missionAssignments,
  missionActorPayments,
  missionApplications,
  characters,
  users,
  type Mission,
} from "@workspace/db";
import { logger } from "./logger";
import { recordAudit } from "./audit";
import { patchBalance } from "./unbelievaboat";
import {
  postToChannel,
  createGuildScheduledEvent,
  modifyGuildScheduledEvent,
  deleteGuildScheduledEvent,
  listGuildScheduledEvents,
} from "./discord";
import { getMissionContext, type MissionExternalContext } from "./missionsConfig";

// ---------------------------------------------------------------------------
// Workflow state (Task #62) — staff approval pipeline, SEPARATE from runtime
// status. draft → proposal → approved → posted. Only `posted` missions are
// visible to regular players.
// ---------------------------------------------------------------------------
export const WORKFLOW_STATES = ["draft", "proposal", "approved", "posted"] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];
export function isWorkflowState(s: unknown): s is WorkflowState {
  return typeof s === "string" && (WORKFLOW_STATES as readonly string[]).includes(s);
}

export const JOB_TYPES = ["combat", "non_combat", "mixed"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export function isJobType(s: unknown): s is JobType {
  return typeof s === "string" && (JOB_TYPES as readonly string[]).includes(s);
}

// Recommended spacing between a character's missions. Attendance more recent
// than this triggers a (non-blocking) recency warning during application review.
export const RECENCY_WARNING_DAYS = 21;

// ---------------------------------------------------------------------------
// Mission status lifecycle (Task #57).
//   open → pending → completed → completed_players_paid → completed_paid
//   cancelled (terminal, reachable from anywhere)
// Player/actor payments advance the "completed_*" sub-states; the earlier
// transitions are driven by the fixer (or the auto-pay cron flipping a ran
// mission to completed before paying players).
// ---------------------------------------------------------------------------
export const MISSION_STATUSES = [
  "open",
  "pending",
  "completed",
  "completed_players_paid",
  "completed_paid",
  "cancelled",
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export function isMissionStatus(s: unknown): s is MissionStatus {
  return typeof s === "string" && (MISSION_STATUSES as readonly string[]).includes(s);
}

const DESCRIPTION_PREVIEW_LEN = 160;

function preview(s: string | null): string | null {
  if (!s) return s;
  const t = s.trim();
  if (t.length <= DESCRIPTION_PREVIEW_LEN) return t;
  return `${t.slice(0, DESCRIPTION_PREVIEW_LEN - 1).trimEnd()}…`;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// --- Discord cover-image URL resolution ------------------------------------
// Mission images are stored as app-relative paths (e.g.
// "/api/storage/objects/<id>"). Discord needs an absolute, fetchable URL, so
// we prefix relative paths with PUBLIC_BASE_URL. Absolute http(s) URLs pass
// through untouched; anything we can't resolve becomes null (no cover image).
function resolveAbsoluteImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base) return null;
  return `${base}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

// ===========================================================================
// VIEW BUILDERS
// ===========================================================================

export interface MissionViewer {
  id: string;
  isManager: boolean; // fixer or admin
  isAdmin: boolean;
  isArchivist: boolean; // archivist or admin (can approve proposals)
}

type AssignmentJoin = {
  id: number;
  userId: string;
  userName: string | null;
  userAvatarUrl: string | null;
  characterId: number | null;
  characterName: string | null;
  characterPortraitUrl: string | null;
  attendanceCreditedAt: Date | null;
  paymentStatus: string;
  payAmount: number | null;
  paymentError: string | null;
  paidAt: Date | null;
};

async function loadAssignments(missionIds: number[]): Promise<Map<number, AssignmentJoin[]>> {
  const out = new Map<number, AssignmentJoin[]>();
  if (missionIds.length === 0) return out;
  const rows = await db
    .select({
      missionId: missionAssignments.missionId,
      id: missionAssignments.id,
      userId: missionAssignments.userId,
      userName: users.username,
      userAvatarUrl: users.avatarUrl,
      characterId: missionAssignments.characterId,
      characterName: characters.name,
      characterPortraitUrl: characters.portraitUrl,
      attendanceCreditedAt: missionAssignments.attendanceCreditedAt,
      paymentStatus: missionAssignments.paymentStatus,
      payAmount: missionAssignments.payAmount,
      paymentError: missionAssignments.paymentError,
      paidAt: missionAssignments.paidAt,
    })
    .from(missionAssignments)
    .leftJoin(users, eq(users.id, missionAssignments.userId))
    .leftJoin(characters, eq(characters.id, missionAssignments.characterId))
    .where(inArray(missionAssignments.missionId, missionIds))
    .orderBy(missionAssignments.id);
  for (const r of rows) {
    const { missionId, ...rest } = r;
    if (!out.has(missionId)) out.set(missionId, []);
    out.get(missionId)!.push(rest);
  }
  return out;
}

type MissionWithFixer = Mission & { fixerName: string | null; fixerAvatarUrl: string | null };

async function loadMissions(where: ReturnType<typeof eq> | undefined, limit?: number): Promise<MissionWithFixer[]> {
  let q = db
    .select({
      mission: missions,
      fixerName: users.username,
      fixerAvatarUrl: users.avatarUrl,
    })
    .from(missions)
    .leftJoin(users, eq(users.id, missions.fixerId))
    .orderBy(desc(missions.startAt), desc(missions.createdAt))
    .$dynamic();
  if (where) q = q.where(where);
  if (limit) q = q.limit(limit);
  const rows = await q;
  return rows.map((r) => ({ ...r.mission, fixerName: r.fixerName, fixerAvatarUrl: r.fixerAvatarUrl }));
}

function toSummary(m: MissionWithFixer, assignments: AssignmentJoin[], viewerId: string) {
  const players = assignments
    .filter((a) => a.characterId != null)
    .map((a) => ({
      characterId: a.characterId!,
      name: a.characterName ?? "(unknown)",
      portraitUrl: a.characterPortraitUrl,
      userId: a.userId,
    }));
  const mine = assignments.find((a) => a.userId === viewerId);
  return {
    id: m.id,
    title: m.title,
    tier: m.tier,
    status: m.status,
    workflowState: m.workflowState,
    startAt: iso(m.startAt),
    durationMinutes: m.durationMinutes,
    location: m.location,
    descriptionPreview: preview(m.description),
    imageUrl: m.imageUrl,
    playerPay: m.playerPay,
    slots: m.slots,
    jobType: m.jobType,
    requestedSkills: m.requestedSkills,
    client: m.client,
    maxPlayers: m.maxPlayers,
    assignedCount: assignments.length,
    fixerId: m.fixerId,
    fixerName: m.fixerName,
    fixerAvatarUrl: m.fixerAvatarUrl,
    discordEventId: m.discordEventId,
    discordSyncError: m.discordSyncError,
    myCharacterId: mine?.characterId ?? null,
    myCharacterName: mine?.characterName ?? null,
    myPaymentStatus: mine?.paymentStatus ?? null,
    players,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function listMissionSummaries(opts: {
  viewer: MissionViewer;
  status?: string;
  limit?: number;
}) {
  const filters = [];
  if (opts.status && isMissionStatus(opts.status)) filters.push(eq(missions.status, opts.status));
  // Visibility: regular players only ever see Posted missions. Managers
  // (fixers/admins) see the full pipeline so they can shepherd drafts.
  if (!opts.viewer.isManager) filters.push(eq(missions.workflowState, "posted"));
  const where = filters.length ? and(...filters) : undefined;
  const rows = await loadMissions(where, opts.limit ?? 200);
  const byMission = await loadAssignments(rows.map((r) => r.id));
  return rows.map((m) => toSummary(m, byMission.get(m.id) ?? [], opts.viewer.id));
}

/**
 * Missions the caller owns/oversees, for the "My Missions" board grouped by
 * workflow state. Fixers see missions they're the fixer of; admins see all.
 */
export async function listOwnedMissionSummaries(viewer: MissionViewer) {
  // Admins and archivists (approvers) see every mission so they can find
  // proposals awaiting review; plain fixers see only their own.
  const where = viewer.isAdmin || viewer.isArchivist ? undefined : eq(missions.fixerId, viewer.id);
  const rows = await loadMissions(where);
  const byMission = await loadAssignments(rows.map((r) => r.id));
  return rows.map((m) => toSummary(m, byMission.get(m.id) ?? [], viewer.id));
}

/** Missions the caller is assigned to that are not cancelled/fully closed. */
export async function listMyMissionSummaries(viewer: MissionViewer) {
  const mine = await db
    .select({ missionId: missionAssignments.missionId })
    .from(missionAssignments)
    .where(eq(missionAssignments.userId, viewer.id));
  const ids = [...new Set(mine.map((m) => m.missionId))];
  if (ids.length === 0) return [];
  // Non-managers must never see non-posted missions, even ones they were
  // assigned to before posting — the draft pipeline is staff-internal.
  const rows = (await loadMissions(undefined)).filter(
    (m) =>
      ids.includes(m.id) &&
      m.status !== "cancelled" &&
      (viewer.isManager || m.workflowState === "posted"),
  );
  const byMission = await loadAssignments(rows.map((r) => r.id));
  return rows.map((m) => toSummary(m, byMission.get(m.id) ?? [], viewer.id));
}

/**
 * Application data (the applicant pool, accept/reject) is private to the
 * mission's own fixer and to admins. Other fixers must not see or act on
 * another fixer's applications. `fixerId` may be null (unclaimed mission) — in
 * that case only an admin qualifies.
 */
function ownsMissionApplications(viewer: MissionViewer, fixerId: string | null): boolean {
  return viewer.isAdmin || (fixerId != null && fixerId === viewer.id);
}

export async function getMissionDetail(missionId: number, viewer: MissionViewer) {
  const rows = await loadMissions(eq(missions.id, missionId));
  const m = rows[0];
  if (!m) return null;
  const canManage = viewer.isManager;
  // Visibility: regular players only see Posted missions (the draft pipeline is
  // staff-internal). Archivists are approvers, so they must be able to view a
  // non-posted mission to approve it — even though they don't get fixer tools.
  if (!canManage && !viewer.isArchivist && m.workflowState !== "posted") return null;
  const ctx = await getMissionContext();
  const assignments = (await loadAssignments([missionId])).get(missionId) ?? [];
  const actorRows = await db
    .select({
      id: missionActorPayments.id,
      userId: missionActorPayments.userId,
      userName: missionActorPayments.userName,
      characterId: missionActorPayments.characterId,
      characterName: missionActorPayments.characterName,
      amount: missionActorPayments.amount,
      paymentStatus: missionActorPayments.paymentStatus,
      source: missionActorPayments.source,
      paymentError: missionActorPayments.paymentError,
      paidAt: missionActorPayments.paidAt,
      createdAt: missionActorPayments.createdAt,
    })
    .from(missionActorPayments)
    .where(eq(missionActorPayments.missionId, missionId))
    .orderBy(desc(missionActorPayments.createdAt));

  // Applications are private to the mission's OWNING fixer (or any admin) — a
  // different fixer must not see another fixer's applicant pool. Everyone else
  // (players, non-owning fixers) only gets their own application echoed back.
  const managesApplications = ownsMissionApplications(viewer, m.fixerId);
  const applications = managesApplications ? await listApplicationViews(missionId) : [];
  const myApplication = managesApplications
    ? null
    : (await listApplicationViews(missionId, viewer.id))[0] ?? null;

  return {
    id: m.id,
    title: m.title,
    tier: m.tier,
    status: m.status,
    workflowState: m.workflowState,
    startAt: iso(m.startAt),
    durationMinutes: m.durationMinutes,
    location: m.location,
    description: m.description,
    imageUrl: m.imageUrl,
    playerPay: m.playerPay,
    slots: m.slots,
    jobType: m.jobType,
    requestedSkills: m.requestedSkills,
    client: m.client,
    notesForPlayers: m.notesForPlayers,
    maxPlayers: m.maxPlayers,
    // World Link is an OOC staff planning doc: visible to fixers/admins AND to
    // archivist approvers (who review non-posted missions), never to players.
    worldLink: canManage || viewer.isArchivist ? m.worldLink : null,
    fixerId: m.fixerId,
    fixerName: m.fixerName,
    fixerAvatarUrl: m.fixerAvatarUrl,
    discordEventId: m.discordEventId,
    discordSyncError: m.discordSyncError,
    canManage,
    canApprove: viewer.isArchivist,
    live: ctx.live,
    applications,
    myApplication,
    assignments: assignments.map((a) => ({
      id: a.id,
      userId: a.userId,
      userName: a.userName,
      userAvatarUrl: a.userAvatarUrl,
      characterId: a.characterId,
      characterName: a.characterName,
      characterPortraitUrl: a.characterPortraitUrl,
      attendanceCreditedAt: iso(a.attendanceCreditedAt),
      paymentStatus: a.paymentStatus,
      // Money detail is fixer-only; players see their own row in full but
      // not other players' amounts/errors.
      payAmount: canManage || a.userId === viewer.id ? a.payAmount : null,
      paymentError: canManage || a.userId === viewer.id ? a.paymentError : null,
      paidAt: iso(a.paidAt),
    })),
    actorPayments: canManage
      ? actorRows.map((r) => ({
          id: r.id,
          userId: r.userId,
          userName: r.userName,
          characterId: r.characterId,
          characterName: r.characterName,
          amount: r.amount,
          paymentStatus: r.paymentStatus,
          source: r.source,
          paymentError: r.paymentError,
          paidAt: iso(r.paidAt),
          createdAt: r.createdAt.toISOString(),
        }))
      : [],
    createdAt: m.createdAt.toISOString(),
    updatedAt: iso(m.updatedAt),
  };
}

// ===========================================================================
// APPLICATIONS (Task #62) — players apply with one of their own characters;
// fixers review and accept (which assigns the player) or reject.
// ===========================================================================

/**
 * Per-character recency: most recent credited attendance (excluding the given
 * mission) and total credited-attendance count. Used for the non-blocking
 * "played recently" warning shown to fixers during application review.
 */
async function loadRecencyByCharacter(
  characterIds: number[],
  excludeMissionId: number,
): Promise<Map<number, { lastAttendedAt: Date | null; attendanceCount: number }>> {
  const out = new Map<number, { lastAttendedAt: Date | null; attendanceCount: number }>();
  if (characterIds.length === 0) return out;
  const rows = await db
    .select({
      characterId: missionAssignments.characterId,
      lastAttendedAt: sql<Date | null>`max(${missionAssignments.attendanceCreditedAt})`,
      attendanceCount: sql<number>`count(${missionAssignments.attendanceCreditedAt})`,
    })
    .from(missionAssignments)
    .where(
      and(
        inArray(missionAssignments.characterId, characterIds),
        isNotNull(missionAssignments.attendanceCreditedAt),
        ne(missionAssignments.missionId, excludeMissionId),
      ),
    )
    .groupBy(missionAssignments.characterId);
  for (const r of rows) {
    if (r.characterId == null) continue;
    out.set(r.characterId, {
      lastAttendedAt: r.lastAttendedAt ? new Date(r.lastAttendedAt) : null,
      attendanceCount: Number(r.attendanceCount),
    });
  }
  return out;
}

/**
 * Build application view rows for a mission. When `onlyUserId` is given, returns
 * just that player's application (for the player's own view).
 */
async function listApplicationViews(missionId: number, onlyUserId?: string) {
  const filters = [eq(missionApplications.missionId, missionId)];
  if (onlyUserId) filters.push(eq(missionApplications.userId, onlyUserId));
  const rows = await db
    .select({
      id: missionApplications.id,
      userId: missionApplications.userId,
      userName: users.username,
      userAvatarUrl: users.avatarUrl,
      characterId: missionApplications.characterId,
      characterName: characters.name,
      characterPortraitUrl: characters.portraitUrl,
      comment: missionApplications.comment,
      status: missionApplications.status,
      reviewedBy: missionApplications.reviewedBy,
      reviewedAt: missionApplications.reviewedAt,
      createdAt: missionApplications.createdAt,
    })
    .from(missionApplications)
    .leftJoin(users, eq(users.id, missionApplications.userId))
    .leftJoin(characters, eq(characters.id, missionApplications.characterId))
    .where(and(...filters))
    .orderBy(missionApplications.createdAt);

  const recency = await loadRecencyByCharacter(
    rows.map((r) => r.characterId),
    missionId,
  );
  const now = Date.now();
  return rows.map((r) => {
    const rec = recency.get(r.characterId);
    const last = rec?.lastAttendedAt ?? null;
    const daysSince = last ? Math.floor((now - last.getTime()) / 86_400_000) : null;
    return {
      id: r.id,
      userId: r.userId,
      userName: r.userName,
      userAvatarUrl: r.userAvatarUrl,
      characterId: r.characterId,
      characterName: r.characterName,
      characterPortraitUrl: r.characterPortraitUrl,
      comment: r.comment,
      status: r.status,
      reviewedBy: r.reviewedBy,
      reviewedAt: iso(r.reviewedAt),
      createdAt: r.createdAt.toISOString(),
      attendanceCount: rec?.attendanceCount ?? 0,
      lastAttendedAt: iso(last),
      daysSinceLastMission: daysSince,
      recencyWarning: daysSince != null && daysSince < RECENCY_WARNING_DAYS,
    };
  });
}

export type ApplyResult =
  | { ok: true }
  | { ok: false; error: string; httpStatus: number };

/** Player applies to a posted mission with one of their own characters. */
export async function applyToMission(opts: {
  missionId: number;
  userId: string;
  characterId: number;
  comment?: string | null;
}): Promise<ApplyResult> {
  const [m] = await db.select().from(missions).where(eq(missions.id, opts.missionId));
  if (!m) return { ok: false, error: "Mission not found", httpStatus: 404 };
  // Applications are only accepted on missions that are publicly posted AND
  // still Open for play — not pending/completed/cancelled ones.
  if (m.workflowState !== "posted" || m.status !== "open") {
    return { ok: false, error: "This mission is not open for applications", httpStatus: 409 };
  }
  // Character must belong to the applicant.
  const [char] = await db.select().from(characters).where(eq(characters.id, opts.characterId));
  if (!char) return { ok: false, error: "Character not found", httpStatus: 404 };
  if (char.ownerId !== opts.userId) {
    return { ok: false, error: "That character isn't yours", httpStatus: 403 };
  }
  const comment = opts.comment?.trim() || null;
  // Dedupe on (mission, character): re-applying re-opens a withdrawn/rejected
  // application back to pending and refreshes the comment.
  await db
    .insert(missionApplications)
    .values({
      missionId: opts.missionId,
      userId: opts.userId,
      characterId: opts.characterId,
      comment,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: [missionApplications.missionId, missionApplications.characterId],
      set: {
        userId: opts.userId,
        comment,
        status: "pending",
        reviewedBy: null,
        reviewedAt: null,
        updatedAt: new Date(),
      },
    });
  return { ok: true };
}

/** Player withdraws their own application. */
export async function withdrawApplication(opts: {
  missionId: number;
  applicationId: number;
  userId: string;
}): Promise<ApplyResult> {
  const [app] = await db
    .select()
    .from(missionApplications)
    .where(eq(missionApplications.id, opts.applicationId));
  if (!app) return { ok: false, error: "Application not found", httpStatus: 404 };
  // The application must actually belong to the mission named in the URL —
  // otherwise a mismatched mission/app pair could mutate an unrelated record.
  if (app.missionId !== opts.missionId) {
    return { ok: false, error: "Application not found", httpStatus: 404 };
  }
  if (app.userId !== opts.userId) {
    return { ok: false, error: "Not your application", httpStatus: 403 };
  }
  await db
    .update(missionApplications)
    .set({ status: "withdrawn", updatedAt: new Date() })
    .where(eq(missionApplications.id, opts.applicationId));
  return { ok: true };
}

/**
 * Fixer reviews an application. action=accept assigns the player+character to
 * the mission (idempotent on the (mission,user) assignment) and marks the
 * application accepted; action=reject just marks it rejected.
 */
export async function reviewApplication(opts: {
  missionId: number;
  applicationId: number;
  action: "accept" | "reject";
  viewer: MissionViewer;
  req?: Request;
}): Promise<ApplyResult> {
  const reviewerId = opts.viewer.id;
  const [app] = await db
    .select()
    .from(missionApplications)
    .where(eq(missionApplications.id, opts.applicationId));
  if (!app) return { ok: false, error: "Application not found", httpStatus: 404 };
  // The application must belong to the mission named in the URL.
  if (app.missionId !== opts.missionId) {
    return { ok: false, error: "Application not found", httpStatus: 404 };
  }
  // Only the mission's own fixer (or an admin) may review its applications.
  const [mission] = await db
    .select({ fixerId: missions.fixerId })
    .from(missions)
    .where(eq(missions.id, app.missionId));
  if (!mission) return { ok: false, error: "Application not found", httpStatus: 404 };
  if (!ownsMissionApplications(opts.viewer, mission.fixerId)) {
    return {
      ok: false,
      error: "Only the mission's fixer or an admin can review its applications",
      httpStatus: 403,
    };
  }

  if (opts.action === "reject") {
    await db
      .update(missionApplications)
      .set({
        status: "rejected",
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(missionApplications.id, opts.applicationId));
    await recordAudit({
      req: opts.req,
      actorId: reviewerId,
      action: "mission_application_rejected",
      category: "mission",
      targetType: "mission",
      targetId: String(app.missionId),
      message: `Rejected application ${app.id} (character ${app.characterId})`,
    });
    return { ok: true };
  }

  // Accept: create/refresh the assignment for this player & character.
  await db
    .insert(missionAssignments)
    .values({
      missionId: app.missionId,
      userId: app.userId,
      characterId: app.characterId,
    })
    .onConflictDoUpdate({
      target: [missionAssignments.missionId, missionAssignments.userId],
      set: { characterId: app.characterId },
    });
  await db
    .update(missionApplications)
    .set({
      status: "accepted",
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(missionApplications.id, opts.applicationId));
  await recordAudit({
    req: opts.req,
    actorId: reviewerId,
    action: "mission_application_accepted",
    category: "mission",
    targetType: "mission",
    targetId: String(app.missionId),
    message: `Accepted application ${app.id}; assigned character ${app.characterId}`,
  });
  return { ok: true };
}

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
  return { ok: true };
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
  const sync = await syncMissionDiscordEvent(updated, ctx, m.imageUrl);
  await db
    .update(missions)
    .set({
      workflowState: "posted",
      status: nextStatus,
      discordEventId: sync.discordEventId,
      discordSyncError: sync.discordSyncError,
      updatedAt: new Date(),
    })
    .where(eq(missions.id, missionId));
  await recordAudit({
    req,
    actorId: viewer.id,
    action: "mission_posted",
    category: "mission",
    targetType: "mission",
    targetId: String(missionId),
    message: `Posted mission "${m.title}" to the public board`,
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

// ===========================================================================
// PRE-MISSION NPC ANNOUNCEMENT (Task #62) — posts to #npc-announcements ~1h
// before start, once per mission (idempotent via npcAnnouncedAt; cleared on
// reschedule). Gated by Test/Live mode.
// ===========================================================================

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
        isNull(missions.npcAnnouncedAt),
        isNotNull(missions.startAt),
        gt(missions.startAt, now),
        lte(missions.startAt, horizon),
      ),
    );
  let announced = 0;
  for (const m of due) {
    const startUnix = m.startAt ? Math.floor(m.startAt.getTime() / 1000) : null;
    const lines = [
      `**Actors Needed — ${m.title}**`,
      m.jobType ? `Job type: ${jobTypeLabel(m.jobType)}` : null,
      m.location ? `Location: ${m.location}` : null,
      startUnix ? `Starts: <t:${startUnix}:R>` : null,
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

function jobTypeLabel(jt: string): string {
  if (jt === "combat") return "Combat";
  if (jt === "non_combat") return "Non-Combat";
  if (jt === "mixed") return "Mixed";
  return jt;
}

// ===========================================================================
// DISCORD EVENT SYNC (gated by Test/Live mode)
// ===========================================================================

function eventTitle(title: string): string {
  return `Actors Needed: ${title}`;
}

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

  // Only POSTED missions appear publicly and own a Discord event. Drafts /
  // proposals / approved missions stay off Discord until the fixer posts them,
  // even if a start time is already set.
  const shouldExist = mission.workflowState === "posted" && mission.status !== "cancelled" && !!mission.startAt;

  // Cancelled or unscheduled: tear down any existing event.
  if (!shouldExist) {
    if (!mission.discordEventId) return { discordEventId: null, discordSyncError: null };
    const res = await deleteGuildScheduledEvent(mission.discordEventId);
    return res.ok
      ? { discordEventId: null, discordSyncError: null }
      : { discordEventId: mission.discordEventId, discordSyncError: res.error };
  }

  const startAt = mission.startAt!;
  const endAt = new Date(startAt.getTime() + Math.max(1, mission.durationMinutes) * 60_000);
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

// ===========================================================================
// PAYMENTS
// ===========================================================================

function advanceAfterPlayersPaid(status: string, actorsPaid: boolean): string {
  // Players just got paid. If actors were already paid (actors-first ordering),
  // the mission is fully settled → completed_paid; otherwise it's players-paid.
  if (
    status === "open" ||
    status === "pending" ||
    status === "completed" ||
    status === "completed_players_paid"
  ) {
    return actorsPaid ? "completed_paid" : "completed_players_paid";
  }
  return status;
}

function advanceAfterActorsPaid(status: string): string {
  // Actors paid while players already done → fully paid.
  if (status === "completed_players_paid") return "completed_paid";
  return status;
}

export interface PayPlayersResult {
  paid: number;
  simulated: number;
  failed: number;
  skipped: number;
  live: boolean;
}

/**
 * Pay assigned players their mission pay and credit attendance. Idempotent:
 * assignments already in `paid` are skipped (no double-pay). In Test mode the
 * payment is recorded as `simulated` (no real money, no Discord post) so the
 * flow is fully verifiable. Used by the manual endpoint and the auto-pay cron.
 */
export async function payMissionPlayers(
  missionId: number,
  opts: { source: "manual" | "auto"; req?: Request; actorId?: string | null; actorName?: string | null },
): Promise<PayPlayersResult | null> {
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!mission) return null;
  const ctx = await getMissionContext();
  const result: PayPlayersResult = { paid: 0, simulated: 0, failed: 0, skipped: 0, live: ctx.live };

  if (mission.status === "cancelled") {
    return result; // never pay a cancelled mission
  }

  const rows = await db
    .select({
      assignment: missionAssignments,
      discordId: users.discordId,
      username: users.username,
    })
    .from(missionAssignments)
    .leftJoin(users, eq(users.id, missionAssignments.userId))
    .where(eq(missionAssignments.missionId, missionId));

  const amount = mission.playerPay;
  const now = new Date();
  const paidLines: string[] = [];

  for (const { assignment: a, discordId, username } of rows) {
    if (a.paymentStatus === "paid") {
      result.skipped++;
      continue;
    }
    // Atomically claim this row so a concurrent run (manual + cron, overlapping
    // cron ticks, or duplicate requests) cannot pay the same assignment twice.
    // Only one worker can transition it out of a non-final state.
    const claimed = await db
      .update(missionAssignments)
      .set({ paymentStatus: "processing" })
      .where(
        and(
          eq(missionAssignments.id, a.id),
          inArray(missionAssignments.paymentStatus, ["unpaid", "failed", "simulated"]),
        ),
      )
      .returning({ id: missionAssignments.id });
    if (claimed.length === 0) {
      // Lost the race (another worker is paying / already paid it).
      result.skipped++;
      continue;
    }
    const creditAttendance = a.attendanceCreditedAt ?? now;

    if (amount <= 0) {
      // Nothing to pay — just credit attendance and mark resolved.
      await db
        .update(missionAssignments)
        .set({ paymentStatus: "paid", payAmount: 0, paidAt: now, paymentError: null, attendanceCreditedAt: creditAttendance })
        .where(eq(missionAssignments.id, a.id));
      result.paid++;
      continue;
    }

    if (!ctx.live) {
      await db
        .update(missionAssignments)
        .set({ paymentStatus: "simulated", payAmount: amount, paidAt: now, paymentError: null, attendanceCreditedAt: creditAttendance })
        .where(eq(missionAssignments.id, a.id));
      result.simulated++;
      continue;
    }

    if (!discordId) {
      await db
        .update(missionAssignments)
        .set({ paymentStatus: "failed", payAmount: amount, paymentError: "No Discord id for player", attendanceCreditedAt: creditAttendance })
        .where(eq(missionAssignments.id, a.id));
      result.failed++;
      continue;
    }

    const balance = await patchBalance(discordId, { cash: amount, reason: `Mission pay: ${mission.title}` });
    if (balance == null) {
      await db
        .update(missionAssignments)
        .set({ paymentStatus: "failed", payAmount: amount, paymentError: "UnbelievaBoat payout failed", attendanceCreditedAt: creditAttendance })
        .where(eq(missionAssignments.id, a.id));
      result.failed++;
    } else {
      await db
        .update(missionAssignments)
        .set({ paymentStatus: "paid", payAmount: amount, paidAt: now, paymentError: null, attendanceCreditedAt: creditAttendance })
        .where(eq(missionAssignments.id, a.id));
      result.paid++;
      paidLines.push(`<@${discordId}>${username ? ` (${username})` : ""}: +${amount.toLocaleString()} eddies`);
    }
  }

  // Post a banking summary only for real payouts.
  if (ctx.live && paidLines.length > 0) {
    await postToChannel(
      ctx.bankingChannelId,
      [`**Mission player payout** — ${mission.title} (#${mission.id})`, ...paidLines].join("\n"),
    ).catch((err) => logger.warn({ err, missionId }, "banking post (players) failed"));
  }

  // Mark processed (auto-pay idempotency). Only advance status when EVERY
  // assignment reached a terminal-success state (paid/simulated). If any are
  // still failed/unpaid/processing (e.g. UB payout failure, or a concurrent
  // worker mid-flight), leave the status untouched so the mission isn't marked
  // "players paid" while a player went unpaid. A later manual/auto retry will
  // resolve the stragglers and then advance.
  const remaining = await db
    .select({ id: missionAssignments.id })
    .from(missionAssignments)
    .where(
      and(
        eq(missionAssignments.missionId, missionId),
        sql`${missionAssignments.paymentStatus} not in ('paid', 'simulated')`,
      ),
    );
  const allResolved = remaining.length === 0;
  // Detect actors-first ordering: if any actor payout already settled, paying
  // players completes the mission outright (completed_paid) rather than leaving
  // it stuck at completed_players_paid.
  const actorsSettled = await db
    .select({ id: missionActorPayments.id })
    .from(missionActorPayments)
    .where(
      and(
        eq(missionActorPayments.missionId, missionId),
        inArray(missionActorPayments.paymentStatus, ["paid", "simulated"]),
      ),
    )
    .limit(1);
  const actorsPaid = actorsSettled.length > 0;
  const newStatus = allResolved ? advanceAfterPlayersPaid(mission.status, actorsPaid) : mission.status;
  await db
    .update(missions)
    .set({ status: newStatus, autoPayProcessedAt: mission.autoPayProcessedAt ?? now })
    .where(eq(missions.id, missionId));

  await recordAudit({
    req: opts.req,
    actorId: opts.actorId ?? null,
    actorName: opts.actorName ?? null,
    category: "mission",
    action: opts.source === "auto" ? "mission.autopay_players" : "mission.pay_players",
    targetType: "mission",
    targetId: missionId,
    message: `${ctx.live ? "LIVE" : "TEST"} player payout — paid ${result.paid}, simulated ${result.simulated}, failed ${result.failed}, skipped ${result.skipped}`,
    after: result,
  });

  return result;
}

export interface PayActorsResult {
  paid: number;
  simulated: number;
  failed: number;
  skipped: number;
  live: boolean;
}

/**
 * Pay a set of actors a flat amount each, recording one history row per actor.
 * The DB enforces no second SUCCESSFUL pay per (mission, actor); we also skip
 * up-front. Test mode records `simulated` rows and posts nothing.
 */
export async function payMissionActors(
  missionId: number,
  userIds: string[],
  amount: number,
  opts: { req?: Request; actorId?: string | null; actorName?: string | null },
): Promise<PayActorsResult | null> {
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!mission) return null;
  const ctx = await getMissionContext();
  const result: PayActorsResult = { paid: 0, simulated: 0, failed: 0, skipped: 0, live: ctx.live };

  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length === 0) return result;

  const userRows = await db
    .select({ id: users.id, discordId: users.discordId, username: users.username })
    .from(users)
    .where(inArray(users.id, uniqueIds));
  const userById = new Map(userRows.map((u) => [u.id, u]));

  // Existing SUCCESSFUL actor payments — skip those (double-pay guard).
  const existing = await db
    .select({ userId: missionActorPayments.userId })
    .from(missionActorPayments)
    .where(and(eq(missionActorPayments.missionId, missionId), eq(missionActorPayments.paymentStatus, "paid")));
  const alreadyPaid = new Set(existing.map((e) => e.userId));

  const now = new Date();
  const postedLines: string[] = [];

  for (const userId of uniqueIds) {
    if (alreadyPaid.has(userId)) {
      result.skipped++;
      continue;
    }
    const u = userById.get(userId);
    const base = {
      missionId,
      missionName: mission.title,
      userId,
      userName: u?.username ?? null,
      fixerId: mission.fixerId,
      missionDate: mission.startAt,
      amount,
      source: "manual" as const,
      attendanceCreditedAt: now,
      paidAt: now,
    };

    if (!ctx.live) {
      await db.insert(missionActorPayments).values({ ...base, paymentStatus: "simulated" });
      result.simulated++;
      continue;
    }
    // Reserve the unique (mission, actor) PAID slot up-front, BEFORE the
    // external payout, so two concurrent runs can't both pay the same actor.
    // The partial unique index covers payment_status='paid' rows; the loser of
    // the race gets nothing back from onConflictDoNothing and skips.
    const reserved = await db
      .insert(missionActorPayments)
      .values({ ...base, paymentStatus: "paid" })
      .onConflictDoNothing()
      .returning({ id: missionActorPayments.id });
    if (reserved.length === 0) {
      result.skipped++;
      continue;
    }
    const reservedId = reserved[0].id;
    if (!u?.discordId) {
      await db
        .update(missionActorPayments)
        .set({ paymentStatus: "failed", paymentError: "No Discord id for actor", paidAt: null })
        .where(eq(missionActorPayments.id, reservedId));
      result.failed++;
      continue;
    }
    const balance = amount > 0 ? await patchBalance(u.discordId, { cash: amount, reason: `Actor pay: ${mission.title}` }) : { cash: 0, bank: 0, total: 0, source: "local" as const };
    if (balance == null) {
      // Release the reservation so the actor can be retried later.
      await db
        .update(missionActorPayments)
        .set({ paymentStatus: "failed", paymentError: "UnbelievaBoat payout failed", paidAt: null })
        .where(eq(missionActorPayments.id, reservedId));
      result.failed++;
    } else {
      // Row is already 'paid' from the reservation.
      result.paid++;
      postedLines.push(`<@${u.discordId}>${u.username ? ` (${u.username})` : ""}: +${amount.toLocaleString()} eddies`);
    }
  }

  if (ctx.live && postedLines.length > 0) {
    const body = [`**Actor payout** — ${mission.title} (#${mission.id})`, ...postedLines].join("\n");
    await postToChannel(ctx.npcSpendingChannelId, body).catch((err) =>
      logger.warn({ err, missionId }, "npc spending post failed"),
    );
    await postToChannel(ctx.bankingChannelId, body).catch((err) =>
      logger.warn({ err, missionId }, "banking post (actors) failed"),
    );
  }

  if (result.paid > 0 || result.simulated > 0) {
    const newStatus = advanceAfterActorsPaid(mission.status);
    if (newStatus !== mission.status) {
      await db.update(missions).set({ status: newStatus }).where(eq(missions.id, missionId));
    }
  }

  await recordAudit({
    req: opts.req,
    actorId: opts.actorId ?? null,
    actorName: opts.actorName ?? null,
    category: "mission",
    action: "mission.pay_actors",
    targetType: "mission",
    targetId: missionId,
    message: `${ctx.live ? "LIVE" : "TEST"} actor payout (${amount} ea) — paid ${result.paid}, simulated ${result.simulated}, failed ${result.failed}, skipped ${result.skipped}`,
    after: result,
  });

  return result;
}

// ===========================================================================
// AUTO-PAY CRON
// ===========================================================================

/**
 * Process every mission whose window (startAt + duration + autopay delay) has
 * elapsed and that hasn't been auto-processed yet. Credits attendance and pays
 * players. Skips cancelled/future/already-processed missions. Returns the
 * number of missions processed.
 */
export async function runMissionAutoPay(): Promise<number> {
  const ctx = await getMissionContext();
  const now = Date.now();
  // Candidates: scheduled, not cancelled, not already processed.
  const candidates = await db
    .select()
    .from(missions)
    .where(
      and(
        isNull(missions.autoPayProcessedAt),
        sql`${missions.status} <> 'cancelled'`,
        sql`${missions.startAt} is not null`,
      ),
    );

  let processed = 0;
  for (const m of candidates) {
    if (!m.startAt) continue;
    const windowEnd = m.startAt.getTime() + Math.max(1, m.durationMinutes) * 60_000 + ctx.autopayDelayMs;
    if (windowEnd > now) continue; // still in the future
    try {
      await payMissionPlayers(m.id, { source: "auto", actorName: "auto-pay cron" });
      processed++;
    } catch (err) {
      logger.error({ err, missionId: m.id }, "mission auto-pay failed");
    }
  }
  return processed;
}

// ===========================================================================
// REPORTING
// ===========================================================================

export async function getActorReport(fixerId: string | null) {
  const where = fixerId ? eq(missionActorPayments.fixerId, fixerId) : undefined;
  const rows = await db
    .select()
    .from(missionActorPayments)
    .where(where ? and(where, inArray(missionActorPayments.paymentStatus, ["paid", "simulated"])) : inArray(missionActorPayments.paymentStatus, ["paid", "simulated"]))
    .orderBy(desc(missionActorPayments.createdAt));

  const byUser = new Map<string, {
    userId: string;
    userName: string | null;
    actCount: number;
    totalPaid: number;
    missions: Array<{ missionId: number; missionName: string | null; missionDate: string | null; amount: number }>;
  }>();
  for (const r of rows) {
    let agg = byUser.get(r.userId);
    if (!agg) {
      agg = { userId: r.userId, userName: r.userName, actCount: 0, totalPaid: 0, missions: [] };
      byUser.set(r.userId, agg);
    }
    agg.actCount++;
    if (r.paymentStatus === "paid") agg.totalPaid += r.amount;
    agg.missions.push({ missionId: r.missionId, missionName: r.missionName, missionDate: iso(r.missionDate), amount: r.amount });
    if (!agg.userName && r.userName) agg.userName = r.userName;
  }
  return [...byUser.values()].sort((a, b) => b.actCount - a.actCount);
}

export async function getAttendanceReport() {
  const rows = await db
    .select({
      userId: missionAssignments.userId,
      userName: users.username,
      missionId: missionAssignments.missionId,
      missionName: missions.title,
      missionDate: missions.startAt,
      characterName: characters.name,
    })
    .from(missionAssignments)
    .leftJoin(users, eq(users.id, missionAssignments.userId))
    .leftJoin(missions, eq(missions.id, missionAssignments.missionId))
    .leftJoin(characters, eq(characters.id, missionAssignments.characterId))
    .where(sql`${missionAssignments.attendanceCreditedAt} is not null`)
    .orderBy(desc(missionAssignments.attendanceCreditedAt));

  const byUser = new Map<string, {
    userId: string;
    userName: string | null;
    attendedCount: number;
    missions: Array<{ missionId: number; missionName: string | null; missionDate: string | null; characterName: string | null }>;
  }>();
  for (const r of rows) {
    let agg = byUser.get(r.userId);
    if (!agg) {
      agg = { userId: r.userId, userName: r.userName, attendedCount: 0, missions: [] };
      byUser.set(r.userId, agg);
    }
    agg.attendedCount++;
    agg.missions.push({ missionId: r.missionId, missionName: r.missionName, missionDate: iso(r.missionDate), characterName: r.characterName });
    if (!agg.userName && r.userName) agg.userName = r.userName;
  }
  return [...byUser.values()].sort((a, b) => b.attendedCount - a.attendedCount);
}
