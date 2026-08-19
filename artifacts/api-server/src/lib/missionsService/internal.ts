import { and, or, eq, desc, inArray, notInArray, isNull, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import {
  db,
  missions,
  missionAssignments,
  missionActorPayments,
  missionApplications,
  missionNpcSignups,
  characters,
  users,
  type Mission,
} from "@workspace/db";
import { logger } from "../logger";
import { applyWalletDelta } from "../economy";
import {
  postToChannel,
  startThreadFromMessage,
  getChannelMeta,
  createForumThread,
  FORUM_CHANNEL_TYPE,
  sendDirectMessage,
  hasRole,
} from "../discord";
import { createNotification } from "../notifications";
import { hrefMission } from "../notificationHrefs";
import { getMissionContext } from "../missionsConfig";
import {
  MISSION_COMPLETED_STATUSES,
  RECENCY_WARNING_DAYS,
  buildMissionUrl,
  type MissionStatus,
  type MissionViewer,
} from "./statuses";

// Set-clause fragment: preserve an existing completedAt, else stamp now() when
// the new status is a completed_* one.
export function completedAtStamp(newStatus: string): { completedAt?: SQL } {
  if (!(MISSION_COMPLETED_STATUSES as readonly string[]).includes(newStatus)) return {};
  return { completedAt: sql`COALESCE(${missions.completedAt}, now())` };
}

// Board cards show the full description (no truncation) so nothing is cut
// off mid-sentence and markdown/color tags are never split in half.
export function preview(s: string | null): string | null {
  if (!s) return s;
  return s.trim();
}

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// --- Discord cover-image URL resolution ------------------------------------
// Mission images are stored as app-relative paths (e.g.
// "/api/storage/objects/<id>"). Discord needs an absolute, fetchable URL, so
// we prefix relative paths with PUBLIC_BASE_URL. Absolute http(s) URLs pass
// through untouched; anything we can't resolve becomes null (no cover image).
export function resolveAbsoluteImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base) return null;
  return `${base}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

export type AssignmentJoin = {
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

export async function loadAssignments(missionIds: number[]): Promise<Map<number, AssignmentJoin[]>> {
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

export type MissionWithFixer = Mission & {
  fixerName: string | null;
  fixerAvatarUrl: string | null;
  // Display-only: true when the owning fixer is still on trial.
  fixerIsTrial: boolean;
};

export async function loadMissions(
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

export function toSummary(
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
    visibility: m.visibility,
    startAt: iso(m.startAt),
    npcStartAt: iso(m.npcStartAt),
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
export function toMySignupView(r: {
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
export function pickMyApplicationView<T extends { status: string; createdAt: string }>(
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
export async function loadMyApplicationsForMissions(
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
      onRoster: r.assignedId != null,
      reviewedBy: r.reviewedBy,
      reviewedAt: iso(r.reviewedAt),
      createdAt: r.createdAt.toISOString(),
      attendanceCount: rec?.attendanceCount ?? 0,
      lastAttendedAt: iso(last),
      daysSinceLastMission: daysSince,
      recencyWarning: daysSince != null && daysSince < RECENCY_WARNING_DAYS,
      // Fixer-only note; irrelevant for the caller's own card.
      upcomingAcceptedMissionId: null as number | null,
      upcomingAcceptedMissionTitle: null as string | null,
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
export async function loadMySignupsForMissions(
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

/**
 * SQL condition a NON-manager viewer must satisfy to see a mission at all:
 * the mission is public, OR they authored it, OR a fixer put them on the
 * roster (mission_assignments row — any payment state). Managers/archivists
 * bypass this entirely (the callers skip the filter for them), matching the
 * existing "staff see the full pipeline" rule.
 */
export function visibleToViewerFilter(viewerId: string) {
  const assignedSubquery = db
    .select({ missionId: missionAssignments.missionId })
    .from(missionAssignments)
    .where(eq(missionAssignments.userId, viewerId));
  return or(
    eq(missions.visibility, "public"),
    eq(missions.fixerId, viewerId),
    inArray(missions.id, assignedSubquery),
  )!;
}

// Terminal runtime statuses that put a mission in the history view.
export const HISTORY_STATUSES: MissionStatus[] = [
  "completed",
  "completed_players_paid",
  "completed_paid",
  "cancelled",
];

/**
 * Application data (the applicant pool, accept/reject) is private to the
 * mission's own fixer and to admins. Other fixers must not see or act on
 * another fixer's applications. `fixerId` may be null (unclaimed mission) — in
 * that case only an admin qualifies.
 */
export function ownsMissionApplications(viewer: MissionViewer, fixerId: string | null): boolean {
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
export function canManageMissionRow(
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
 * Per-character recency: most recent credited attendance (excluding the given
 * mission) and total credited-attendance count. Used for the non-blocking
 * "played recently" warning shown to fixers during application review.
 */
export async function loadRecencyByCharacter(
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
 * Per-user "already booked" lookup: for each user, the soonest OTHER mission
 * (still open/pending, i.e. not yet run) where they are accepted — either via
 * an accepted application row or an actual roster assignment. Powers the
 * non-blocking "Accepted to an upcoming mission" note fixers see during
 * application review (mirrors the recency warning).
 */
export async function loadUpcomingAcceptanceByUser(
  userIds: string[],
  excludeMissionId: number,
): Promise<Map<string, { missionId: number; missionTitle: string; missionStartAt: Date | null }>> {
  const out = new Map<string, { missionId: number; missionTitle: string; missionStartAt: Date | null }>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  // "Upcoming" mirrors the mission-detail definition: posted, not cancelled,
  // and NOT completed. Completion is tracked via completedAt (status stays
  // 'open'), so a status-only filter would keep flagging finished missions.
  const upcomingMission = and(
    eq(missions.workflowState, "posted"),
    ne(missions.status, "cancelled"),
    isNull(missions.completedAt),
    // Belt-and-braces: some legacy rows reached a completed_* status without
    // a completedAt stamp (payout paths didn't set it before completedAtStamp).
    notInArray(missions.status, [...MISSION_COMPLETED_STATUSES]),
  );

  // Roster assignments on upcoming missions.
  const assigned = await db
    .select({
      userId: missionAssignments.userId,
      missionId: missions.id,
      missionTitle: missions.title,
      missionStartAt: missions.startAt,
    })
    .from(missionAssignments)
    .innerJoin(missions, eq(missions.id, missionAssignments.missionId))
    .where(
      and(
        inArray(missionAssignments.userId, ids),
        ne(missionAssignments.missionId, excludeMissionId),
        upcomingMission,
      ),
    );
  // Accepted applications on upcoming missions (covers accept-before-roster
  // edge cases; usually redundant with the assignment row).
  const accepted = await db
    .select({
      userId: missionApplications.userId,
      missionId: missions.id,
      missionTitle: missions.title,
      missionStartAt: missions.startAt,
    })
    .from(missionApplications)
    .innerJoin(missions, eq(missions.id, missionApplications.missionId))
    .where(
      and(
        inArray(missionApplications.userId, ids),
        ne(missionApplications.missionId, excludeMissionId),
        eq(missionApplications.status, "accepted"),
        upcomingMission,
      ),
    );
  // Keep the soonest-starting mission per user (null start sorts last).
  for (const r of [...assigned, ...accepted]) {
    const cur = out.get(r.userId);
    const rTime = r.missionStartAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const curTime = cur ? (cur.missionStartAt?.getTime() ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
    if (!cur || rTime < curTime) {
      out.set(r.userId, { missionId: r.missionId, missionTitle: r.missionTitle, missionStartAt: r.missionStartAt });
    }
  }
  return out;
}

/**
 * Build application view rows for a mission. When `onlyUserId` is given, returns
 * just that player's application (for the player's own view).
 */
export async function listApplicationViews(missionId: number, onlyUserId?: string) {
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

  const [recency, upcoming] = await Promise.all([
    loadRecencyByCharacter(
      rows.map((r) => r.characterId),
      missionId,
    ),
    // Fixer-only enrichment: skip when building the caller's own card
    // (onlyUserId) — the note is for reviewers, not the applicant.
    onlyUserId
      ? Promise.resolve(new Map<string, { missionId: number; missionTitle: string; missionStartAt: Date | null }>())
      : loadUpcomingAcceptanceByUser(
          rows.map((r) => r.userId),
          missionId,
        ),
  ]);
  const now = Date.now();
  return rows.map((r) => {
    const rec = recency.get(r.characterId);
    const last = rec?.lastAttendedAt ?? null;
    const daysSince = last ? Math.floor((now - last.getTime()) / 86_400_000) : null;
    const up = upcoming.get(r.userId) ?? null;
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
      // Roster membership surfaced directly so the fixer UI can detect the
      // inverse desync (status 'accepted' but no roster row — e.g. the row was
      // clobbered by a stale roster edit) and offer to restore it.
      onRoster: r.assignedId != null,
      reviewedBy: r.reviewedBy,
      reviewedAt: iso(r.reviewedAt),
      createdAt: r.createdAt.toISOString(),
      attendanceCount: rec?.attendanceCount ?? 0,
      lastAttendedAt: iso(last),
      daysSinceLastMission: daysSince,
      recencyWarning: daysSince != null && daysSince < RECENCY_WARNING_DAYS,
      // "Already booked" note: the applicant is accepted on another mission
      // that hasn't run yet (open/pending). Non-blocking, like recencyWarning.
      upcomingAcceptedMissionId: up?.missionId ?? null,
      upcomingAcceptedMissionTitle: up?.missionTitle ?? null,
    };
  });
}

/** Dedupe + sort UTC ISO availability instants; drop invalid entries. */
export function normalizeAvailability(input: string[] | null | undefined): string[] {
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
export function normalizeDefaultPattern(
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

// A mission accepts NPC sign-ups only while it is publicly posted and has not
// been completed or cancelled. Completion is BOTH the manual `completedAt` lock
// and any of the completed_* lifecycle statuses.
const NPC_SIGNUP_BLOCKED_STATUSES = [
  "completed",
  "completed_players_paid",
  "completed_paid",
  "cancelled",
] as const;
export function missionAcceptsNpcSignup(m: {
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

/**
 * Website-first ACTOR/NPC payout: credits the website wallet (source of
 * truth) with a mission-source ledger row and enqueues the UB mirror push.
 * Bypasses the economy kill-switch (gate: "none") — these paths are gated on
 * MISSION live mode by their callers. Idempotent on the
 * mission_actor_payments row id so re-runs and a backfill share one key.
 * Zero-amount payouts are a settled no-op.
 */
export async function creditActorPayout(opts: {
  userId: string;
  discordId: string;
  amount: number;
  reason: string;
  memo: string;
  paymentRowId: number;
  relatedEntityType: string;
  relatedEntityId: number | null;
}): Promise<{ ok: boolean; error?: string }> {
  if (opts.amount <= 0) return { ok: true };
  const r = await applyWalletDelta({
    userId: opts.userId,
    discordId: opts.discordId,
    amount: opts.amount,
    source: "mission",
    kind: "mission",
    reason: opts.reason,
    memo: opts.memo,
    characterId: null,
    relatedEntityType: opts.relatedEntityType,
    relatedEntityId: opts.relatedEntityId,
    idempotencyKey: `actor_payout:${opts.paymentRowId}`,
    gate: "none",
  });
  if (!r.ok) return { ok: false, error: r.error ?? r.status };
  return { ok: true };
}

// Re-evaluate completed_players_paid → completed_paid after an NPC sign-up was
// actioned. Only advances when players are already fully paid and no sign-up is
// still outstanding.
export async function applySecondPhaseStatus(missionId: number): Promise<void> {
  const [m] = await db.select({ status: missions.status }).from(missions).where(eq(missions.id, missionId));
  if (!m) return;
  const npc = await getNpcSettlement(missionId);
  const newStatus = statusAfterSecondPhase(m.status, npc.outstanding);
  if (newStatus !== m.status) {
    await db
      .update(missions)
      .set({ status: newStatus, ...completedAtStamp(newStatus) })
      .where(eq(missions.id, missionId));
  }
}

/**
 * Notify an applicant via Discord DM that their mission application was accepted
 * or rejected. Fail-safe: respects the missions Test/Live gate (Test mode only
 * logs) and never throws — a delivery miss (DMs disabled, no bot token, Discord
 * error) must not block the fixer's accept/reject action. Mirrors the
 * fail-safe, live-gated pattern used by the NPC announcement cron.
 */
export async function notifyApplicantOfReview(opts: {
  userId: string;
  characterId: number;
  missionId: number;
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
    // In-portal bell notification is additive and NOT gated on missions
    // Test/Live — the decision itself is real either way; only the Discord DM
    // respects the external-write gate below.
    void createNotification({
      userId: opts.userId,
      type: "mission_application",
      title:
        opts.action === "accept"
          ? `Accepted for mission "${opts.missionTitle}"`
          : `Application declined — "${opts.missionTitle}"`,
      body: content,
      href: hrefMission(opts.missionId),
    });
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

// Role pinged when a new mission's brief is posted to the fixer job-proposal
// channel. The discussion thread is a fixer-only planning space, so we ping the
// Fixer role (not @Choom — the public sign-up announcement is separate). Pinging
// requires the role id in both the content (`<@&id>`) and allowed_mentions.roles.
export const FIXER_ROLE_ID = "1348633945545379911";

const TIER_NAMES: Record<number, string> = {
  1: "Street Work",
  2: "Contract Work",
  3: "High Risk Operation",
  4: "Extreme",
};

// Build the full mission brief (content + embed) posted to the #missions
// discussion channel, off which the per-mission thread is started.
export function buildMissionBrief(m: Mission): { content: string; embeds: unknown[] } {
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
    ...(m.npcStartAt
      ? [{ name: "NPC Gather", value: `<t:${Math.floor(m.npcStartAt.getTime() / 1000)}:F>`, inline: true }]
      : []),
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
 * Pick the forum tag for a mission's thread. The #fixer-job-proposals forum has
 * "require tag" on, so a thread create with no tag is rejected — we always
 * return a tag id when the forum has any tags. A posted (live) mission maps to
 * the "Approved" tag; anything earlier (draft/proposal) maps to "WIP". Falls
 * back to the first available tag so a renamed/missing tag never blocks creation.
 */
export function pickMissionForumTagId(tags: { id: string; name: string }[], m: Mission): string | undefined {
  if (tags.length === 0) return undefined;
  const byName = (n: string) => tags.find((t) => t.name.toLowerCase() === n.toLowerCase())?.id;
  const wanted = m.workflowState === "posted" ? byName("Approved") : byName("WIP");
  return wanted ?? tags[0].id;
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
  // Private missions never get a public forum thread/brief. (Existing linked
  // threads are left alone below — no-op — but nothing new is ever created.)
  if (m.visibility === "private") return { created: false, threadId: m.discordThreadId ?? null };
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
export async function buildMissionThreadSnapshot(missionId: number): Promise<string> {
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

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function jobTypeLabel(jt: string): string {
  if (jt === "combat") return "Combat";
  if (jt === "non_combat") return "Non-Combat";
  if (jt === "mixed") return "Mixed";
  return jt;
}

export function eventTitle(title: string): string {
  return `Actors Needed: ${title}`;
}

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

export async function getNpcSettlement(missionId: number): Promise<NpcSettlement> {
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
export function statusAfterPlayersPaid(
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
export function statusAfterSecondPhase(status: string, npcOutstanding: boolean): string {
  if (status === "completed_players_paid" && !npcOutstanding) return "completed_paid";
  return status;
}
