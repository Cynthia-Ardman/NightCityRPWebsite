import type { Request } from "express";
import { and, or, eq, desc, gt, lte, inArray, notInArray, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  db,
  missions,
  missionAssignments,
  missionActorPayments,
  missionApplications,
  missionNpcSignups,
  botActorAttendance,
  characters,
  customRequests,
  users,
  type Mission,
} from "@workspace/db";
import { logger } from "./logger";
import { recordAudit } from "./audit";
import { patchBalance } from "./unbelievaboat";
import { recordSettledWalletMovement } from "./economy";
import {
  postToChannel,
  startThreadFromMessage,
  getChannelMeta,
  createForumThread,
  FORUM_CHANNEL_TYPE,
  sendDirectMessage,
  createGuildScheduledEvent,
  modifyGuildScheduledEvent,
  deleteGuildScheduledEvent,
  listGuildScheduledEvents,
  hasRole,
} from "./discord";
import { notifyMissionPayout } from "./notifications";
import { getMissionContext, type MissionExternalContext } from "./missionsConfig";
import { resolveOrProvisionUser } from "./userProvision";

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

// Public, clickable URL for a mission's detail page. Mirrors the announce/breach
// link pattern: prefer PUBLIC_BASE_URL, fall back to the first Replit domain, and
// degrade to a relative path when neither is set so the post is still readable.
export function buildMissionUrl(missionId: number): string {
  const base = (process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "").replace(
    /^https?:\/\//,
    "",
  );
  return base ? `https://${base}/missions/${missionId}` : `/missions/${missionId}`;
}

// ===========================================================================
// VIEW BUILDERS
// ===========================================================================

export interface MissionViewer {
  id: string;
  isManager: boolean; // fixer or admin
  isAdmin: boolean;
  isArchivist: boolean; // archivist or admin (can approve proposals)
  // Trial fixer who is NOT a full manager. They may author (create/edit/submit)
  // their OWN missions but get no other fixer tools. Per-mission ownership is
  // enforced at each write path; never grant them blanket manager access.
  isTrialAuthor: boolean;
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

type MissionWithFixer = Mission & {
  fixerName: string | null;
  fixerAvatarUrl: string | null;
  // Display-only: true when the owning fixer is still on trial.
  fixerIsTrial: boolean;
};

async function loadMissions(
  where: ReturnType<typeof eq> | undefined,
  limit?: number,
  offset?: number,
): Promise<MissionWithFixer[]> {
  let q = db
    .select({
      mission: missions,
      fixerName: users.username,
      fixerAvatarUrl: users.avatarUrl,
      fixerRoles: users.roles,
    })
    .from(missions)
    .leftJoin(users, eq(users.id, missions.fixerId))
    // id is the final tiebreaker so limit/offset paging is fully deterministic
    // even when startAt/createdAt collide (or startAt is null).
    .orderBy(desc(missions.startAt), desc(missions.createdAt), desc(missions.id))
    .$dynamic();
  if (where) q = q.where(where);
  if (limit) q = q.limit(limit);
  if (offset) q = q.offset(offset);
  const rows = await q;
  return rows.map((r) => ({
    ...r.mission,
    fixerName: r.fixerName,
    fixerAvatarUrl: r.fixerAvatarUrl,
    fixerIsTrial: hasRole(r.fixerRoles ?? [], "TRIAL_FIXER"),
  }));
}

function toSummary(
  m: MissionWithFixer,
  assignments: AssignmentJoin[],
  viewerId: string,
  myApplication: Awaited<ReturnType<typeof listApplicationViews>>[number] | null = null,
  mySignup: ReturnType<typeof toMySignupView> | null = null,
) {
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
    npcPayAmount: m.npcPayAmount,
    slots: m.slots,
    jobType: m.jobType,
    requestedSkills: m.requestedSkills,
    client: m.client,
    maxPlayers: m.maxPlayers,
    assignedCount: assignments.length,
    fixerId: m.fixerId,
    fixerName: m.fixerName,
    fixerAvatarUrl: m.fixerAvatarUrl,
    fixerIsTrial: m.fixerIsTrial,
    discordEventId: m.discordEventId,
    discordSyncError: m.discordSyncError,
    myCharacterId: mine?.characterId ?? null,
    myCharacterName: mine?.characterName ?? null,
    myPaymentStatus: mine?.paymentStatus ?? null,
    myApplication,
    npcSignupOpen: missionAcceptsNpcSignup(m),
    mySignup,
    players,
    createdAt: m.createdAt.toISOString(),
  };
}

/** Shape one NPC sign-up row into the player-facing "my sign-up" view. */
function toMySignupView(r: {
  id: number;
  characterId: number | null;
  characterName: string | null;
  state: string;
  payAmount: number | null;
  paymentStatus: string;
  paidAt: Date | null;
}) {
  return {
    id: r.id,
    characterId: r.characterId,
    characterName: r.characterName,
    state: r.state,
    payAmount: r.payAmount,
    paymentStatus: r.paymentStatus,
    paidAt: iso(r.paidAt),
  };
}

/**
 * Pick the single application to surface to the player for one mission. A player
 * can hold several application rows on the same mission (the unique index is per
 * (mission, character), so applying with a second character makes a new row), so
 * we must choose ONE deterministically. Priority: an active row first (accepted,
 * then pending) so an on-roster / awaiting-review player always sees that; then
 * the most recent terminal row (withdrawn before rejected) so a player whose only
 * application was withdrawn falls through to the apply form and can RE-APPLY.
 *
 * Without this, naive "first/last row" selection broke re-applying: the detail
 * page used the OLDEST row and the open-list used the NEWEST, so withdrawing one
 * of several applications could leave the detail page locked to a stale card with
 * no apply form. Both surfaces now share this picker.
 */
const APPLICATION_STATUS_RANK: Record<string, number> = {
  accepted: 0,
  pending: 1,
  withdrawn: 2,
  rejected: 3,
};
function pickMyApplicationView<T extends { status: string; createdAt: string }>(
  views: T[],
): T | null {
  if (views.length === 0) return null;
  return [...views].sort((a, b) => {
    const ra = APPLICATION_STATUS_RANK[a.status] ?? 9;
    const rb = APPLICATION_STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    // Within the same status, prefer the most recently created row.
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  })[0];
}

/**
 * Batch-load the viewer's OWN application for each of the given missions, keyed
 * by mission id. Mirrors the per-mission `myApplication` the detail model
 * computes so the Open-tab cards can render the inline apply/withdraw button.
 */
async function loadMyApplicationsForMissions(
  missionIds: number[],
  userId: string,
): Promise<Map<number, Awaited<ReturnType<typeof listApplicationViews>>[number]>> {
  const out = new Map<number, Awaited<ReturnType<typeof listApplicationViews>>[number]>();
  if (missionIds.length === 0) return out;
  const rows = await db
    .select({
      missionId: missionApplications.missionId,
      id: missionApplications.id,
      userId: missionApplications.userId,
      userName: users.username,
      userAvatarUrl: users.avatarUrl,
      characterId: missionApplications.characterId,
      characterName: characters.name,
      characterPortraitUrl: characters.portraitUrl,
      comment: missionApplications.comment,
      availability: missionApplications.availability,
      status: missionApplications.status,
      reviewedBy: missionApplications.reviewedBy,
      reviewedAt: missionApplications.reviewedAt,
      createdAt: missionApplications.createdAt,
      // Roster membership — derive 'accepted' when on the roster even if the
      // application row was never flipped (roster-editor add). See note in
      // listApplicationViews / listMyApplications.
      assignedId: missionAssignments.id,
    })
    .from(missionApplications)
    .leftJoin(users, eq(users.id, missionApplications.userId))
    .leftJoin(characters, eq(characters.id, missionApplications.characterId))
    .leftJoin(
      missionAssignments,
      and(
        eq(missionAssignments.missionId, missionApplications.missionId),
        eq(missionAssignments.characterId, missionApplications.characterId),
      ),
    )
    .where(and(inArray(missionApplications.missionId, missionIds), eq(missionApplications.userId, userId)))
    .orderBy(missionApplications.createdAt);

  const recency = await loadRecencyByCharacter(
    rows.map((r) => r.characterId),
    -1,
  );
  const now = Date.now();
  // Group every application row per mission, then pick the single one to surface
  // with the shared picker (active first, else most-recent terminal) so the
  // open-list card matches the detail page and a withdrawn row never hides the
  // re-apply affordance behind a stale sibling.
  const byMission = new Map<number, Awaited<ReturnType<typeof listApplicationViews>>>();
  for (const r of rows) {
    const rec = recency.get(r.characterId);
    const last = rec?.lastAttendedAt ?? null;
    const daysSince = last ? Math.floor((now - last.getTime()) / 86_400_000) : null;
    const view = {
      id: r.id,
      userId: r.userId,
      userName: r.userName,
      userAvatarUrl: r.userAvatarUrl,
      characterId: r.characterId,
      characterName: r.characterName,
      characterPortraitUrl: r.characterPortraitUrl,
      comment: r.comment,
      availability: normalizeAvailability(r.availability),
      // Self-heal: roster membership implies accepted (see assignedId note).
      status: r.status === "pending" && r.assignedId != null ? "accepted" : r.status,
      reviewedBy: r.reviewedBy,
      reviewedAt: iso(r.reviewedAt),
      createdAt: r.createdAt.toISOString(),
      attendanceCount: rec?.attendanceCount ?? 0,
      lastAttendedAt: iso(last),
      daysSinceLastMission: daysSince,
      recencyWarning: daysSince != null && daysSince < RECENCY_WARNING_DAYS,
    };
    const list = byMission.get(r.missionId);
    if (list) list.push(view);
    else byMission.set(r.missionId, [view]);
  }
  for (const [missionId, views] of byMission) {
    const picked = pickMyApplicationView(views);
    if (picked) out.set(missionId, picked);
  }
  return out;
}

/** Batch-load the viewer's OWN NPC sign-up for each mission, keyed by mission id. */
async function loadMySignupsForMissions(
  missionIds: number[],
  userId: string,
): Promise<Map<number, ReturnType<typeof toMySignupView>>> {
  const out = new Map<number, ReturnType<typeof toMySignupView>>();
  if (missionIds.length === 0) return out;
  const rows = await db
    .select({
      missionId: missionNpcSignups.missionId,
      id: missionNpcSignups.id,
      characterId: missionNpcSignups.characterId,
      characterName: characters.name,
      state: missionNpcSignups.state,
      payAmount: missionNpcSignups.payAmount,
      paymentStatus: missionNpcSignups.paymentStatus,
      paidAt: missionNpcSignups.paidAt,
    })
    .from(missionNpcSignups)
    .leftJoin(characters, eq(characters.id, missionNpcSignups.characterId))
    .where(and(inArray(missionNpcSignups.missionId, missionIds), eq(missionNpcSignups.userId, userId)))
    .orderBy(missionNpcSignups.id);
  for (const r of rows) {
    out.set(r.missionId, toMySignupView(r));
  }
  return out;
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
  const ids = rows.map((r) => r.id);
  const byMission = await loadAssignments(ids);
  // Batch-load the viewer's own application + NPC sign-up per mission so the
  // Open-tab cards can render inline apply/withdraw and sign-up/remove buttons.
  const myApps = await loadMyApplicationsForMissions(ids, opts.viewer.id);
  const mySignups = await loadMySignupsForMissions(ids, opts.viewer.id);
  return rows.map((m) =>
    toSummary(m, byMission.get(m.id) ?? [], opts.viewer.id, myApps.get(m.id) ?? null, mySignups.get(m.id) ?? null),
  );
}

/**
 * The staff-wide "All Missions" board: every mission in the system, across all
 * workflow states. The route gates this to managers (fixers/admins) and
 * approvers (archivists), so there is no per-fixer filter here — staff who can
 * see this board see everything.
 */
export async function listOwnedMissionSummaries(viewer: MissionViewer) {
  const rows = await loadMissions(undefined);
  const byMission = await loadAssignments(rows.map((r) => r.id));
  return rows.map((m) => toSummary(m, byMission.get(m.id) ?? [], viewer.id));
}

/**
 * Missions the caller personally created (fixerId === viewer.id), across all
 * workflow states. Distinct from the all-missions board: even admins see only
 * the missions they themselves run here, so they can shepherd their own
 * pipeline separately from the global view.
 */
export async function listCreatedMissionSummaries(viewer: MissionViewer) {
  const rows = await loadMissions(eq(missions.fixerId, viewer.id));
  const byMission = await loadAssignments(rows.map((r) => r.id));
  return rows.map((m) => toSummary(m, byMission.get(m.id) ?? [], viewer.id));
}

/**
 * Public fixer profile: the fixer's identity plus every mission they run that
 * the viewer is allowed to see. Regular players only see posted missions (the
 * same visibility rule as the main board); managers see the full pipeline.
 * Returns null when the user does not exist.
 */
export async function getFixerMissionsProfile(fixerId: string, viewer: MissionViewer) {
  const [u] = await db
    .select({ id: users.id, name: users.username, avatarUrl: users.avatarUrl, roles: users.roles })
    .from(users)
    .where(eq(users.id, fixerId))
    .limit(1);
  if (!u) return null;
  const filters = [eq(missions.fixerId, fixerId)];
  if (!viewer.isManager) filters.push(eq(missions.workflowState, "posted"));
  const rows = await loadMissions(and(...filters));
  const byMission = await loadAssignments(rows.map((r) => r.id));
  return {
    fixer: {
      id: u.id,
      name: u.name,
      avatarUrl: u.avatarUrl,
      isTrial: hasRole(u.roles ?? [], "TRIAL_FIXER"),
    },
    missions: rows.map((m) => toSummary(m, byMission.get(m.id) ?? [], viewer.id)),
  };
}

// Terminal runtime statuses that put a mission in the history view.
const HISTORY_STATUSES: MissionStatus[] = [
  "completed",
  "completed_players_paid",
  "completed_paid",
  "cancelled",
];

/**
 * Completed/cancelled missions relevant to the caller, most recent first
 * (loadMissions already orders by startAt desc). Viewer-scoped: players see
 * missions they were assigned to; managers additionally see missions they ran.
 * Non-managers never see non-posted missions.
 */
export async function listMissionHistory(
  viewer: MissionViewer,
  opts: { limit: number; offset: number },
) {
  // Missions the viewer was assigned to, as a SQL subquery so it can drive the
  // WHERE clause directly (no in-memory post-filter that would break paging).
  const assignedSubquery = db
    .select({ missionId: missionAssignments.missionId })
    .from(missionAssignments)
    .where(eq(missionAssignments.userId, viewer.id));
  // Viewer-relevance, folded into SQL so limit/offset count only rows the
  // viewer can actually see: players see missions they attended; managers also
  // see missions they ran.
  const relevance = viewer.isManager
    ? or(inArray(missions.id, assignedSubquery), eq(missions.fixerId, viewer.id))
    : inArray(missions.id, assignedSubquery);
  // Terminal-status filter and the non-manager "posted only" visibility rule
  // also go into SQL.
  const filters = [inArray(missions.status, HISTORY_STATUSES), relevance];
  if (!viewer.isManager) filters.push(eq(missions.workflowState, "posted"));
  const where = and(...filters);
  // Fetch one extra row to learn whether another page exists without a count.
  const rows = await loadMissions(where, opts.limit + 1, opts.offset);
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const byMission = await loadAssignments(page.map((r) => r.id));
  return {
    items: page.map((m) => toSummary(m, byMission.get(m.id) ?? [], viewer.id)),
    hasMore,
  };
}

/**
 * Every application the caller has submitted (all states: pending / accepted /
 * rejected / withdrawn), enriched with mission + fixer + character context,
 * newest first. Only ever the caller's own rows — players never see anyone
 * else's applications.
 */
export async function listMyApplications(userId: string) {
  const fixerUser = alias(users, "fixer_user");
  const rows = await db
    .select({
      id: missionApplications.id,
      missionId: missionApplications.missionId,
      missionTitle: missions.title,
      missionStatus: missions.status,
      missionStartAt: missions.startAt,
      fixerName: fixerUser.username,
      characterId: missionApplications.characterId,
      characterName: characters.name,
      characterPortraitUrl: characters.portraitUrl,
      comment: missionApplications.comment,
      status: missionApplications.status,
      reviewedAt: missionApplications.reviewedAt,
      createdAt: missionApplications.createdAt,
      // Whether this character is actually on the mission roster. A player can
      // land on the roster two ways: the fixer "accepts" their application
      // (which flips status to 'accepted'), OR the fixer adds the character via
      // the roster editor — which raises a participation request but never
      // touches the application row. In the latter case the stored status stays
      // 'pending' forever even after the player confirms and gets paid, so we
      // derive 'accepted' at read time when an assignment exists.
      assignedId: missionAssignments.id,
    })
    .from(missionApplications)
    .innerJoin(missions, eq(missions.id, missionApplications.missionId))
    .leftJoin(fixerUser, eq(fixerUser.id, missions.fixerId))
    .leftJoin(characters, eq(characters.id, missionApplications.characterId))
    .leftJoin(
      missionAssignments,
      and(
        eq(missionAssignments.missionId, missionApplications.missionId),
        eq(missionAssignments.characterId, missionApplications.characterId),
      ),
    )
    .where(eq(missionApplications.userId, userId))
    .orderBy(desc(missionApplications.createdAt));
  return rows.map((r) => ({
    id: r.id,
    missionId: r.missionId,
    missionTitle: r.missionTitle,
    missionStatus: r.missionStatus,
    missionStartAt: iso(r.missionStartAt),
    fixerName: r.fixerName,
    characterId: r.characterId,
    characterName: r.characterName,
    characterPortraitUrl: r.characterPortraitUrl,
    comment: r.comment,
    // Self-heal: a pending application whose character is on the roster is
    // effectively accepted (see assignedId note above).
    status: r.status === "pending" && r.assignedId != null ? "accepted" : r.status,
    reviewedAt: iso(r.reviewedAt),
    createdAt: r.createdAt.toISOString(),
  }));
}

export type ActingEntry = {
  id: string;
  name: string | null;
  actedAt: string;
  amount: number;
  source: "mission" | "event" | "legacy";
  paymentStatus: string | null;
  fixerName: string | null;
};

/**
 * Every time the caller ACTED (played an NPC / acted in someone else's mission
 * or event), newest first. Unions two sources keyed to the same person:
 *  - modern `mission_actor_payments` rows (keyed by portal user id) — both
 *    mission-tied and free-form event payouts; test-mode `simulated` rows are
 *    excluded since they never represent a real act.
 *  - legacy `bot_actor_attendance` rows imported from the old Discord bot,
 *    keyed by the user's Discord id.
 */
export async function listMyActing(viewer: MissionViewer): Promise<ActingEntry[]> {
  return listActingForUser(viewer.id);
}

/**
 * The acting history for a SPECIFIC user (used by both the viewer's own "Acting"
 * tab and a fixer's per-player acting lookup). Unions modern actor payouts —
 * which now include NPC sign-up payouts, since confirming an NPC writes a
 * mission_actor_payments row — with legacy bot acting records.
 */
export async function listActingForUser(userId: string): Promise<ActingEntry[]> {
  const [u] = await db
    .select({ discordId: users.discordId })
    .from(users)
    .where(eq(users.id, userId));
  const discordId = u?.discordId ?? null;

  const modern = await db
    .select()
    .from(missionActorPayments)
    .where(
      and(
        eq(missionActorPayments.userId, userId),
        ne(missionActorPayments.paymentStatus, "simulated"),
      ),
    );

  const legacy = discordId
    ? await db
        .select()
        .from(botActorAttendance)
        .where(eq(botActorAttendance.userId, discordId))
    : [];

  const entries: ActingEntry[] = [];
  for (const r of modern) {
    // missionDate is the day the act happened; fall back through the credit /
    // pay / row-creation stamps so an entry always has a date.
    const actedAt =
      iso(r.missionDate) ?? iso(r.attendanceCreditedAt) ?? iso(r.paidAt) ?? iso(r.createdAt);
    if (!actedAt) continue;
    entries.push({
      id: `act-${r.id}`,
      name: r.missionName,
      actedAt,
      amount: r.amount,
      source: r.missionId != null ? "mission" : "event",
      paymentStatus: r.paymentStatus,
      fixerName: r.fixerName,
    });
  }
  for (const r of legacy) {
    const actedAt = iso(r.actedAt);
    if (!actedAt) continue;
    entries.push({
      id: `legacy-${r.id}`,
      name: r.missionName,
      actedAt,
      amount: r.payAmount,
      source: "legacy",
      paymentStatus: null,
      fixerName: r.fixerUsername,
    });
  }
  entries.sort((a, b) => b.actedAt.localeCompare(a.actedAt));
  return entries;
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

/**
 * Per-mission management permission (roster / post / pay). Full managers
 * (fixer/admin) may manage ANY mission. A trial fixer may FULLY manage a mission
 * they OWN, but only once it has been approved (workflowState approved or
 * posted) — before approval they stay author-only (view + edit/submit). The
 * cross-mission tools (global actor lookup, breach control) remain
 * full-manager-only and are NOT covered by this check.
 */
function canManageMissionRow(
  m: { fixerId: string | null; workflowState: string },
  viewer: MissionViewer,
): boolean {
  if (viewer.isManager) return true;
  return (
    viewer.isTrialAuthor &&
    m.fixerId != null &&
    m.fixerId === viewer.id &&
    (m.workflowState === "approved" || m.workflowState === "posted")
  );
}

/**
 * Route-guard helper: load just the columns needed to decide management
 * permission for a single mission. `found` is false when the mission row does
 * not exist (so callers can 404 before 403).
 */
export async function getMissionManageAuth(
  missionId: number,
  viewer: MissionViewer,
): Promise<{ found: boolean; canManage: boolean }> {
  const [m] = await db
    .select({ fixerId: missions.fixerId, workflowState: missions.workflowState })
    .from(missions)
    .where(eq(missions.id, missionId));
  if (!m) return { found: false, canManage: false };
  return { found: true, canManage: canManageMissionRow(m, viewer) };
}

/**
 * True when this viewer OWNS at least one approved/posted mission — i.e. a
 * mission they are entitled to manage (roster / post / pay). Used to scope the
 * otherwise-global read-only actor search to trial fixers who are actually
 * running an approved mission, instead of opening it to every trial fixer.
 */
export async function viewerHasManageableMission(viewerId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: missions.id })
    .from(missions)
    .where(
      and(
        eq(missions.fixerId, viewerId),
        inArray(missions.workflowState, ["approved", "posted"]),
      ),
    )
    .limit(1);
  return !!row;
}

export async function getMissionDetail(missionId: number, viewer: MissionViewer) {
  const rows = await loadMissions(eq(missions.id, missionId));
  const m = rows[0];
  if (!m) return null;
  const isOwnerFixer = m.fixerId != null && m.fixerId === viewer.id;
  const canManage = canManageMissionRow(m, viewer);
  // Trial fixers may view + edit/submit a mission they own at any stage. Once it
  // is approved they additionally get full management (roster / post / pay) via
  // canManageMissionRow above; before approval `isTrialOwner` keeps them in the
  // author-only tier (edit/submit + view of their own non-posted mission).
  const isTrialOwner = viewer.isTrialAuthor && isOwnerFixer;
  const canEdit = canManage || isTrialOwner;
  // Visibility: regular players only see Posted missions (the draft pipeline is
  // staff-internal). Archivists are approvers, so they must be able to view a
  // non-posted mission to approve it. A trial fixer may view their OWN
  // non-posted missions (to edit/submit them) but not anyone else's.
  if (!canManage && !viewer.isArchivist && !isTrialOwner && m.workflowState !== "posted") return null;
  const ctx = await getMissionContext();
  const assignments = (await loadAssignments([missionId])).get(missionId) ?? [];

  // Per-character participation confirmation: when a fixer assigns a player's
  // character we raise a `mission_participation` request the player must accept.
  // Surface that state on the roster so a fixer can see, at a glance, who has
  // confirmed ("accepted") vs who hasn't responded yet ("pending"). Characters
  // with no request (e.g. a fixer self-assigning) get null.
  const rosterCharIds = assignments
    .map((a) => a.characterId)
    .filter((id): id is number => id != null);
  const participationByChar = new Map<number, "accepted" | "pending">();
  if (rosterCharIds.length > 0) {
    const partRows = await db
      .select({
        characterId: customRequests.characterId,
        status: customRequests.status,
        details: customRequests.details,
      })
      .from(customRequests)
      .where(
        and(
          eq(customRequests.type, "mission_participation"),
          inArray(customRequests.characterId, rosterCharIds),
        ),
      );
    for (const r of partRows) {
      if (r.characterId == null) continue;
      if (Number((r.details as { missionId?: number } | null)?.missionId) !== missionId) continue;
      const mapped = r.status === "approved" ? "accepted" : r.status === "pending" ? "pending" : null;
      if (!mapped) continue;
      // A still-pending request (e.g. a re-assignment) outranks an older accept,
      // since the player has not confirmed the current invite.
      if (mapped === "pending") participationByChar.set(r.characterId, "pending");
      else if (!participationByChar.has(r.characterId)) participationByChar.set(r.characterId, "accepted");
    }
  }
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
      fixerId: missionActorPayments.fixerId,
      fixerName: missionActorPayments.fixerName,
      paidAt: missionActorPayments.paidAt,
      createdAt: missionActorPayments.createdAt,
    })
    .from(missionActorPayments)
    .where(eq(missionActorPayments.missionId, missionId))
    .orderBy(desc(missionActorPayments.createdAt));

  // NPC sign-ups (Task #185): the full roster is manager-gated (like
  // actorPayments); every viewer also gets their own sign-up echoed back so the
  // player UI can show/withdraw it.
  const npcRows = await db
    .select({
      id: missionNpcSignups.id,
      userId: missionNpcSignups.userId,
      userName: users.username,
      userAvatarUrl: users.avatarUrl,
      characterId: missionNpcSignups.characterId,
      characterName: characters.name,
      characterPortraitUrl: characters.portraitUrl,
      state: missionNpcSignups.state,
      payAmount: missionNpcSignups.payAmount,
      paymentStatus: missionNpcSignups.paymentStatus,
      paymentError: missionNpcSignups.paymentError,
      paidAt: missionNpcSignups.paidAt,
      createdAt: missionNpcSignups.createdAt,
    })
    .from(missionNpcSignups)
    .leftJoin(users, eq(users.id, missionNpcSignups.userId))
    .leftJoin(characters, eq(characters.id, missionNpcSignups.characterId))
    .where(eq(missionNpcSignups.missionId, missionId))
    .orderBy(missionNpcSignups.id);

  // Applications are private to the mission's OWNING fixer (or any admin) — a
  // different fixer must not see another fixer's applicant pool. Everyone else
  // (players, non-owning fixers) only gets their own application echoed back.
  const managesApplications = ownsMissionApplications(viewer, m.fixerId);
  const applications = managesApplications ? await listApplicationViews(missionId) : [];
  // Always echo the viewer's OWN application back, even to managers — staff who
  // also play need to see their pending/accepted status and use the apply form
  // on missions they don't run. (The full applicant pool stays manager-gated via
  // `applications` above.)
  const myApplication = pickMyApplicationView(await listApplicationViews(missionId, viewer.id));

  // Resolve the display name of whoever marked the mission completed (audit
  // surface for the read-only lock); only looked up when actually completed.
  let completedByName: string | null = null;
  if (m.completedBy) {
    const [u] = await db
      .select({ username: users.username, globalName: users.globalName })
      .from(users)
      .where(eq(users.id, m.completedBy));
    completedByName = u?.globalName ?? u?.username ?? null;
  }
  const isCompleted = m.completedAt != null;

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
    npcPayAmount: m.npcPayAmount,
    slots: m.slots,
    jobType: m.jobType,
    requestedSkills: m.requestedSkills,
    client: m.client,
    notesForPlayers: m.notesForPlayers,
    maxPlayers: m.maxPlayers,
    // World Link is an OOC staff planning doc: visible to fixers/admins, to
    // archivist approvers (who review non-posted missions), and to the trial
    // fixer who owns the mission (their own planning doc) — never to players.
    worldLink: canEdit || viewer.isArchivist ? m.worldLink : null,
    // Fixer-only briefing text: gated on canManage so it appears only inside the
    // Fixer tab (full fixers/admins on any mission; trial fixers on their own
    // approved/posted missions) and is never sent to players over the API.
    fixerNotes: canManage ? m.fixerNotes : null,
    fixerId: m.fixerId,
    fixerName: m.fixerName,
    fixerAvatarUrl: m.fixerAvatarUrl,
    fixerIsTrial: m.fixerIsTrial,
    discordEventId: m.discordEventId,
    discordSyncError: m.discordSyncError,
    canManage,
    // Author-level: full managers OR the trial fixer who owns this mission. Gates
    // the Edit + Submit-for-approval controls, NOT the management tools.
    canEdit,
    canApprove: viewer.isArchivist,
    completedAt: iso(m.completedAt),
    completedBy: m.completedBy,
    completedByName,
    // A full-manager owner fixer / admin / archivist may lock a not-yet-completed
    // mission. Trial fixers are author-only — completion is not theirs to do.
    canComplete: (viewer.isAdmin || viewer.isArchivist || (isOwnerFixer && viewer.isManager)) && !isCompleted,
    // Reopening a completed mission is admin/archivist only.
    canUncomplete: (viewer.isAdmin || viewer.isArchivist) && isCompleted,
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
      participationStatus: a.characterId != null ? (participationByChar.get(a.characterId) ?? null) : null,
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
          fixerId: r.fixerId,
          fixerName: r.fixerName,
          paidAt: iso(r.paidAt),
          createdAt: r.createdAt.toISOString(),
        }))
      : [],
    // Whether this mission is currently accepting NPC sign-ups.
    npcSignupOpen: missionAcceptsNpcSignup(m),
    // The viewer's own NPC sign-up (any state), echoed to everyone so the player
    // UI can show/withdraw it.
    mySignup: (() => {
      const mine = npcRows.find((r) => r.userId === viewer.id);
      if (!mine) return null;
      return {
        id: mine.id,
        characterId: mine.characterId,
        characterName: mine.characterName,
        state: mine.state,
        payAmount: mine.payAmount,
        paymentStatus: mine.paymentStatus,
        paidAt: iso(mine.paidAt),
      };
    })(),
    // Full NPC roster — manager-gated like actorPayments.
    npcSignups: canManage
      ? npcRows.map((r) => ({
          id: r.id,
          userId: r.userId,
          userName: r.userName,
          userAvatarUrl: r.userAvatarUrl,
          characterId: r.characterId,
          characterName: r.characterName,
          characterPortraitUrl: r.characterPortraitUrl,
          state: r.state,
          payAmount: r.payAmount,
          paymentStatus: r.paymentStatus,
          paymentError: r.paymentError,
          paidAt: iso(r.paidAt),
          createdAt: r.createdAt.toISOString(),
        }))
      : [],
    createdAt: m.createdAt.toISOString(),
    updatedAt: iso(m.updatedAt),
  };
}

/**
 * Manually lock/unlock a mission's completion state (separate from the
 * auto-managed `status` enum). Marking completed makes the mission read-only
 * for actor payments. Permissions:
 *   - complete  : owning fixer, admin, or archivist
 *   - uncomplete: admin or archivist only
 * Idempotent: completing an already-completed mission (or reopening an open
 * one) is a no-op success.
 */
export async function setMissionCompleted(
  missionId: number,
  completed: boolean,
  viewer: MissionViewer,
  req?: Request,
): Promise<{ ok: true } | { ok: false; httpStatus: number; error: string }> {
  const [m] = await db
    .select({ fixerId: missions.fixerId, completedAt: missions.completedAt })
    .from(missions)
    .where(eq(missions.id, missionId));
  if (!m) return { ok: false, httpStatus: 404, error: "Mission not found" };

  // Trial fixers are author-only and excluded from completion (manager guard);
  // only a full-manager owner fixer, admin, or archivist may lock a mission.
  const isOwnerFixer = m.fixerId != null && m.fixerId === viewer.id && viewer.isManager;

  if (completed) {
    if (!(viewer.isAdmin || viewer.isArchivist || isOwnerFixer)) {
      return { ok: false, httpStatus: 403, error: "Only the mission's fixer, an admin, or an archivist can mark it completed" };
    }
    if (m.completedAt) return { ok: true };
    await db
      .update(missions)
      .set({ completedAt: new Date(), completedBy: viewer.id })
      .where(eq(missions.id, missionId));
  } else {
    if (!(viewer.isAdmin || viewer.isArchivist)) {
      return { ok: false, httpStatus: 403, error: "Only an admin or archivist can reopen a completed mission" };
    }
    if (!m.completedAt) return { ok: true };
    await db
      .update(missions)
      .set({ completedAt: null, completedBy: null })
      .where(eq(missions.id, missionId));
  }

  await recordAudit({
    req,
    actorId: viewer.id,
    category: "mission",
    action: completed ? "mission.complete" : "mission.uncomplete",
    targetType: "mission",
    targetId: missionId,
    message: completed
      ? "Mission marked completed"
      : "Mission reopened",
  });

  return { ok: true };
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
      availability: missionApplications.availability,
      status: missionApplications.status,
      reviewedBy: missionApplications.reviewedBy,
      reviewedAt: missionApplications.reviewedAt,
      createdAt: missionApplications.createdAt,
      // Roster membership: a fixer can add a character via the roster editor,
      // which raises a participation request + assignment but never flips the
      // application row off 'pending'. Derive 'accepted' at read time when an
      // assignment exists so the mission-detail "YOUR APPLICATION" badge and the
      // fixer applicant list match the actual roster (and listMyApplications).
      assignedId: missionAssignments.id,
    })
    .from(missionApplications)
    .leftJoin(users, eq(users.id, missionApplications.userId))
    .leftJoin(characters, eq(characters.id, missionApplications.characterId))
    .leftJoin(
      missionAssignments,
      and(
        eq(missionAssignments.missionId, missionApplications.missionId),
        eq(missionAssignments.characterId, missionApplications.characterId),
      ),
    )
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
      availability: normalizeAvailability(r.availability),
      // Self-heal: a pending application whose character is on the roster is
      // effectively accepted (see assignedId note above).
      status: r.status === "pending" && r.assignedId != null ? "accepted" : r.status,
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

/**
 * Reviewed (accepted/rejected) applications for one applicant, newest first.
 * Powers the in-portal outcome banner so a player learns the result even if
 * the Discord DM never arrived. Withdrawn/pending applications are excluded —
 * there is no outcome to surface for those.
 */
export async function listApplicantOutcomes(userId: string, limit = 20) {
  const rows = await db
    .select({
      id: missionApplications.id,
      missionId: missionApplications.missionId,
      missionTitle: missions.title,
      characterId: missionApplications.characterId,
      characterName: characters.name,
      status: missionApplications.status,
      reviewedAt: missionApplications.reviewedAt,
    })
    .from(missionApplications)
    .innerJoin(missions, eq(missions.id, missionApplications.missionId))
    .leftJoin(characters, eq(characters.id, missionApplications.characterId))
    .where(
      and(
        eq(missionApplications.userId, userId),
        inArray(missionApplications.status, ["accepted", "rejected"]),
      ),
    )
    .orderBy(desc(missionApplications.reviewedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    missionId: r.missionId,
    missionTitle: r.missionTitle,
    characterId: r.characterId,
    characterName: r.characterName,
    status: r.status,
    reviewedAt: iso(r.reviewedAt),
  }));
}

export type ApplyResult =
  // `isEdit` distinguishes a brand-new sign-up (false/undefined) from an
  // in-place edit of an existing one (true) so callers can decide whether to
  // announce it (e.g. mission-thread updates post only on genuinely new ones).
  | { ok: true; isEdit?: boolean }
  | { ok: false; error: string; httpStatus: number };

/** Player applies to a posted mission with one of their own characters. */
export async function applyToMission(opts: {
  missionId: number;
  userId: string;
  characterId: number;
  comment?: string | null;
  // When2Meet availability (Task #244): absolute UTC ISO instants, one per
  // selected 30-minute block. Normalized to [] when omitted, so re-applying
  // always writes the current picker state (the apply form always sends it).
  availability?: string[] | null;
  // When true, persist the supplied weekly pattern + tz as the player's saved
  // default so future apply forms pre-fill from it.
  makeDefault?: boolean;
  defaultPattern?: { weekday: number; minutes: number }[] | null;
  timezone?: string | null;
}): Promise<ApplyResult> {
  const [m] = await db.select().from(missions).where(eq(missions.id, opts.missionId));
  if (!m) return { ok: false, error: "Mission not found", httpStatus: 404 };
  // Character must belong to the applicant.
  const [char] = await db.select().from(characters).where(eq(characters.id, opts.characterId));
  if (!char) return { ok: false, error: "Character not found", httpStatus: 404 };
  if (char.ownerId !== opts.userId) {
    return { ok: false, error: "That character isn't yours", httpStatus: 403 };
  }
  // Is there already an ACTIVE (pending/accepted) application for this character?
  // Editing one — e.g. an already-accepted player tweaking their availability so
  // the fixer can keep scheduling around it — is allowed for any UPCOMING mission,
  // not just while intake is open. A brand-new application (or re-applying after a
  // withdraw/reject) still requires the mission to be Open for applications.
  const [existing] = await db
    .select({ status: missionApplications.status })
    .from(missionApplications)
    .where(
      and(
        eq(missionApplications.missionId, opts.missionId),
        eq(missionApplications.characterId, opts.characterId),
      ),
    );
  const isActiveEdit = existing?.status === "pending" || existing?.status === "accepted";
  const upcoming = m.workflowState === "posted" && m.status !== "cancelled" && m.completedAt == null;
  if (isActiveEdit) {
    if (!upcoming) {
      return { ok: false, error: "This mission is closed", httpStatus: 409 };
    }
  } else if (m.workflowState !== "posted" || m.status !== "open") {
    return { ok: false, error: "This mission is not open for applications", httpStatus: 409 };
  }
  const comment = opts.comment?.trim() || null;
  const availability = normalizeAvailability(opts.availability);
  // Preserve an accepted application's roster status when the player is just
  // editing availability; otherwise (new / re-apply) (re)open it as pending.
  const preserveAccepted = existing?.status === "accepted";
  await db
    .insert(missionApplications)
    .values({
      missionId: opts.missionId,
      userId: opts.userId,
      characterId: opts.characterId,
      comment,
      availability,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: [missionApplications.missionId, missionApplications.characterId],
      set: {
        userId: opts.userId,
        comment,
        availability,
        updatedAt: new Date(),
        // Keep an accepted player on the roster; only (re)set pending otherwise.
        ...(preserveAccepted ? {} : { status: "pending", reviewedBy: null, reviewedAt: null }),
      },
    });
  // Optionally remember this as the player's weekly default for next time.
  if (opts.makeDefault) {
    await db
      .update(users)
      .set({
        defaultAvailability: normalizeDefaultPattern(opts.defaultPattern),
        availabilityTimezone: opts.timezone?.trim() || null,
      })
      .where(eq(users.id, opts.userId));
  }
  return { ok: true, isEdit: isActiveEdit };
}

/** Dedupe + sort UTC ISO availability instants; drop invalid entries. */
function normalizeAvailability(input: string[] | null | undefined): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const v of input) {
    if (typeof v !== "string") continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) continue;
    seen.add(new Date(t).toISOString());
  }
  return [...seen].sort();
}

/** Validate + dedupe a weekly availability pattern (weekday 0-6, 30-min blocks). */
function normalizeDefaultPattern(
  input: { weekday: number; minutes: number }[] | null | undefined,
): { weekday: number; minutes: number }[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: { weekday: number; minutes: number }[] = [];
  for (const v of input) {
    const weekday = Number(v?.weekday);
    const minutes = Number(v?.minutes);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1410) continue;
    const key = `${weekday}:${minutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ weekday, minutes });
  }
  return out;
}

/** Load the player's saved weekly availability default (for picker pre-fill). */
export async function getDefaultAvailability(userId: string): Promise<{
  pattern: { weekday: number; minutes: number }[];
  timezone: string | null;
}> {
  const [u] = await db
    .select({
      defaultAvailability: users.defaultAvailability,
      availabilityTimezone: users.availabilityTimezone,
    })
    .from(users)
    .where(eq(users.id, userId));
  return {
    pattern: normalizeDefaultPattern(u?.defaultAvailability ?? null),
    timezone: u?.availabilityTimezone ?? null,
  };
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
    .select({ fixerId: missions.fixerId, title: missions.title })
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
    await notifyApplicantOfReview({
      userId: app.userId,
      characterId: app.characterId,
      missionTitle: mission.title,
      action: "reject",
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
  await notifyApplicantOfReview({
    userId: app.userId,
    characterId: app.characterId,
    missionTitle: mission.title,
    action: "accept",
  });
  return { ok: true };
}

/**
 * Fixer removes an accepted player from a mission. Deleting the assignment row
 * also reverts that player's attendance (attendanceCreditedAt lives on the row,
 * so attendance counts drop back automatically) and any accepted application is
 * flipped back to 'withdrawn' so the slot is freed and they can re-apply.
 *
 * GUARD: a player who has already been *paid* (or is mid-payout) cannot be
 * removed — deleting a paid assignment would orphan a real eddies payout. The
 * fixer must reverse the payout first. Unpaid/failed/simulated rows are safe to
 * remove. NPC sign-ups / actor payments are a separate participation and are
 * intentionally left untouched.
 */
export async function removeAssignedPlayer(opts: {
  missionId: number;
  userId: string;
  viewer: MissionViewer;
  req?: Request;
}): Promise<ApplyResult> {
  const [mission] = await db
    .select({ fixerId: missions.fixerId, title: missions.title })
    .from(missions)
    .where(eq(missions.id, opts.missionId));
  if (!mission) return { ok: false, error: "Mission not found", httpStatus: 404 };
  // Only the mission's own fixer (or an admin) may manage its roster.
  if (!ownsMissionApplications(opts.viewer, mission.fixerId)) {
    return {
      ok: false,
      error: "Only the mission's fixer or an admin can remove its players",
      httpStatus: 403,
    };
  }

  const [assignment] = await db
    .select()
    .from(missionAssignments)
    .where(
      and(
        eq(missionAssignments.missionId, opts.missionId),
        eq(missionAssignments.userId, opts.userId),
      ),
    );
  if (!assignment) {
    return { ok: false, error: "That player isn't assigned to this mission", httpStatus: 404 };
  }
  if (assignment.paymentStatus === "paid" || assignment.paymentStatus === "processing") {
    return {
      ok: false,
      error:
        "This player has already been paid for this mission. Reverse the payout before removing them.",
      httpStatus: 409,
    };
  }

  const txResult = await db.transaction(async (tx): Promise<ApplyResult> => {
    // Re-read the row under a row lock so a concurrent payout cannot flip it to
    // 'processing'/'paid' between our pre-check and the delete. payMissionPlayers
    // claims the row via a conditional UPDATE, which contends on the same lock:
    // if pay commits first we observe its status here; if we commit first the
    // row is gone and pay's claim affects zero rows.
    const [locked] = await tx
      .select()
      .from(missionAssignments)
      .where(eq(missionAssignments.id, assignment.id))
      .for("update");
    if (!locked) {
      return { ok: false, error: "That player isn't assigned to this mission", httpStatus: 404 };
    }
    if (locked.paymentStatus === "paid" || locked.paymentStatus === "processing") {
      return {
        ok: false,
        error:
          "This player has already been paid for this mission. Reverse the payout before removing them.",
        httpStatus: 409,
      };
    }
    // Deleting the assignment reverts both the mission attachment and the
    // credited attendance (attendanceCreditedAt is a column on this row).
    await tx.delete(missionAssignments).where(eq(missionAssignments.id, assignment.id));
    // Free the application slot so the player can re-apply later.
    await tx
      .update(missionApplications)
      .set({ status: "withdrawn", updatedAt: new Date() })
      .where(
        and(
          eq(missionApplications.missionId, opts.missionId),
          eq(missionApplications.userId, opts.userId),
          eq(missionApplications.status, "accepted"),
        ),
      );
    return { ok: true };
  });
  if (!txResult.ok) return txResult;

  await recordAudit({
    req: opts.req,
    actorId: opts.viewer.id,
    action: "mission_player_removed",
    category: "mission",
    targetType: "mission",
    targetId: String(opts.missionId),
    message: `Removed player ${opts.userId} (character ${assignment.characterId ?? "none"}) from mission`,
  });
  return { ok: true };
}

// ===========================================================================
// NPC SIGN-UPS (Task #185) — players sign up to act as an NPC on a
// not-yet-completed mission; the mission's fixer later confirms attendance
// (which pays them) or marks a no-show.
// ===========================================================================

// A mission accepts NPC sign-ups only while it is publicly posted and has not
// been completed or cancelled. Completion is BOTH the manual `completedAt` lock
// and any of the completed_* lifecycle statuses.
const NPC_SIGNUP_BLOCKED_STATUSES = [
  "completed",
  "completed_players_paid",
  "completed_paid",
  "cancelled",
] as const;
function missionAcceptsNpcSignup(m: {
  workflowState: string;
  status: string;
  completedAt: Date | null;
}): boolean {
  return (
    m.workflowState === "posted" &&
    m.completedAt == null &&
    !(NPC_SIGNUP_BLOCKED_STATUSES as readonly string[]).includes(m.status)
  );
}

/** Player signs up to act as an NPC on a posted, not-yet-completed mission. */
export async function signUpAsNpc(opts: {
  missionId: number;
  userId: string;
  characterId?: number | null;
}): Promise<ApplyResult> {
  const [m] = await db.select().from(missions).where(eq(missions.id, opts.missionId));
  if (!m) return { ok: false, error: "Mission not found", httpStatus: 404 };
  if (!missionAcceptsNpcSignup(m)) {
    return { ok: false, error: "This mission is not accepting NPC sign-ups", httpStatus: 409 };
  }
  let characterId = opts.characterId ?? null;
  if (characterId != null) {
    const [char] = await db.select().from(characters).where(eq(characters.id, characterId));
    if (!char) return { ok: false, error: "Character not found", httpStatus: 404 };
    if (char.ownerId !== opts.userId) {
      return { ok: false, error: "That character isn't yours", httpStatus: 403 };
    }
  }
  // At most one ACTIVE (signed_up) row per (mission, user): the partial unique
  // index + onConflictDoNothing makes a re-signup idempotent under races
  // (pending-row-dedup). If they already have an active sign-up we only refresh
  // its character choice.
  const inserted = await db
    .insert(missionNpcSignups)
    .values({ missionId: opts.missionId, userId: opts.userId, characterId, state: "signed_up" })
    .onConflictDoNothing({
      target: [missionNpcSignups.missionId, missionNpcSignups.userId],
      where: sql`state = 'signed_up'`,
    })
    .returning({ id: missionNpcSignups.id });
  if (inserted.length === 0) {
    await db
      .update(missionNpcSignups)
      .set({ characterId })
      .where(
        and(
          eq(missionNpcSignups.missionId, opts.missionId),
          eq(missionNpcSignups.userId, opts.userId),
          eq(missionNpcSignups.state, "signed_up"),
        ),
      );
  }
  // isEdit=true when no new row was inserted (idempotent re-signup / character
  // swap) so callers don't re-announce an existing sign-up.
  return { ok: true, isEdit: inserted.length === 0 };
}

/** Player withdraws their own active (not-yet-confirmed) NPC sign-up. */
export async function withdrawNpcSignup(opts: {
  missionId: number;
  userId: string;
}): Promise<ApplyResult> {
  const deleted = await db
    .delete(missionNpcSignups)
    .where(
      and(
        eq(missionNpcSignups.missionId, opts.missionId),
        eq(missionNpcSignups.userId, opts.userId),
        eq(missionNpcSignups.state, "signed_up"),
      ),
    )
    .returning({ id: missionNpcSignups.id });
  if (deleted.length === 0) {
    return { ok: false, error: "No active NPC sign-up to withdraw", httpStatus: 404 };
  }
  return { ok: true };
}

/**
 * Fixer confirms an NPC sign-up. action=attended marks the sign-up attended and
 * pays the player the mission's npcPayAmount (recorded as a mission actor
 * payment so it surfaces in reports + the player's Acting tab; idempotent via
 * the (mission, user) PAID partial unique index). action=no_show marks the
 * sign-up resolved with no payout. Cancelled missions refuse confirmation (the
 * completion lock was removed in #185 — completed missions CAN still confirm).
 */
/**
 * Best-effort: record an already-settled ACTOR/NPC payout into the website
 * wallet ledger so it surfaces in the actor's wallet/transaction history.
 *
 * Actor/NPC payouts call patchBalance (UnbelievaBoat) DIRECTLY and bypass
 * applyWalletDelta (gated on mission live mode, not the economy kill-switch), so
 * without this the eddies only ever appear as a generic 'reconcile' row later.
 * Mirrors the player mission-pay path. A failure here must never unwind a payout
 * that already moved real money — the reconcile cron folds the UB delta in later
 * if this misses. Skips non-positive amounts (no money moved). Idempotent on the
 * mission_actor_payments row id so re-runs and a backfill share one key.
 */
async function recordActorPayoutLedger(opts: {
  userId: string;
  amount: number;
  ubTotalAfter: number;
  memo: string;
  paymentRowId: number;
  relatedEntityType: string;
  relatedEntityId: number | null;
}): Promise<void> {
  if (opts.amount <= 0) return;
  try {
    await recordSettledWalletMovement({
      userId: opts.userId,
      amount: opts.amount,
      ubTotalAfter: opts.ubTotalAfter,
      source: "mission",
      kind: "mission",
      memo: opts.memo,
      characterId: null,
      relatedEntityType: opts.relatedEntityType,
      relatedEntityId: opts.relatedEntityId,
      idempotencyKey: `actor_payout:${opts.paymentRowId}`,
    });
  } catch (err) {
    logger.warn(
      { err, paymentRowId: opts.paymentRowId },
      "actor payout ledger record failed (reconcile will fold the UB delta)",
    );
  }
}

export async function confirmNpcSignup(opts: {
  missionId: number;
  signupId: number;
  action: "attended" | "no_show";
  viewer: MissionViewer;
  req?: Request;
}): Promise<{ ok: true } | { ok: false; error: string; httpStatus: number }> {
  const [signup] = await db
    .select()
    .from(missionNpcSignups)
    .where(eq(missionNpcSignups.id, opts.signupId));
  if (!signup || signup.missionId !== opts.missionId) {
    return { ok: false, error: "Sign-up not found", httpStatus: 404 };
  }
  const [mission] = await db.select().from(missions).where(eq(missions.id, opts.missionId));
  if (!mission) return { ok: false, error: "Mission not found", httpStatus: 404 };
  // Only the mission's own fixer (or an admin) may confirm its sign-ups.
  if (!ownsMissionApplications(opts.viewer, mission.fixerId)) {
    return {
      ok: false,
      error: "Only the mission's fixer or an admin can confirm NPC sign-ups",
      httpStatus: 403,
    };
  }
  if (mission.status === "cancelled") {
    return { ok: false, error: "This mission is cancelled. Cancelled missions cannot pay actors.", httpStatus: 409 };
  }

  if (opts.action === "no_show") {
    await db
      .update(missionNpcSignups)
      .set({ state: "no_show", paymentStatus: "unpaid", payAmount: null, paymentError: null, paidAt: null })
      .where(eq(missionNpcSignups.id, signup.id));
    await recordAudit({
      req: opts.req,
      actorId: opts.viewer.id,
      category: "mission",
      action: "mission.npc_no_show",
      targetType: "mission",
      targetId: opts.missionId,
      message: `Marked NPC sign-up ${signup.id} (user ${signup.userId}) as no-show`,
    });
    await applySecondPhaseStatus(opts.missionId);
    return { ok: true };
  }

  // action === "attended": idempotent if already paid/simulated.
  if (signup.state === "attended" && (signup.paymentStatus === "paid" || signup.paymentStatus === "simulated")) {
    return { ok: true };
  }

  const ctx = await getMissionContext();
  const amount = mission.npcPayAmount;
  const now = new Date();
  const [u] = await db
    .select({ id: users.id, discordId: users.discordId, username: users.username })
    .from(users)
    .where(eq(users.id, signup.userId));

  const payerId = opts.viewer.id;
  let payerName: string | null = null;
  {
    const [payer] = await db
      .select({ username: users.username, globalName: users.globalName })
      .from(users)
      .where(eq(users.id, payerId));
    payerName = payer?.globalName ?? payer?.username ?? null;
  }

  const actorBase = {
    missionId: opts.missionId,
    missionName: mission.title,
    userId: signup.userId,
    userName: u?.username ?? null,
    fixerId: payerId,
    fixerName: payerName,
    missionDate: mission.startAt,
    amount,
    source: "manual" as const,
    attendanceCreditedAt: now,
    paidAt: now,
  };

  const setSignup = (over: Partial<typeof missionNpcSignups.$inferInsert>) =>
    db
      .update(missionNpcSignups)
      .set({ state: "attended", payAmount: amount, ...over })
      .where(eq(missionNpcSignups.id, signup.id));

  if (!ctx.live) {
    await db.insert(missionActorPayments).values({ ...actorBase, paymentStatus: "simulated" });
    await setSignup({ paymentStatus: "simulated", paymentError: null, paidAt: now });
  } else {
    // Reserve the unique (mission, actor) PAID slot up-front, gated on the
    // mission not being cancelled (mirrors payMissionActors). The completion
    // lock is gone, so completedAt is NOT checked.
    const reservedRes = await db.execute(sql`
      INSERT INTO mission_actor_payments
        (mission_id, mission_name, user_id, user_name, fixer_id, fixer_name,
         mission_date, amount, source, attendance_credited_at, paid_at, payment_status)
      SELECT ${opts.missionId}, ${mission.title}, ${signup.userId}, ${u?.username ?? null},
             ${payerId}, ${payerName}, ${mission.startAt}, ${amount}, 'manual',
             ${now}, ${now}, 'paid'
      WHERE EXISTS (
        SELECT 1 FROM missions WHERE id = ${opts.missionId} AND status <> 'cancelled'
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    const reserved = (reservedRes.rows ?? []) as Array<{ id: number }>;
    if (reserved.length === 0) {
      // The actor is already paid for this mission (a prior actor/NPC payout) —
      // treat the sign-up as settled rather than double-paying.
      await setSignup({ paymentStatus: "paid", paymentError: null, paidAt: now });
    } else {
      const reservedId = reserved[0].id;
      if (!u?.discordId) {
        await db
          .update(missionActorPayments)
          .set({ paymentStatus: "failed", paymentError: "No Discord id for actor", paidAt: null })
          .where(eq(missionActorPayments.id, reservedId));
        await setSignup({ paymentStatus: "failed", paymentError: "No Discord id for actor", paidAt: null });
      } else {
        const balance =
          amount > 0
            ? await patchBalance(u.discordId, { cash: amount, reason: `NPC pay: ${mission.title}` })
            : { cash: 0, bank: 0, total: 0, source: "local" as const };
        if (balance == null) {
          await db
            .update(missionActorPayments)
            .set({ paymentStatus: "failed", paymentError: "UnbelievaBoat payout failed", paidAt: null })
            .where(eq(missionActorPayments.id, reservedId));
          await setSignup({ paymentStatus: "failed", paymentError: "UnbelievaBoat payout failed", paidAt: null });
        } else {
          await setSignup({ paymentStatus: "paid", paymentError: null, paidAt: now });
          await recordActorPayoutLedger({
            userId: signup.userId,
            amount,
            ubTotalAfter: balance.total,
            memo: `NPC payout: ${mission.title}`,
            paymentRowId: reservedId,
            relatedEntityType: "mission",
            relatedEntityId: opts.missionId,
          });
          if (u.username || u.discordId) {
            await postToChannel(
              ctx.npcSpendingChannelId,
              `**NPC payout** — ${mission.title} (#${mission.id})\n<@${u.discordId}>${u.username ? ` (${u.username})` : ""}: +${amount.toLocaleString()} eddies`,
            ).catch((err) => logger.warn({ err, missionId: opts.missionId }, "npc payout post failed"));
          }
        }
      }
    }
  }

  await recordAudit({
    req: opts.req,
    actorId: opts.viewer.id,
    category: "mission",
    action: "mission.npc_confirm",
    targetType: "mission",
    targetId: opts.missionId,
    message: `${ctx.live ? "LIVE" : "TEST"} confirmed NPC sign-up ${signup.id} (user ${signup.userId}) attended — pay ${amount}`,
  });

  await applySecondPhaseStatus(opts.missionId);
  return { ok: true };
}

// Re-evaluate completed_players_paid → completed_paid after an NPC sign-up was
// actioned. Only advances when players are already fully paid and no sign-up is
// still outstanding.
async function applySecondPhaseStatus(missionId: number): Promise<void> {
  const [m] = await db.select({ status: missions.status }).from(missions).where(eq(missions.id, missionId));
  if (!m) return;
  const npc = await getNpcSettlement(missionId);
  const newStatus = statusAfterSecondPhase(m.status, npc.outstanding);
  if (newStatus !== m.status) {
    await db.update(missions).set({ status: newStatus }).where(eq(missions.id, missionId));
  }
}

/**
 * Notify an applicant via Discord DM that their mission application was accepted
 * or rejected. Fail-safe: respects the missions Test/Live gate (Test mode only
 * logs) and never throws — a delivery miss (DMs disabled, no bot token, Discord
 * error) must not block the fixer's accept/reject action. Mirrors the
 * fail-safe, live-gated pattern used by the NPC announcement cron.
 */
async function notifyApplicantOfReview(opts: {
  userId: string;
  characterId: number;
  missionTitle: string;
  action: "accept" | "reject";
}): Promise<void> {
  try {
    const ctx = await getMissionContext();
    const [char] = await db
      .select({ name: characters.name })
      .from(characters)
      .where(eq(characters.id, opts.characterId));
    const name = char?.name?.trim();
    const content =
      opts.action === "accept"
        ? `${name ?? "Your character"} was accepted for the mission "${opts.missionTitle}". Check the mission board for details.`
        : `Your application for ${name ?? "your character"} to the mission "${opts.missionTitle}" was declined this time. Keep an eye on the board for other jobs.`;
    if (ctx.live) {
      await sendDirectMessage(opts.userId, content);
    } else {
      logger.info(
        { userId: opts.userId, action: opts.action, missionTitle: opts.missionTitle },
        "[test mode] would DM applicant of review outcome",
      );
    }
  } catch (err) {
    logger.warn({ err, userId: opts.userId, action: opts.action }, "applicant review DM failed");
  }
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
  // outside deployments). Only announce when the mission is actually open.
  if (nextStatus === "open") {
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

// ===========================================================================
// PRE-MISSION NPC ANNOUNCEMENT (Task #62) — posts to #npc-announcements ~1h
// before start, once per mission (idempotent via npcAnnouncedAt; cleared on
// reschedule). Gated by Test/Live mode.
// ===========================================================================

// ===========================================================================
// MISSION DISCUSSION THREAD (deployment-gated, off the fixer job-proposal brief)
// ===========================================================================

// Role pinged when a new mission's brief is posted to the fixer job-proposal
// channel. The discussion thread is a fixer-only planning space, so we ping the
// Fixer role (not @Choom — the public sign-up announcement is separate). Pinging
// requires the role id in both the content (`<@&id>`) and allowed_mentions.roles.
const FIXER_ROLE_ID = "1348633945545379911";

const TIER_NAMES: Record<number, string> = {
  1: "Street Work",
  2: "Contract Work",
  3: "High Risk Operation",
  4: "Extreme",
};

// Build the full mission brief (content + embed) posted to the #missions
// discussion channel, off which the per-mission thread is started.
function buildMissionBrief(m: Mission): { content: string; embeds: unknown[] } {
  const startUnix = m.startAt ? Math.floor(m.startAt.getTime() / 1000) : null;
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Tier", value: `${m.tier} — ${TIER_NAMES[m.tier] ?? "Unknown"}`, inline: true },
    { name: "Job Type", value: m.jobType ? jobTypeLabel(m.jobType) : "—", inline: true },
    { name: "Client", value: m.client || "—", inline: true },
    { name: "Location", value: m.location || "—", inline: true },
    {
      name: "Start / Duration",
      value: `${startUnix ? `<t:${startUnix}:F>` : "Not scheduled"} · ${m.durationMinutes}m`,
      inline: true,
    },
    { name: "Player Pay", value: `€$${m.playerPay.toLocaleString()}`, inline: true },
    { name: "NPC Pay", value: `€$${m.npcPayAmount.toLocaleString()}`, inline: true },
    {
      name: "Slots / Max Players",
      value: `${m.slots || "—"} slots · ${m.maxPlayers > 0 ? `${m.maxPlayers} max` : "unlimited"}`,
      inline: true,
    },
    { name: "Requested Skills", value: m.requestedSkills || "—", inline: false },
  ];
  if (m.worldLink) fields.push({ name: "World Link", value: m.worldLink, inline: false });
  if (m.notesForPlayers) fields.push({ name: "Notes for Players", value: m.notesForPlayers.slice(0, 1024), inline: false });
  fields.push({ name: "Mission", value: buildMissionUrl(m.id), inline: false });
  return {
    content: `<@&${FIXER_ROLE_ID}> **New mission created — ${m.title}**`,
    embeds: [
      {
        title: m.title,
        description: m.description ? m.description.slice(0, 4096) : undefined,
        fields,
        ...(m.imageUrl ? { image: { url: m.imageUrl } } : {}),
      },
    ],
  };
}

/**
 * Idempotently ensure a mission has a Discord discussion thread linked.
 *
 * - If a thread is already linked, this is a no-op (no duplicate brief/thread).
 * - Otherwise it reuses an existing brief message id when one is stored
 *   (threading off it rather than re-posting), or posts a fresh brief and
 *   persists `discordMessageId` BEFORE creating the thread so a crash mid-flight
 *   is recoverable by a later re-run.
 * - `discordThreadId` is set ONLY when the thread helper returns non-null
 *   (never `threadId ?? msgId`). The Discord "thread already created" (160004)
 *   response is treated as success by startThreadFromMessage (returns msgId).
 *
 * All writes go through the deployment-gated post helpers, so this no-ops
 * outside a real deployment (unless ALLOW_EXTERNAL_WRITES=1). Returns whether a
 * thread was newly linked THIS call, so a backfill knows when to seed the
 * current-state snapshot.
 */
export async function ensureMissionThread(
  m: Mission,
  channelId: string,
): Promise<{ created: boolean; threadId: string | null }> {
  if (!channelId) return { created: false, threadId: m.discordThreadId ?? null };
  if (m.discordThreadId) return { created: false, threadId: m.discordThreadId };

  // The mission thread channel (#fixer-job-proposals) is a Discord FORUM
  // channel, which has no top-level messages — you can't post a brief then
  // thread off it. A forum "post" IS a thread whose body is sent in the same
  // create call, and the forum requires a tag. Detect the channel type so this
  // works whether an admin points the config at a forum OR a text channel.
  const meta = await getChannelMeta(channelId);
  if (meta?.type === FORUM_CHANNEL_TYPE) {
    const brief = buildMissionBrief(m);
    const tagId = pickMissionForumTagId(meta.tags, m);
    const threadId = await createForumThread(channelId, m.title, brief.content, brief.embeds, {
      allowedMentions: { roles: [FIXER_ROLE_ID] },
      appliedTags: tagId ? [tagId] : undefined,
    });
    // null = no token, suppressed write (non-deployment), or a create failure
    // (e.g. missing required tag). Leave the row unlinked so a later run retries.
    if (!threadId) return { created: false, threadId: null };
    // For a forum thread the starter message id equals the thread id, so both
    // columns point at it (lifecycle updates post into the thread by id).
    await db
      .update(missions)
      .set({ discordThreadId: threadId, discordMessageId: threadId })
      .where(eq(missions.id, m.id));
    return { created: true, threadId };
  }

  // Text / announcement channel: post the brief, then start a thread off it.
  let msgId = m.discordMessageId ?? null;
  if (!msgId) {
    const brief = buildMissionBrief(m);
    msgId = await postToChannel(channelId, brief.content, brief.embeds, { roles: [FIXER_ROLE_ID] });
    // null = no token, suppressed write (non-deployment), or a post failure.
    // Leave the row unlinked so a later run retries.
    if (!msgId) return { created: false, threadId: null };
    await db.update(missions).set({ discordMessageId: msgId }).where(eq(missions.id, m.id));
  }
  const threadId = await startThreadFromMessage(channelId, msgId, m.title);
  if (!threadId) return { created: false, threadId: null };
  await db.update(missions).set({ discordThreadId: threadId }).where(eq(missions.id, m.id));
  return { created: true, threadId };
}

/**
 * Pick the forum tag for a mission's thread. The #fixer-job-proposals forum has
 * "require tag" on, so a thread create with no tag is rejected — we always
 * return a tag id when the forum has any tags. A posted (live) mission maps to
 * the "Approved" tag; anything earlier (draft/proposal) maps to "WIP". Falls
 * back to the first available tag so a renamed/missing tag never blocks creation.
 */
function pickMissionForumTagId(tags: { id: string; name: string }[], m: Mission): string | undefined {
  if (tags.length === 0) return undefined;
  const byName = (n: string) => tags.find((t) => t.name.toLowerCase() === n.toLowerCase())?.id;
  const wanted = m.workflowState === "posted" ? byName("Approved") : byName("WIP");
  return wanted ?? tags[0].id;
}

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

// Cap per section so a huge roster can't blow past Discord's 2000-char message
// limit; the overflow is summarized with a "+N more" line.
const SNAPSHOT_SECTION_CAP = 30;

function snapshotSection(title: string, lines: string[]): string {
  if (lines.length === 0) return `**${title} (0)**\n_None._`;
  const shown = lines.slice(0, SNAPSHOT_SECTION_CAP);
  const extra = lines.length - shown.length;
  const body = shown.join("\n") + (extra > 0 ? `\n…and ${extra} more` : "");
  return `**${title} (${lines.length})**\n${body}`;
}

function participantLabel(userName: string | null, characterName: string | null): string {
  const u = userName ?? "Someone";
  return characterName ? `• **${u}** (${characterName})` : `• **${u}**`;
}

/**
 * Build a single consolidated "current state" snapshot for a mission's thread:
 * the accepted roster, any pending applicants, and active NPC sign-ups. Mentions
 * are suppressed by the caller (parse: []), so the names here never ping.
 */
async function buildMissionThreadSnapshot(missionId: number): Promise<string> {
  const assignments = (await loadAssignments([missionId])).get(missionId) ?? [];
  const apps = await listApplicationViews(missionId);
  const pending = apps.filter((a) => a.status === "pending");
  const npcRows = await db
    .select({
      userName: users.username,
      characterName: characters.name,
    })
    .from(missionNpcSignups)
    .leftJoin(users, eq(users.id, missionNpcSignups.userId))
    .leftJoin(characters, eq(characters.id, missionNpcSignups.characterId))
    .where(
      and(
        eq(missionNpcSignups.missionId, missionId),
        inArray(missionNpcSignups.state, ["signed_up", "attended"]),
      ),
    )
    .orderBy(missionNpcSignups.id);

  const rosterLines = assignments.map((a) => participantLabel(a.userName, a.characterName));
  const pendingLines = pending.map((a) => participantLabel(a.userName, a.characterName));
  const npcLines = npcRows.map((r) => participantLabel(r.userName, r.characterName));

  return [
    "📋 **Current mission state** (backfilled snapshot)",
    snapshotSection("Accepted roster", rosterLines),
    snapshotSection("Pending applicants", pendingLines),
    snapshotSection("NPC sign-ups", npcLines),
  ].join("\n\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
export async function runMissionThreadBackfill(opts: { limit?: number } = {}): Promise<{
  scanned: number;
  created: number;
  seeded: number;
  failed: number;
}> {
  const ctx = await getMissionContext();
  const targets = await db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.workflowState, "posted"),
        notInArray(missions.status, HISTORY_STATUSES),
        // Needs a thread, or has one but no snapshot yet (retry partial failures).
        or(isNull(missions.discordThreadId), isNull(missions.discordThreadSnapshotAt)),
      ),
    )
    .orderBy(missions.id)
    .limit(opts.limit ?? 500);

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

// A status that the payment lifecycle is allowed to advance. `cancelled` (and
// any unknown value) is left untouched.
function isAdvanceableStatus(status: string): boolean {
  return (
    status === "open" ||
    status === "pending" ||
    status === "completed" ||
    status === "completed_players_paid" ||
    status === "completed_paid"
  );
}

// Second-phase settlement (Task #185). `completed_paid` requires ALL assigned
// players paid AND every NPC sign-up actioned on (no outstanding sign-ups).
// A no-NPC, no-actor mission can never satisfy the "second phase" so it rests at
// `completed_players_paid` (matching the pre-#185 behaviour where a mission with
// no actor payouts never reached completed_paid). `secondPhaseSettled` is true
// once at least one actor payout OR one resolved NPC sign-up exists.
type NpcSettlement = { outstanding: boolean; anyResolved: boolean };

// An NPC sign-up is "resolved" once a fixer has actioned it: a no_show, or an
// attended sign-up whose pay settled (paid/simulated). A signed_up row, or an
// attended row still owing money, is outstanding.
function isNpcSignupResolved(s: { state: string; paymentStatus: string }): boolean {
  if (s.state === "no_show") return true;
  if (s.state === "attended") return s.paymentStatus === "paid" || s.paymentStatus === "simulated";
  return false;
}

async function getNpcSettlement(missionId: number): Promise<NpcSettlement> {
  const rows = await db
    .select({ state: missionNpcSignups.state, paymentStatus: missionNpcSignups.paymentStatus })
    .from(missionNpcSignups)
    .where(eq(missionNpcSignups.missionId, missionId));
  let outstanding = false;
  let anyResolved = false;
  for (const r of rows) {
    if (isNpcSignupResolved(r)) anyResolved = true;
    else outstanding = true;
  }
  return { outstanding, anyResolved };
}

// After players are fully paid, pick the resting status given the second-phase
// state. Reaches completed_paid only when nothing is outstanding AND a real
// second-phase action exists; otherwise completed_players_paid.
function statusAfterPlayersPaid(
  status: string,
  secondPhaseSettled: boolean,
  npcOutstanding: boolean,
): string {
  if (!isAdvanceableStatus(status)) return status;
  return secondPhaseSettled && !npcOutstanding ? "completed_paid" : "completed_players_paid";
}

// A second-phase action (actor pay / NPC confirm) just happened. Only advance a
// mission whose players are already paid (completed_players_paid → completed_paid)
// and only when no NPC sign-up is still outstanding.
function statusAfterSecondPhase(status: string, npcOutstanding: boolean): string {
  if (status === "completed_players_paid" && !npcOutstanding) return "completed_paid";
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
    // Re-check cancellation AFTER claiming and BEFORE the irreversible UB
    // payout: a mission cancelled mid-loop must not keep paying the remaining
    // players. Release the claim back to its prior state and stop.
    const [fresh] = await db
      .select({ status: missions.status })
      .from(missions)
      .where(eq(missions.id, missionId));
    if (fresh?.status === "cancelled") {
      await db
        .update(missionAssignments)
        .set({ paymentStatus: a.paymentStatus })
        .where(eq(missionAssignments.id, a.id));
      break;
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
      // The eddies already moved in UnbelievaBoat above (patchBalance). Mission
      // pay deliberately bypasses applyWalletDelta (it's gated on mission live
      // mode, not the economy kill-switch), so without this the payout would
      // only ever surface in the website ledger as a generic 'reconcile' entry.
      // Record a settled 'mission' ledger row so it shows in the player's
      // wallet/Ledger history as a mission payout. Best-effort: a failure here
      // must not unwind a payout that already happened — the reconcile cron will
      // fold the UB delta in later if this misses.
      try {
        await recordSettledWalletMovement({
          userId: a.userId,
          amount,
          ubTotalAfter: balance.total,
          source: "mission",
          kind: "mission",
          memo: `Mission payout: ${mission.title}`,
          characterId: a.characterId ?? null,
          relatedEntityType: "mission",
          relatedEntityId: missionId,
          idempotencyKey: `mission_payout:${a.id}`,
        });
      } catch (err) {
        logger.warn({ err, missionId, assignmentId: a.id }, "mission payout ledger record failed (reconcile will fold the UB delta)");
      }
      void notifyMissionPayout({
        discordId,
        amount,
        missionTitle: mission.title,
        newBalance: balance.cash,
      });
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
  // Second phase is settled if any actor payout exists OR any NPC sign-up has
  // been resolved by a fixer. An outstanding NPC sign-up holds the mission at
  // completed_players_paid until it's actioned.
  const npc = await getNpcSettlement(missionId);
  const secondPhaseSettled = actorsSettled.length > 0 || npc.anyResolved;
  const newStatus = allResolved
    ? statusAfterPlayersPaid(mission.status, secondPhaseSettled, npc.outstanding)
    : mission.status;
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
): Promise<PayActorsResult | null | { blocked: "cancelled" }> {
  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId));
  if (!mission) return null;
  // Task #185 removed the completion lock: fixers may pay actors at any time,
  // including after a mission is marked completed. The ONLY refusal is a
  // cancelled mission — a called-off mission never pays out (mirrors
  // payMissionPlayers). Cancelling sets status='cancelled' (not completedAt).
  if (mission.status === "cancelled") return { blocked: "cancelled" };
  const ctx = await getMissionContext();
  const result: PayActorsResult = { paid: 0, simulated: 0, failed: 0, skipped: 0, live: ctx.live };

  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length === 0) return result;

  const userRows = await db
    .select({ id: users.id, discordId: users.discordId, username: users.username })
    .from(users)
    .where(inArray(users.id, uniqueIds));
  const userById = new Map(userRows.map((u) => [u.id, u]));

  // Actors picked from the Discord-guild search may have no `users` row yet
  // (never signed in to the portal). Mint a stub keyed on their Discord id so
  // the NOT NULL FK on mission_actor_payments.user_id is satisfied and the
  // payout (which credits by Discord id) can proceed; their first login adopts
  // the same row.
  for (const id of uniqueIds) {
    if (userById.has(id)) continue;
    const provisioned = await resolveOrProvisionUser(id);
    if (provisioned) {
      userById.set(id, { id: provisioned.id, discordId: provisioned.discordId, username: provisioned.username });
    }
  }

  // Resolve the fixer/admin who is issuing this payment, so the actor-payment
  // history shows WHO paid each actor (not the mission's owning fixer).
  const payerId = opts.actorId ?? mission.fixerId ?? null;
  let payerName = opts.actorName ?? null;
  if (!payerName && payerId) {
    const [payer] = await db
      .select({ username: users.username, globalName: users.globalName })
      .from(users)
      .where(eq(users.id, payerId));
    payerName = payer?.globalName ?? payer?.username ?? null;
  }

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
    if (!u) {
      // No `users` row and provisioning failed (Discord unreachable or an
      // unknown id). We can't satisfy the NOT NULL FK on user_id, so skip the
      // insert entirely — counting it failed — rather than throwing a 23503
      // mid-batch after earlier actors were already paid.
      result.failed++;
      continue;
    }
    const base = {
      missionId,
      missionName: mission.title,
      userId,
      userName: u?.username ?? null,
      fixerId: payerId,
      fixerName: payerName,
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
    // the race gets nothing back and skips.
    //
    // The reservation is an INSERT ... SELECT gated on the mission still NOT
    // being cancelled. This re-checks the cancellation guard ATOMICALLY with the
    // reservation: if a concurrent cancel committed before this statement runs,
    // the subquery yields no row and nothing is reserved — closing the
    // check-then-act race between the top-of-function read and the payout. (The
    // completion lock was removed in Task #185, so completedAt is NOT checked.)
    // The guard runs inside the DB, so no lock is held across the external
    // UnbelievaBoat call below.
    const reservedRes = await db.execute(sql`
      INSERT INTO mission_actor_payments
        (mission_id, mission_name, user_id, user_name, fixer_id, fixer_name,
         mission_date, amount, source, attendance_credited_at, paid_at, payment_status)
      SELECT ${missionId}, ${mission.title}, ${userId}, ${u?.username ?? null},
             ${payerId}, ${payerName}, ${mission.startAt}, ${amount}, 'manual',
             ${now}, ${now}, 'paid'
      WHERE EXISTS (
        SELECT 1 FROM missions
        WHERE id = ${missionId} AND status <> 'cancelled'
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    const reserved = (reservedRes.rows ?? []) as Array<{ id: number }>;
    if (reserved.length === 0) {
      // Either the actor is already paid (conflict) or the mission was cancelled
      // mid-flight. Both mean "no payout"; no money has moved.
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
      await recordActorPayoutLedger({
        userId,
        amount,
        ubTotalAfter: balance.total,
        memo: `Actor payout: ${mission.title}`,
        paymentRowId: reservedId,
        relatedEntityType: "mission",
        relatedEntityId: missionId,
      });
      postedLines.push(`<@${u.discordId}>${u.username ? ` (${u.username})` : ""}: +${amount.toLocaleString()} eddies`);
    }
  }

  // Actor payouts are NPC spending — they post ONLY to #npc-spending, never to
  // #banking (which is reserved for automatic player payouts).
  if (ctx.live && postedLines.length > 0) {
    const body = [`**Actor payout** — ${mission.title} (#${mission.id})`, ...postedLines].join("\n");
    await postToChannel(ctx.npcSpendingChannelId, body).catch((err) =>
      logger.warn({ err, missionId }, "npc spending post failed"),
    );
  }

  if (result.paid > 0 || result.simulated > 0) {
    // Advance completed_players_paid → completed_paid only when no NPC sign-up
    // is still outstanding (Task #185).
    const npc = await getNpcSettlement(missionId);
    const newStatus = statusAfterSecondPhase(mission.status, npc.outstanding);
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

/**
 * Pay a set of actors a flat amount each for a NON-mission event (a regular
 * session, an open social lobby, etc). These have no mission row — the event is
 * identified by a free-form label + date. Rows are stored in
 * `mission_actor_payments` with missionId = null, missionName = the label,
 * missionDate = the event date, and eventType = the preset category. They show
 * up in the reports ACTOR PAYMENTS aggregate alongside mission actor pay.
 *
 * Unlike mission payouts there is no all-time double-pay guard (the same actor
 * legitimately acts at many sessions); we only de-dupe within a single request.
 */
export async function payStandaloneActors(
  input: { eventName: string; eventType?: string | null; eventDate?: Date | null; eventId?: number | null; userIds: string[]; amount: number },
  opts: { req?: Request; actorId?: string | null; actorName?: string | null },
): Promise<PayActorsResult> {
  const ctx = await getMissionContext();
  const result: PayActorsResult = { paid: 0, simulated: 0, failed: 0, skipped: 0, live: ctx.live };

  const uniqueIds = [...new Set(input.userIds)];
  if (uniqueIds.length === 0) return result;

  const eventName = input.eventName.trim();
  const eventDate = input.eventDate ?? new Date();
  const amount = input.amount;

  const userRows = await db
    .select({ id: users.id, discordId: users.discordId, username: users.username })
    .from(users)
    .where(inArray(users.id, uniqueIds));
  const userById = new Map(userRows.map((u) => [u.id, u]));

  // Actors picked from the Discord-guild search may have no `users` row yet
  // (never signed in to the portal). Mint a stub keyed on their Discord id so
  // the NOT NULL FK on mission_actor_payments.user_id is satisfied and the
  // payout (which credits by Discord id) can proceed; their first login adopts
  // the same row.
  for (const id of uniqueIds) {
    if (userById.has(id)) continue;
    const provisioned = await resolveOrProvisionUser(id);
    if (provisioned) {
      userById.set(id, { id: provisioned.id, discordId: provisioned.discordId, username: provisioned.username });
    }
  }

  // Resolve the fixer/admin issuing the payment so history shows WHO paid.
  const payerId = opts.actorId ?? null;
  let payerName = opts.actorName ?? null;
  if (!payerName && payerId) {
    const [payer] = await db
      .select({ username: users.username, globalName: users.globalName })
      .from(users)
      .where(eq(users.id, payerId));
    payerName = payer?.globalName ?? payer?.username ?? null;
  }

  const now = new Date();
  const postedLines: string[] = [];

  for (const userId of uniqueIds) {
    const u = userById.get(userId);
    if (!u) {
      // No `users` row and provisioning failed (Discord unreachable or an
      // unknown id). We can't satisfy the NOT NULL FK on user_id, so skip the
      // insert entirely — counting it failed — rather than throwing a 23503
      // mid-batch after earlier actors were already paid.
      result.failed++;
      continue;
    }
    const base = {
      missionId: null,
      eventId: input.eventId ?? null,
      missionName: eventName,
      eventType: input.eventType ?? null,
      userId,
      userName: u?.username ?? null,
      fixerId: payerId,
      fixerName: payerName,
      missionDate: eventDate,
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

    // Event-bound payouts are deduped per (eventId, userId): if this actor was
    // already paid for this event, onConflictDoNothing skips the insert and we
    // count it as skipped rather than double-paying. Mission/legacy standalone
    // payouts keep their existing no-guard behaviour.
    const insertedRows = input.eventId != null
      ? await db
          .insert(missionActorPayments)
          .values({ ...base, paymentStatus: "paid" })
          .onConflictDoNothing({
            target: [missionActorPayments.eventId, missionActorPayments.userId],
            where: sql`payment_status = 'paid' and event_id is not null`,
          })
          .returning({ id: missionActorPayments.id })
      : await db
          .insert(missionActorPayments)
          .values({ ...base, paymentStatus: "paid" })
          .returning({ id: missionActorPayments.id });
    const inserted = insertedRows[0];
    if (!inserted) {
      // Already paid for this event — skip silently.
      result.skipped++;
      continue;
    }

    if (!u?.discordId) {
      await db
        .update(missionActorPayments)
        .set({ paymentStatus: "failed", paymentError: "No Discord id for actor", paidAt: null })
        .where(eq(missionActorPayments.id, inserted.id));
      result.failed++;
      continue;
    }
    const balance = amount > 0 ? await patchBalance(u.discordId, { cash: amount, reason: `Actor pay: ${eventName}` }) : { cash: 0, bank: 0, total: 0, source: "local" as const };
    if (balance == null) {
      await db
        .update(missionActorPayments)
        .set({ paymentStatus: "failed", paymentError: "UnbelievaBoat payout failed", paidAt: null })
        .where(eq(missionActorPayments.id, inserted.id));
      result.failed++;
    } else {
      result.paid++;
      await recordActorPayoutLedger({
        userId,
        amount,
        ubTotalAfter: balance.total,
        memo: `Actor payout: ${eventName}`,
        paymentRowId: inserted.id,
        relatedEntityType: input.eventId != null ? "event" : "actor_event",
        relatedEntityId: input.eventId ?? null,
      });
      postedLines.push(`<@${u.discordId}>${u.username ? ` (${u.username})` : ""}: +${amount.toLocaleString()} eddies`);
    }
  }

  // Actor payouts are NPC spending — post ONLY to #npc-spending.
  if (ctx.live && postedLines.length > 0) {
    const body = [`**Actor payout** — ${eventName}`, ...postedLines].join("\n");
    await postToChannel(ctx.npcSpendingChannelId, body).catch((err) =>
      logger.warn({ err, eventName }, "npc spending post failed (standalone actors)"),
    );
  }

  await recordAudit({
    req: opts.req,
    actorId: opts.actorId ?? null,
    actorName: opts.actorName ?? null,
    category: "mission",
    action: "actor.pay_standalone",
    targetType: "actor_event",
    targetId: null,
    message: `${ctx.live ? "LIVE" : "TEST"} standalone actor payout "${eventName}" (${amount} ea) — paid ${result.paid}, simulated ${result.simulated}, failed ${result.failed}`,
    after: { eventName, eventType: input.eventType ?? null, ...result },
  });

  return result;
}

/**
 * List non-mission actor payouts (missionId IS NULL), grouped by event
 * (label + date). Most recent first. Fixer/admin only. Drives the "recent
 * payouts" log on the standalone Pay Actors page.
 */
export async function getStandaloneActorPayouts() {
  const rows = await db
    .select()
    .from(missionActorPayments)
    .where(isNull(missionActorPayments.missionId))
    .orderBy(desc(missionActorPayments.attendanceCreditedAt), desc(missionActorPayments.createdAt));

  const byEvent = new Map<string, {
    key: string;
    eventName: string | null;
    eventType: string | null;
    eventDate: string | null;
    paidAt: string | null;
    fixerName: string | null;
    totalPaid: number;
    actorCount: number;
    actors: Array<{ id: number; userId: string; userName: string | null; amount: number; paymentStatus: string; paymentError: string | null }>;
  }>();
  for (const r of rows) {
    // Group by the per-batch timestamp written once to attendanceCreditedAt for
    // every row in a single payStandaloneActors() call. createdAt is set by a
    // column default per INSERT statement, so it differs row-to-row and would
    // fragment one payout batch into many single-actor "events".
    const batchStamp = iso(r.attendanceCreditedAt) ?? iso(r.createdAt) ?? "";
    const key = `${r.missionName ?? ""}|${iso(r.missionDate) ?? ""}|${r.eventType ?? ""}|${batchStamp}`;
    let agg = byEvent.get(key);
    if (!agg) {
      agg = {
        key,
        eventName: r.missionName,
        eventType: r.eventType,
        eventDate: iso(r.missionDate),
        paidAt: batchStamp || null,
        fixerName: r.fixerName,
        totalPaid: 0,
        actorCount: 0,
        actors: [],
      };
      byEvent.set(key, agg);
    }
    agg.actorCount++;
    // Sum every actor's fee for the batch total — not just rows that finished as
    // "paid". Test-mode payouts land as "simulated" (and any retry can be
    // "failed"), so a paid-only sum showed €$0 in the collapsed header while the
    // expanded per-actor rows listed real amounts. The header total now matches
    // the sum of the amounts shown when expanded.
    agg.totalPaid += r.amount;
    if (!agg.fixerName && r.fixerName) agg.fixerName = r.fixerName;
    agg.actors.push({
      id: r.id,
      userId: r.userId,
      userName: r.userName,
      amount: r.amount,
      paymentStatus: r.paymentStatus,
      paymentError: r.paymentError,
    });
  }
  return [...byEvent.values()];
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
  // Candidates: scheduled, not cancelled, not already processed. These must
  // wait for their run window (start + duration + autopay delay) to elapse.
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

  // Live-retry: missions already swept once (autoPayProcessedAt set) but that
  // still have players owed real money. The common case is a mission processed
  // while the system was in Test mode — its assignments are marked "simulated"
  // and, because the primary query filters on autoPayProcessedAt AND the manual
  // "Pay Players" button was removed, flipping Test→Live would otherwise never
  // pay them. payMissionPlayers re-claims simulated/failed/unpaid rows, so
  // re-running it settles the stragglers (and only moves real money when live).
  // Gated on ctx.live so Test mode doesn't churn the same missions every tick.
  let retryCandidates: typeof candidates = [];
  if (ctx.live) {
    const outstanding = await db
      .selectDistinct({ missionId: missionAssignments.missionId })
      .from(missionAssignments)
      .where(
        and(
          inArray(missionAssignments.paymentStatus, ["simulated", "failed", "unpaid"]),
          // Exclude permanently-unpayable rows (no Discord account to credit) so
          // the live-retry doesn't re-select the same mission every tick forever.
          // Transient UB-payout failures stay eligible and settle once UB recovers.
          sql`not (${missionAssignments.paymentStatus} = 'failed' and ${missionAssignments.paymentError} = 'No Discord id for player')`,
        ),
      );
    const ids = outstanding.map((r) => r.missionId);
    if (ids.length > 0) {
      retryCandidates = await db
        .select()
        .from(missions)
        .where(
          and(
            isNotNull(missions.autoPayProcessedAt),
            sql`${missions.status} <> 'cancelled'`,
            inArray(missions.id, ids),
          ),
        );
    }
  }

  let processed = 0;
  const seen = new Set<number>();
  for (const m of candidates) {
    if (!m.startAt) continue;
    const windowEnd = m.startAt.getTime() + Math.max(1, m.durationMinutes) * 60_000 + ctx.autopayDelayMs;
    if (windowEnd > now) continue; // still in the future
    seen.add(m.id);
    try {
      await payMissionPlayers(m.id, { source: "auto", actorName: "auto-pay cron" });
      processed++;
    } catch (err) {
      logger.error({ err, missionId: m.id }, "mission auto-pay failed");
    }
  }
  // Already-processed missions don't need a window check — they were swept once
  // already. Skip any handled above to avoid double work in one tick.
  for (const m of retryCandidates) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    try {
      await payMissionPlayers(m.id, { source: "auto", actorName: "auto-pay cron (live retry)" });
      processed++;
    } catch (err) {
      logger.error({ err, missionId: m.id }, "mission auto-pay live-retry failed");
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
    missions: Array<{ missionId: number | null; missionName: string | null; missionDate: string | null; amount: number }>;
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

// Legacy actor history imported from the old Discord bot (bot_actor_attendance).
// These records predate the structured missions system — they reference
// free-form events by name (e.g. "Open Chaos Lobby") that don't map to a
// portal mission id, so they surface as an aggregate "who acted" view rather
// than on any single mission's ACTORS tab. Fixer/admin only.
export async function getActorHistory() {
  const rows = await db
    .select()
    .from(botActorAttendance)
    .orderBy(desc(botActorAttendance.actedAt));

  const byUser = new Map<string, {
    userId: string;
    userName: string | null;
    actCount: number;
    totalPaid: number;
    events: Array<{ eventName: string | null; fixerName: string | null; amount: number; actedAt: string | null }>;
  }>();
  for (const r of rows) {
    let agg = byUser.get(r.userId);
    if (!agg) {
      agg = { userId: r.userId, userName: r.username, actCount: 0, totalPaid: 0, events: [] };
      byUser.set(r.userId, agg);
    }
    agg.actCount++;
    agg.totalPaid += r.payAmount;
    agg.events.push({ eventName: r.missionName, fixerName: r.fixerUsername, amount: r.payAmount, actedAt: iso(r.actedAt) });
    if (!agg.userName && r.username) agg.userName = r.username;
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
