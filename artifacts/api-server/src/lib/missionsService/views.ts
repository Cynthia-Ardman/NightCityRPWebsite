import type { Request } from "express";
import { and, or, eq, desc, inArray, isNull, notInArray, ne } from "drizzle-orm";
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
} from "@workspace/db";
import { recordAudit } from "../audit";
import { hasRole } from "../discord";
import { getMissionContext } from "../missionsConfig";
import {
  isMissionStatus,
  type MissionViewer,
} from "./statuses";
import {
  iso,
  loadAssignments,
  loadMissions,
  toSummary,
  visibleToViewerFilter,
  loadMyApplicationsForMissions,
  loadMySignupsForMissions,
  HISTORY_STATUSES,
  ownsMissionApplications,
  canManageMissionRow,
  listApplicationViews,
  pickMyApplicationView,
  missionAcceptsNpcSignup,
} from "./internal";

export async function listMissionSummaries(opts: {
  viewer: MissionViewer;
  status?: string;
  limit?: number;
}) {
  const filters = [];
  if (opts.status && isMissionStatus(opts.status)) filters.push(eq(missions.status, opts.status));
  // Visibility: regular players only ever see Posted missions. Managers
  // (fixers/admins) see the full pipeline so they can shepherd drafts.
  // Private missions are additionally hidden from players unless they are on
  // the roster (or authored the mission). Archivists are approvers: they keep
  // the players' posted-only board but bypass the private filter.
  if (!opts.viewer.isManager) {
    filters.push(eq(missions.workflowState, "posted"));
    if (!opts.viewer.isArchivist) filters.push(visibleToViewerFilter(opts.viewer.id));
  }
  const where = filters.length ? and(...filters) : undefined;
  const rows = await loadMissions(where, opts.limit ?? 200);
  const ids = rows.map((r) => r.id);
  const byMission = await loadAssignments(ids);
  // Anonymous viewers (public calendar, viewer.id === "") get no personal
  // state and no roster identities — skip the lookups and redact players
  // rather than relying on an empty id matching nothing.
  const anonymous = !opts.viewer.id;
  // Batch-load the viewer's own application + NPC sign-up per mission so the
  // Open-tab cards can render inline apply/withdraw and sign-up/remove buttons.
  const myApps = anonymous ? new Map() : await loadMyApplicationsForMissions(ids, opts.viewer.id);
  const mySignups = anonymous ? new Map() : await loadMySignupsForMissions(ids, opts.viewer.id);
  return rows.map((m) => {
    const s = toSummary(m, byMission.get(m.id) ?? [], opts.viewer.id, myApps.get(m.id) ?? null, mySignups.get(m.id) ?? null);
    if (anonymous) {
      s.players = [];
      // Internal Discord ops metadata (sync errors can embed upstream response
      // text) is not for the public calendar.
      s.discordEventId = null;
      s.discordSyncError = null;
    }
    return s;
  });
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
  if (!viewer.isManager) {
    filters.push(eq(missions.workflowState, "posted"));
    // Archivists bypass the private filter (they approve missions), matching
    // the board list and the detail gate.
    if (!viewer.isArchivist) filters.push(visibleToViewerFilter(viewer.id));
  }
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
export async function listMyApplications(userId: string, opts: { upcomingOnly?: boolean } = {}) {
  const fixerUser = alias(users, "fixer_user");
  // Upcoming = posted, not cancelled, not completed (completedAt is the real
  // completion signal — status stays 'open' on finished missions).
  const missionFilter = opts.upcomingOnly
    ? and(
        eq(missionApplications.userId, userId),
        eq(missions.workflowState, "posted"),
        ne(missions.status, "cancelled"),
        isNull(missions.completedAt),
      )
    : eq(missionApplications.userId, userId);
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
    .where(missionFilter)
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
  // Private missions are invisible to everyone except staff (managers /
  // archivists), the authoring fixer, and rostered players — a 404, not a
  // stripped-down view, so their existence never leaks.
  if (
    m.visibility === "private" &&
    !canManage &&
    !viewer.isArchivist &&
    !isOwnerFixer &&
    !assignments.some((a) => a.userId === viewer.id)
  ) {
    return null;
  }

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
    visibility: m.visibility,
    startAt: iso(m.startAt),
    npcStartAt: iso(m.npcStartAt),
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
        // Only outcomes the player can still act on: once the mission is
        // completed (completedAt is the real completion signal — status stays
        // 'open') or cancelled, the result is history and must stop
        // resurfacing in the banner (client-side dismissal is per-device
        // localStorage, so old gigs otherwise nag forever on other devices).
        isNull(missions.completedAt),
        notInArray(missions.status, ["cancelled", "completed"]),
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
