import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, inArray, or, ilike, asc, isNotNull } from "drizzle-orm";
import {
  db,
  missions,
  missionAssignments,
  characters,
  users,
  botConfig,
  customRequests,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole, sendDirectMessage, searchGuildMembers, postToChannel, startThreadFromMessage } from "../lib/discord";
import { getMissionContext, MISSION_CONFIG_KEYS } from "../lib/missionsConfig";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import {
  listMissionSummaries,
  listMyMissionSummaries,
  listOwnedMissionSummaries,
  listCreatedMissionSummaries,
  listMissionHistory,
  listMyApplications,
  listMyActing,
  listActingForUser,
  signUpAsNpc,
  withdrawNpcSignup,
  confirmNpcSignup,
  getMissionDetail,
  payMissionActors,
  setMissionCompleted,
  payStandaloneActors,
  getStandaloneActorPayouts,
  syncMissionDiscordEvent,
  getActorReport,
  getActorHistory,
  getAttendanceReport,
  isMissionStatus,
  isJobType,
  submitMissionProposal,
  deleteMission,
  approveMission,
  postMission,
  applyToMission,
  getDefaultAvailability,
  withdrawApplication,
  reviewApplication,
  removeAssignedPlayer,
  listApplicantOutcomes,
  checkDiscordEventConflict,
  buildMissionUrl,
  getMissionManageAuth,
  viewerHasManageableMission,
  type MissionViewer,
} from "../lib/missionsService";
import type { Mission } from "@workspace/db";
import { convertEventToMission } from "../lib/eventsService";

const router: IRouter = Router();

function viewerOf(req: Request): MissionViewer {
  const u = req.user!;
  const isAdmin = hasRole(u.roles, "ADMIN");
  const isManagerRole = isAdmin || hasRole(u.roles, "FIXER");
  return {
    id: u.id,
    isManager: isManagerRole,
    isAdmin,
    isArchivist: isAdmin || hasRole(u.roles, "ARCHIVIST"),
    // A trial fixer is an author-only tier; full managers are never also "trial
    // authors" (the manager grant supersedes it).
    isTrialAuthor: !isManagerRole && hasRole(u.roles, "TRIAL_FIXER"),
  };
}

function canApprove(req: Request): boolean {
  const roles = req.user?.roles ?? [];
  return hasRole(roles, "ADMIN") || hasRole(roles, "ARCHIVIST");
}

const TIER_NAMES: Record<number, string> = {
  1: "Street Work",
  2: "Contract Work",
  3: "High Risk Operation",
  4: "Extreme",
};

function jobTypeName(jt: string | null): string {
  if (jt === "combat") return "Combat";
  if (jt === "non_combat") return "Non-Combat";
  if (jt === "mixed") return "Mixed";
  return jt ?? "—";
}

// Post the full mission brief to the #missions discussion channel and start a
// per-mission thread off it, then persist the linkage on the row. Mirrors the
// edit/request/sheet thread pattern: deployment-gated (postToChannel /
// startThreadFromMessage no-op outside deployments), the message id is always
// persisted on a successful post so a later backfill can recover, and
// discordThreadId is set ONLY when the thread helper returns non-null (never
// `threadId ?? msgId`). Fail-safe — a Discord miss never blocks mission
// creation.
// Role pinged when a new mission is announced to #fix-your-job-announcements so
// players are notified the job is open. Pinging requires the role id in both the
// message content (`<@&id>`) and allowed_mentions.roles.
const CHOOM_ROLE_ID = "1348642753554288640";

async function announceMissionThread(m: Mission, channelId: string): Promise<void> {
  if (!channelId) return;
  try {
    const startUnix = m.startAt ? Math.floor(m.startAt.getTime() / 1000) : null;
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: "Tier", value: `${m.tier} — ${TIER_NAMES[m.tier] ?? "Unknown"}`, inline: true },
      { name: "Job Type", value: jobTypeName(m.jobType), inline: true },
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

    const msgId = await postToChannel(
      channelId,
      `<@&${CHOOM_ROLE_ID}> **New mission created — ${m.title}**`,
      [
        {
          title: m.title,
          description: m.description ? m.description.slice(0, 4096) : undefined,
          fields,
          ...(m.imageUrl ? { image: { url: m.imageUrl } } : {}),
        },
      ],
      { roles: [CHOOM_ROLE_ID] },
    );
    if (msgId) {
      const threadId = await startThreadFromMessage(channelId, msgId, m.title);
      await db
        .update(missions)
        .set({ discordMessageId: msgId, ...(threadId ? { discordThreadId: threadId } : {}) })
        .where(eq(missions.id, m.id));
    }
  } catch (err) {
    logger.warn({ err, missionId: m.id }, "announceMissionThread failed");
  }
}

function isManager(req: Request): boolean {
  const roles = req.user?.roles ?? [];
  return hasRole(roles, "ADMIN") || hasRole(roles, "FIXER");
}

// Trial fixer (narrow author tier) — true only when they are NOT a full
// manager, so manager checks and author checks stay cleanly separated.
function isTrialAuthor(req: Request): boolean {
  const roles = req.user?.roles ?? [];
  return !isManager(req) && hasRole(roles, "TRIAL_FIXER");
}

// May author missions: full managers OR trial fixers. Authoring covers
// create / edit-own / submit-own and the create-form helpers (config,
// conflicts) plus the "My Created Missions" board. Everything else (payments,
// posting, completion, the All Missions board, other fixers' missions) stays
// manager-gated.
function canAuthorMissions(req: Request): boolean {
  return isManager(req) || isTrialAuthor(req);
}

// Per-mission management gate (roster / post / pay). Full managers may manage
// any mission; a trial fixer may manage a mission they own once it's approved.
// Loads the mission to decide, so it also serves as the existence (404) check.
// Returns true only when the caller may proceed; otherwise it has already sent
// the 404/403 response.
async function ensureCanManageMission(
  req: Request,
  res: Response,
  id: number,
): Promise<boolean> {
  const auth = await getMissionManageAuth(id, viewerOf(req));
  if (!auth.found) {
    res.status(404).json({ error: "Mission not found" });
    return false;
  }
  if (!auth.canManage) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return false;
  }
  return true;
}

function parseTier(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

function parseDate(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Resolve an assignment list to {userId, characterId} pairs, nulling any
// character that isn't actually owned by the named player (the UI filters the
// dropdown, but never trust the client).
async function normalizeAssignments(
  raw: unknown,
): Promise<Array<{ userId: string; characterId: number | null }> | null> {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return [];
  // First pass: collect the explicit userId (if any) and characterId for each
  // entry. An entry may carry a userId, a characterId, or both.
  type Pending = { userId: string | null; characterId: number | null };
  const pending: Pending[] = [];
  const charIds = new Set<number>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const userIdRaw = (item as { userId?: unknown }).userId;
    const userId = typeof userIdRaw === "string" && userIdRaw ? userIdRaw : null;
    const cidRaw = (item as { characterId?: unknown }).characterId;
    const cid = cidRaw == null ? null : Number(cidRaw);
    const characterId = cid != null && Number.isInteger(cid) ? cid : null;
    if (userId == null && characterId == null) continue;
    if (characterId != null) charIds.add(characterId);
    pending.push({ userId, characterId });
  }

  // Resolve character owners once so we can both (a) derive userId for entries
  // that only supplied a characterId, and (b) null out characterIds whose
  // owner doesn't match an explicitly-supplied userId.
  const ownerById = new Map<number, string | null>();
  if (charIds.size > 0) {
    const owned = await db
      .select({ id: characters.id, ownerId: characters.ownerId })
      .from(characters)
      .where(inArray(characters.id, [...charIds]));
    for (const c of owned) ownerById.set(c.id, c.ownerId);
  }

  // Second pass: produce final assignments keyed by userId. Dedupe so the same
  // player can't be inserted twice (the last character wins).
  const byUser = new Map<string, number | null>();
  for (const p of pending) {
    let userId = p.userId;
    let characterId = p.characterId;
    if (userId == null && characterId != null) {
      // Derive the owning player from the character.
      userId = ownerById.get(characterId) ?? null;
    } else if (userId != null && characterId != null && ownerById.get(characterId) !== userId) {
      // Explicit userId/character mismatch: keep the player, drop the character.
      characterId = null;
    }
    if (userId == null) continue; // unclaimed character with no explicit player
    byUser.set(userId, characterId ?? byUser.get(userId) ?? null);
  }
  return [...byUser.entries()].map(([userId, characterId]) => ({ userId, characterId }));
}

// Replace the full assignment set for a mission. Unpaid assignments no longer
// in the set are deleted; paid/simulated ones are preserved (so we never erase
// a payout record). Incoming assignments are inserted or have their character
// updated without disturbing payment state.
async function applyAssignments(
  missionId: number,
  desired: Array<{ userId: string; characterId: number | null }>,
): Promise<Array<{ userId: string; characterId: number | null }>> {
  const existing = await db
    .select()
    .from(missionAssignments)
    .where(eq(missionAssignments.missionId, missionId));
  const existingByUser = new Map(existing.map((a) => [a.userId, a]));
  const desiredUserIds = new Set(desired.map((d) => d.userId));

  // Delete unpaid assignments dropped from the set.
  const toDelete = existing.filter((a) => !desiredUserIds.has(a.userId) && a.paymentStatus === "unpaid");
  if (toDelete.length > 0) {
    await db.delete(missionAssignments).where(inArray(missionAssignments.id, toDelete.map((a) => a.id)));
  }

  // Track assignments that gained a character this call (new row, or an
  // existing row whose character changed) so the caller can ask the affected
  // player to approve their participation.
  const newlyAssigned: Array<{ userId: string; characterId: number | null }> = [];
  for (const d of desired) {
    const cur = existingByUser.get(d.userId);
    if (cur) {
      if (cur.characterId !== d.characterId) {
        await db.update(missionAssignments).set({ characterId: d.characterId }).where(eq(missionAssignments.id, cur.id));
        if (d.characterId != null) newlyAssigned.push(d);
      }
    } else {
      await db.insert(missionAssignments).values({ missionId, userId: d.userId, characterId: d.characterId });
      if (d.characterId != null) newlyAssigned.push(d);
    }
  }
  return newlyAssigned;
}

// When a fixer assigns one of a player's characters to a mission, raise a
// pending `mission_participation` request the owning player must approve from
// "My Requests" (mirrors the employee-invite owner-decision flow). Skips the
// fixer's own characters and any character that already has a pending
// participation request for this mission. Best-effort + DM the player.
async function createParticipationRequests(
  mission: { id: number; title: string },
  newlyAssigned: Array<{ userId: string; characterId: number | null }>,
  actorId: string,
  actorName: string,
): Promise<void> {
  const targets = newlyAssigned.filter(
    (a): a is { userId: string; characterId: number } => a.characterId != null && a.userId !== actorId,
  );
  if (targets.length === 0) return;
  const charIds = [...new Set(targets.map((t) => t.characterId))];
  const chars = await db
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(inArray(characters.id, charIds));
  const nameById = new Map(chars.map((c) => [c.id, c.name]));

  // Dedup against existing pending participation requests for this mission.
  const pending = await db
    .select({ characterId: customRequests.characterId, details: customRequests.details })
    .from(customRequests)
    .where(
      and(
        eq(customRequests.type, "mission_participation"),
        eq(customRequests.status, "pending"),
        inArray(customRequests.characterId, charIds),
      ),
    );
  const alreadyPending = new Set(
    pending
      .filter((p) => Number((p.details as { missionId?: number } | null)?.missionId) === mission.id)
      .map((p) => p.characterId),
  );

  for (const t of targets) {
    if (alreadyPending.has(t.characterId)) continue;
    const charName = nameById.get(t.characterId) ?? "Your character";
    const [inserted] = await db
      .insert(customRequests)
      .values({
        type: "mission_participation",
        characterId: t.characterId,
        requestedById: t.userId,
        title: mission.title,
        description: null,
        details: {
          missionId: mission.id,
          missionTitle: mission.title,
          characterId: t.characterId,
          characterName: charName,
          invitedById: actorId,
          invitedByName: actorName,
        } as never,
      })
      .returning({ id: customRequests.id });
    try {
      const [owner] = await db
        .select({ discordId: users.discordId })
        .from(users)
        .where(eq(users.id, t.userId));
      if (owner?.discordId) {
        await sendDirectMessage(
          owner.discordId,
          `${actorName} assigned ${charName} to the mission "${mission.title}". Approve or decline participation in My Requests.`,
        );
      }
    } catch (err) {
      logger.warn({ err, requestId: inserted?.id }, "participation-request DM failed");
    }
  }
}

// ---------------- LIST / CREATE ----------------
router.get("/missions", requireAuth, async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = Math.min(1000, parseInt(String(req.query.limit ?? "200"), 10) || 200);
  const rows = await listMissionSummaries({ viewer: viewerOf(req), status, limit });
  res.json(rows);
});

router.post("/missions", requireAuth, async (req, res): Promise<void> => {
  if (!canAuthorMissions(req)) {
    res.status(403).json({ error: "Fixer, trial fixer, or admin role required" });
    return;
  }
  const b = req.body ?? {};
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const tier = parseTier(b.tier);
  if (!title) {
    res.status(400).json({ error: "Title is required" });
    return;
  }
  if (tier == null) {
    res.status(400).json({ error: "Tier (1-4) is required" });
    return;
  }
  const startAt = parseDate(b.startAt);
  if (startAt === undefined && b.startAt !== undefined) {
    res.status(400).json({ error: "Invalid start date" });
    return;
  }
  const status = isMissionStatus(b.status) ? b.status : "open";
  // Job type is required by the spec but only enforced at submit/post time;
  // accept it on create when provided and valid.
  if (b.jobType !== undefined && b.jobType !== null && b.jobType !== "" && !isJobType(b.jobType)) {
    res.status(400).json({ error: "Job type must be combat, non_combat, or mixed" });
    return;
  }
  const ctx = await getMissionContext();

  const [created] = await db
    .insert(missions)
    .values({
      title,
      tier,
      playerPay: Number.isFinite(Number(b.playerPay)) ? Math.max(0, Math.trunc(Number(b.playerPay))) : 0,
      npcPayAmount: Number.isFinite(Number(b.npcPayAmount)) ? Math.max(0, Math.trunc(Number(b.npcPayAmount))) : 0,
      location: typeof b.location === "string" ? b.location : null,
      description: typeof b.description === "string" ? b.description : null,
      imageUrl: typeof b.imageUrl === "string" && b.imageUrl ? b.imageUrl : null,
      startAt: startAt ?? null,
      durationMinutes: Number.isFinite(Number(b.durationMinutes)) ? Math.max(1, Math.trunc(Number(b.durationMinutes))) : 120,
      slots: Number.isFinite(Number(b.slots)) ? Math.max(0, Math.trunc(Number(b.slots))) : 0,
      status,
      // --- Task #62 fields ---
      worldLink: typeof b.worldLink === "string" && b.worldLink.trim() ? b.worldLink.trim() : null,
      jobType: isJobType(b.jobType) ? b.jobType : null,
      requestedSkills: typeof b.requestedSkills === "string" && b.requestedSkills.trim() ? b.requestedSkills.trim() : null,
      client: typeof b.client === "string" && b.client.trim() ? b.client.trim() : null,
      notesForPlayers: typeof b.notesForPlayers === "string" && b.notesForPlayers.trim() ? b.notesForPlayers.trim() : null,
      maxPlayers: Number.isFinite(Number(b.maxPlayers)) ? Math.max(0, Math.trunc(Number(b.maxPlayers))) : 0,
      fixerId: req.user!.id,
    })
    .returning();

  const assignments = await normalizeAssignments(b.assignments);
  if (assignments) {
    const newlyAssigned = await applyAssignments(created.id, assignments);
    await createParticipationRequests(created, newlyAssigned, req.user!.id, req.user!.username);
  }

  // Discord sync (Test/Live gated). Persist event id / error without blocking.
  const sync = await syncMissionDiscordEvent(created, ctx, created.imageUrl);
  if (sync.discordEventId !== created.discordEventId || sync.discordSyncError !== created.discordSyncError) {
    await db.update(missions).set(sync).where(eq(missions.id, created.id));
  }

  // Post the mission brief to the #missions channel + start a discussion thread
  // staff can follow. Deployment-gated inside the helper; never blocks creation.
  await announceMissionThread(created, ctx.threadChannelId);

  await recordAudit({
    req,
    category: "mission",
    action: "mission.create",
    targetType: "mission",
    targetId: created.id,
    message: `Created mission "${title}" (tier ${tier}, ${ctx.live ? "LIVE" : "TEST"})`,
    after: { id: created.id, title, tier, status },
  });

  const detail = await getMissionDetail(created.id, viewerOf(req));
  res.status(201).json(detail);
});

// Convert an existing EVENT into a mission (REPLACE). Soft-cancels the event and
// creates a posted/open mission carrying its shared fields + the mission-only
// fields supplied here. The Discord scheduled event is handed off (no teardown).
router.post("/events/:id/convert-to-mission", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const eventId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(eventId)) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }
  const b = req.body ?? {};
  const tier = parseTier(b.tier);
  if (tier == null) {
    res.status(400).json({ error: "Tier (1-4) is required" });
    return;
  }
  if (b.jobType !== undefined && b.jobType !== null && b.jobType !== "" && !isJobType(b.jobType)) {
    res.status(400).json({ error: "Job type must be combat, non_combat, or mixed" });
    return;
  }
  const dur = Number(b.durationMinutes);
  const result = await convertEventToMission(eventId, req.user!.id, {
    tier,
    playerPay: Number.isFinite(Number(b.playerPay)) ? Math.max(0, Math.trunc(Number(b.playerPay))) : 0,
    npcPayAmount: Number.isFinite(Number(b.npcPayAmount)) ? Math.max(0, Math.trunc(Number(b.npcPayAmount))) : 0,
    slots: Number.isFinite(Number(b.slots)) ? Math.max(0, Math.trunc(Number(b.slots))) : 0,
    maxPlayers: Number.isFinite(Number(b.maxPlayers)) ? Math.max(0, Math.trunc(Number(b.maxPlayers))) : 0,
    jobType: isJobType(b.jobType) ? b.jobType : null,
    worldLink: typeof b.worldLink === "string" && b.worldLink.trim() ? b.worldLink.trim() : null,
    requestedSkills: typeof b.requestedSkills === "string" && b.requestedSkills.trim() ? b.requestedSkills.trim() : null,
    client: typeof b.client === "string" && b.client.trim() ? b.client.trim() : null,
    notesForPlayers: typeof b.notesForPlayers === "string" && b.notesForPlayers.trim() ? b.notesForPlayers.trim() : null,
    durationMinutes: Number.isFinite(dur) && dur > 0 ? Math.trunc(dur) : null,
  });
  if (!result.ok) {
    res.status(result.httpStatus ?? 400).json({ error: result.error ?? "Conversion failed" });
    return;
  }
  // Re-sync the handed-off Discord scheduled event to mission format. The
  // conversion only moves the event id onto the mission; without this the
  // Discord event keeps its old event-formatted title/description until the
  // next edit or reconcile pass. The conversion has already committed, so a
  // resync failure must not 500 the request — log and self-heal on the next
  // reconcile pass (mirrors the mission->event side in eventsService).
  try {
    const [newMission] = await db.select().from(missions).where(eq(missions.id, result.newId!));
    if (newMission) {
      const ctx = await getMissionContext();
      const sync = await syncMissionDiscordEvent(newMission, ctx, newMission.imageUrl);
      if (sync.discordEventId !== newMission.discordEventId || sync.discordSyncError !== newMission.discordSyncError) {
        await db.update(missions).set(sync).where(eq(missions.id, newMission.id));
      }
    }
  } catch (err) {
    logger.warn({ err, missionId: result.newId }, "convert-to-mission: Discord resync failed; reconcile cron will heal");
  }
  await recordAudit({
    req,
    category: "mission",
    action: "event.convert_to_mission",
    targetType: "mission",
    targetId: result.newId!,
    message: `Converted event #${eventId} into mission #${result.newId} (tier ${tier})`,
    after: { eventId, missionId: result.newId, tier },
  });
  const detail = await getMissionDetail(result.newId!, viewerOf(req));
  res.status(201).json(detail);
});

// ---------------- SPECIFIC ROUTES (must precede /missions/:id) ----------------
router.get("/missions/mine", requireAuth, async (req, res): Promise<void> => {
  res.json(await listMyMissionSummaries(viewerOf(req)));
});

// Reviewed (accepted/rejected) outcomes of the caller's own applications, for
// the in-portal outcome banner. Closes the loop even if the Discord DM never
// landed. Any authenticated player can read their own outcomes.
router.get("/missions/my-application-outcomes", requireAuth, async (req, res): Promise<void> => {
  res.json(await listApplicantOutcomes(req.user!.id));
});

// "My Missions" board for fixers/admins — their own missions across all
// workflow states (admins see every mission).
router.get("/missions/owned", requireAuth, async (req, res): Promise<void> => {
  // Fixers/admins manage their board; archivists (approvers) need it to find
  // proposals awaiting review.
  if (!isManager(req) && !canApprove(req)) {
    res.status(403).json({ error: "Fixer, archivist, or admin role required" });
    return;
  }
  res.json(await listOwnedMissionSummaries(viewerOf(req)));
});

// "My Created Missions" — missions the caller personally runs (fixerId ===
// caller), across all workflow states. Creators/approvers only.
router.get("/missions/created", requireAuth, async (req, res): Promise<void> => {
  // Scoped to the caller's own missions (fixerId === caller), so trial fixers
  // get their own board without seeing anyone else's pipeline.
  if (!canAuthorMissions(req) && !canApprove(req)) {
    res.status(403).json({ error: "Fixer, trial fixer, archivist, or admin role required" });
    return;
  }
  res.json(await listCreatedMissionSummaries(viewerOf(req)));
});

// "Mission History" — completed/cancelled missions relevant to the caller.
// Any authenticated user; the service scopes rows to ones they attended (and,
// for managers, ones they ran).
router.get("/missions/history", requireAuth, async (req, res): Promise<void> => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  res.json(await listMissionHistory(viewerOf(req), { limit, offset }));
});

// "My Applications" — every application the caller has submitted, all states.
// Any authenticated player reads only their own rows.
router.get("/missions/my-applications", requireAuth, async (req, res): Promise<void> => {
  res.json(await listMyApplications(req.user!.id));
});

// "Acting" — every time the caller acted (NPC/actor) in a mission or event,
// unioning modern actor payouts with legacy bot acting records. Own rows only.
router.get("/missions/acting", requireAuth, async (req, res): Promise<void> => {
  res.json(await listMyActing(viewerOf(req)));
});

// Fixer/admin per-player acting lookup — the acting history for a specific
// player (Task #185), so a fixer can see how often someone has NPC'd.
router.get("/missions/acting/:userId", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const userId = String(req.params.userId);
  if (!userId) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(await listActingForUser(userId));
});

// Fail-safe Discord scheduling-conflict check for the create/reschedule form.
router.get("/missions/conflicts", requireAuth, async (req, res): Promise<void> => {
  if (!canAuthorMissions(req)) {
    res.status(403).json({ error: "Fixer, trial fixer, or admin role required" });
    return;
  }
  const startAt = parseDate(req.query.startAt);
  if (!startAt) {
    res.status(400).json({ error: "Valid startAt is required" });
    return;
  }
  const durationMinutes = Math.max(1, Math.trunc(Number(req.query.durationMinutes) || 120));
  const excludeEventId = typeof req.query.excludeEventId === "string" ? req.query.excludeEventId : null;
  res.json(await checkDiscordEventConflict({ startAt, durationMinutes, excludeEventId }));
});

router.get("/missions/config", requireAuth, async (req, res): Promise<void> => {
  if (!canAuthorMissions(req)) {
    res.status(403).json({ error: "Fixer, trial fixer, or admin role required" });
    return;
  }
  const ctx = await getMissionContext();
  res.json({
    live: ctx.live,
    bankingChannelId: ctx.bankingChannelId,
    npcSpendingChannelId: ctx.npcSpendingChannelId,
    npcAnnouncementChannelId: ctx.npcAnnouncementChannelId,
    threadChannelId: ctx.threadChannelId,
    defaultImageUrl: ctx.defaultImageUrl || null,
    autopayDelayHours: Math.round((ctx.autopayDelayMs / 3_600_000) * 100) / 100,
  });
});

router.put("/missions/config", requireAuth, async (req, res): Promise<void> => {
  if (!hasRole(req.user!.roles, "ADMIN")) {
    res.status(403).json({ error: "Admin role required" });
    return;
  }
  const b = req.body ?? {};
  const updates: Array<{ key: string; value: unknown }> = [];
  if (typeof b.live === "boolean") updates.push({ key: MISSION_CONFIG_KEYS.liveMode, value: b.live });
  if (typeof b.bankingChannelId === "string") updates.push({ key: MISSION_CONFIG_KEYS.bankingChannel, value: b.bankingChannelId.trim() });
  if (typeof b.npcSpendingChannelId === "string") updates.push({ key: MISSION_CONFIG_KEYS.npcSpendingChannel, value: b.npcSpendingChannelId.trim() });
  if (typeof b.npcAnnouncementChannelId === "string") updates.push({ key: MISSION_CONFIG_KEYS.npcAnnouncementChannel, value: b.npcAnnouncementChannelId.trim() });
  if (typeof b.threadChannelId === "string") updates.push({ key: MISSION_CONFIG_KEYS.threadChannel, value: b.threadChannelId.trim() });
  if (typeof b.defaultImageUrl === "string") updates.push({ key: MISSION_CONFIG_KEYS.defaultImage, value: b.defaultImageUrl.trim() });
  if (Number.isFinite(Number(b.autopayDelayHours)) && Number(b.autopayDelayHours) > 0) {
    updates.push({ key: MISSION_CONFIG_KEYS.autopayDelayHours, value: Number(b.autopayDelayHours) });
  }
  for (const u of updates) {
    await db
      .insert(botConfig)
      .values({ key: u.key, value: u.value as never })
      .onConflictDoUpdate({ target: botConfig.key, set: { value: u.value as never, updatedAt: new Date() } });
  }
  if (typeof b.live === "boolean") {
    await recordAudit({
      req,
      category: "mission",
      action: "mission.mode_change",
      targetType: "config",
      targetId: MISSION_CONFIG_KEYS.liveMode,
      message: `Missions mode set to ${b.live ? "LIVE" : "TEST"}`,
      after: { live: b.live },
    });
  }
  const ctx = await getMissionContext();
  res.json({
    live: ctx.live,
    bankingChannelId: ctx.bankingChannelId,
    npcSpendingChannelId: ctx.npcSpendingChannelId,
    npcAnnouncementChannelId: ctx.npcAnnouncementChannelId,
    threadChannelId: ctx.threadChannelId,
    defaultImageUrl: ctx.defaultImageUrl || null,
    autopayDelayHours: Math.round((ctx.autopayDelayMs / 3_600_000) * 100) / 100,
  });
});

router.get("/missions/actor-report", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const isAdmin = hasRole(req.user!.roles, "ADMIN");
  const override = typeof req.query.fixerId === "string" ? req.query.fixerId : null;
  // Admins may query any fixer (or all when fixerId omitted); fixers are
  // locked to their own report.
  const fixerId = isAdmin ? override : req.user!.id;
  res.json(await getActorReport(fixerId));
});

router.get("/missions/attendance-report", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  res.json(await getAttendanceReport());
});

// Legacy actor history imported from the old Discord bot. Aggregate "who acted,
// how many times, total paid" across free-form events. Fixer/admin only.
router.get("/missions/actor-history", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  res.json(await getActorHistory());
});

// Actor search — fixers/admins look up ANY user by name to pay as a mission
// actor/NPC. Not limited to assigned players. Mirrors the archive owner-picker.
// MUST be registered before "/missions/:id" or that param route shadows it.
router.get("/missions/actor-search", requireAuth, async (req, res): Promise<void> => {
  // Read-only actor picker for the actor-payout flow. Full managers always have
  // it. A trial fixer gets it ONLY while they own an approved/posted mission
  // (so they can pay its actors) — NOT every trial fixer, keeping this off the
  // global cross-mission tooling that stays manager-only.
  if (!isManager(req)) {
    const viewer = viewerOf(req);
    const allowed = viewer.isTrialAuthor && (await viewerHasManageableMission(viewer.id));
    if (!allowed) {
      res.status(403).json({ error: "Fixer or admin role required" });
      return;
    }
  }
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length === 0) {
    res.json([]);
    return;
  }
  const like = `%${q}%`;
  // Match the player directly (Discord username / global name) OR by any of
  // their character names — most players are known by their character, not
  // their Discord handle, so resolve character-name hits back to the owner.
  const directUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(or(ilike(users.username, like), ilike(users.globalName, like)))
    .limit(50);
  const charOwners = await db
    .select({ ownerId: characters.ownerId })
    .from(characters)
    .where(and(ilike(characters.name, like), isNotNull(characters.ownerId)))
    .limit(200);
  const idSet = new Set<string>();
  for (const u of directUsers) idSet.add(u.id);
  for (const c of charOwners) if (c.ownerId) idSet.add(c.ownerId);
  const ids = Array.from(idSet);
  const localRows = ids.length
    ? await db
        .select({ id: users.id, username: users.username, globalName: users.globalName, avatarUrl: users.avatarUrl })
        .from(users)
        .where(inArray(users.id, ids))
        .orderBy(asc(users.username))
        .limit(50)
    : [];

  // Also search the whole Discord guild so actors who have never signed in to
  // the portal (and so have no `users` row) are still payable — they're minted
  // a stub `users` row on payout. Best-effort: if Discord is unreachable we
  // still return the local matches rather than failing the search outright.
  const seen = new Set(localRows.map((r) => r.id));
  const merged: Array<{ id: string; username: string; globalName: string | null; avatarUrl: string | null }> = [
    ...localRows,
  ];
  const guildMembers = await searchGuildMembers(q, 25);
  if (guildMembers) {
    for (const m of guildMembers) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push({ id: m.id, username: m.username, globalName: m.globalName, avatarUrl: m.avatarUrl });
      if (merged.length >= 50) break;
    }
  }
  res.json(merged);
});

// Non-mission ("standalone") actor payouts — pay actors for a regular session,
// open social lobby, etc. that isn't a formal mission. MUST be registered before
// "/missions/:id" or that param route shadows it. Fixer/admin only.
router.get("/missions/actor-payouts", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  res.json(await getStandaloneActorPayouts());
});

router.post("/missions/actor-payouts", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const b = req.body ?? {};
  const eventName = typeof b.eventName === "string" ? b.eventName.trim() : "";
  const eventType = typeof b.eventType === "string" && b.eventType.trim() ? b.eventType.trim() : null;
  const userIds = Array.isArray(b.userIds) ? b.userIds.filter((x: unknown): x is string => typeof x === "string" && !!x) : [];
  const amount = Math.trunc(Number(b.amount));
  const eventId = Number.isInteger(Number(b.eventId)) && Number(b.eventId) > 0 ? Math.trunc(Number(b.eventId)) : null;
  let eventDate: Date | null = null;
  if (typeof b.eventDate === "string" && b.eventDate.trim()) {
    const parsed = new Date(b.eventDate);
    if (!Number.isNaN(parsed.getTime())) eventDate = parsed;
  }
  if (!eventName) {
    res.status(400).json({ error: "Event label is required" });
    return;
  }
  if (userIds.length === 0) {
    res.status(400).json({ error: "Select at least one actor" });
    return;
  }
  if (!Number.isFinite(amount) || amount < 0) {
    res.status(400).json({ error: "Amount must be a non-negative number" });
    return;
  }
  const result = await payStandaloneActors(
    { eventName, eventType, eventDate, eventId, userIds, amount },
    { req, actorId: viewerOf(req).id },
  );
  res.json({ result, payouts: await getStandaloneActorPayouts() });
});

// ---------------- DETAIL / UPDATE ----------------
router.get("/missions/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const detail = await getMissionDetail(id, viewerOf(req));
  if (!detail) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  res.json(detail);
});

router.patch("/missions/:id", requireAuth, async (req, res): Promise<void> => {
  if (!canAuthorMissions(req)) {
    res.status(403).json({ error: "Fixer, trial fixer, or admin role required" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [before] = await db.select().from(missions).where(eq(missions.id, id));
  if (!before) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  // Trial fixers may only edit missions they personally own; full managers edit
  // any mission.
  if (!isManager(req) && before.fixerId !== req.user!.id) {
    res.status(403).json({ error: "You can only edit your own missions" });
    return;
  }
  const b = req.body ?? {};
  const set: Record<string, unknown> = {};
  if (typeof b.title === "string" && b.title.trim()) set.title = b.title.trim();
  if (b.tier !== undefined) {
    const tier = parseTier(b.tier);
    if (tier == null) {
      res.status(400).json({ error: "Tier must be 1-4" });
      return;
    }
    set.tier = tier;
  }
  if (b.playerPay !== undefined) set.playerPay = Math.max(0, Math.trunc(Number(b.playerPay) || 0));
  if (b.npcPayAmount !== undefined) set.npcPayAmount = Math.max(0, Math.trunc(Number(b.npcPayAmount) || 0));
  if (b.location !== undefined) set.location = typeof b.location === "string" ? b.location : null;
  if (b.description !== undefined) set.description = typeof b.description === "string" ? b.description : null;
  if (b.imageUrl !== undefined) set.imageUrl = typeof b.imageUrl === "string" && b.imageUrl ? b.imageUrl : null;
  if (b.startAt !== undefined) {
    const d = parseDate(b.startAt);
    if (d === undefined) {
      res.status(400).json({ error: "Invalid start date" });
      return;
    }
    set.startAt = d;
  }
  if (b.durationMinutes !== undefined) set.durationMinutes = Math.max(1, Math.trunc(Number(b.durationMinutes) || 120));
  if (b.slots !== undefined) set.slots = Math.max(0, Math.trunc(Number(b.slots) || 0));
  if (b.status !== undefined) {
    if (!isMissionStatus(b.status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    set.status = b.status;
  }
  // --- Task #62 fields ---
  if (b.worldLink !== undefined) set.worldLink = typeof b.worldLink === "string" && b.worldLink.trim() ? b.worldLink.trim() : null;
  if (b.jobType !== undefined) {
    if (b.jobType === null || b.jobType === "") set.jobType = null;
    else if (isJobType(b.jobType)) set.jobType = b.jobType;
    else {
      res.status(400).json({ error: "Job type must be combat, non_combat, or mixed" });
      return;
    }
  }
  if (b.requestedSkills !== undefined) set.requestedSkills = typeof b.requestedSkills === "string" && b.requestedSkills.trim() ? b.requestedSkills.trim() : null;
  if (b.client !== undefined) set.client = typeof b.client === "string" && b.client.trim() ? b.client.trim() : null;
  if (b.notesForPlayers !== undefined) set.notesForPlayers = typeof b.notesForPlayers === "string" && b.notesForPlayers.trim() ? b.notesForPlayers.trim() : null;
  if (b.maxPlayers !== undefined) set.maxPlayers = Math.max(0, Math.trunc(Number(b.maxPlayers) || 0));

  // Reschedule resets the pre-mission NPC announcement so it re-fires for the
  // new start time.
  const rescheduled =
    set.startAt !== undefined && before.startAt?.getTime() !== (set.startAt as Date | null)?.getTime();
  if (rescheduled) set.npcAnnouncedAt = null;

  if (Object.keys(set).length > 0) {
    await db.update(missions).set(set).where(eq(missions.id, id));
  }
  const assignments = await normalizeAssignments(b.assignments);
  if (assignments) {
    const newlyAssigned = await applyAssignments(id, assignments);
    await createParticipationRequests(
      { id, title: (set.title as string) ?? before.title },
      newlyAssigned,
      req.user!.id,
      req.user!.username,
    );
  }

  // Re-read and re-sync the Discord event for the new state.
  const [after] = await db.select().from(missions).where(eq(missions.id, id));
  const ctx = await getMissionContext();
  const sync = await syncMissionDiscordEvent(after, ctx, after.imageUrl);
  if (sync.discordEventId !== after.discordEventId || sync.discordSyncError !== after.discordSyncError) {
    await db.update(missions).set(sync).where(eq(missions.id, id));
  }

  const action =
    set.status === "cancelled" && before.status !== "cancelled"
      ? "mission.cancel"
      : set.startAt !== undefined && before.startAt?.getTime() !== (set.startAt as Date | null)?.getTime()
        ? "mission.reschedule"
        : "mission.update";
  await recordAudit({
    req,
    category: "mission",
    action,
    targetType: "mission",
    targetId: id,
    message: `${action} (${ctx.live ? "LIVE" : "TEST"})`,
    before: { status: before.status, startAt: before.startAt, title: before.title, tier: before.tier, playerPay: before.playerPay },
    after: { ...set },
  });

  const detail = await getMissionDetail(id, viewerOf(req));
  res.json(detail);
});

// Hard-delete a draft mission. Owning fixer/admin only; drafts only (anything
// further along must be cancelled via PATCH status instead).
router.delete("/missions/:id", requireAuth, async (req, res): Promise<void> => {
  if (!canAuthorMissions(req)) {
    res.status(403).json({ error: "Fixer, trial fixer, or admin role required" });
    return;
  }
  const id = missionIdParam(req, res);
  if (id == null) return;
  const result = await deleteMission(id, viewerOf(req), req);
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.status(204).end();
});

// ---------------- PAYMENTS ----------------
router.post("/missions/:id/pay-actors", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!(await ensureCanManageMission(req, res, id))) return;
  const b = req.body ?? {};
  const userIds = Array.isArray(b.userIds) ? b.userIds.filter((x: unknown): x is string => typeof x === "string" && !!x) : [];
  const amount = Math.trunc(Number(b.amount));
  if (userIds.length === 0) {
    res.status(400).json({ error: "Select at least one actor" });
    return;
  }
  if (!Number.isFinite(amount) || amount < 0) {
    res.status(400).json({ error: "Amount must be a non-negative number" });
    return;
  }
  const result = await payMissionActors(id, userIds, amount, { req, actorId: viewerOf(req).id });
  if (result == null) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  if ("blocked" in result) {
    // Only a cancelled mission is read-only for actor payments — fixers may pay
    // actors on a mission at any point in its lifecycle otherwise (Task #185).
    res.status(409).json({
      error: "This mission is cancelled. Cancelled missions cannot pay actors.",
    });
    return;
  }
  const detail = await getMissionDetail(id, viewerOf(req));
  res.json(detail);
});

// ---------------- WORKFLOW TRANSITIONS ----------------
function missionIdParam(req: Request, res: import("express").Response): number | null {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return id;
}

// Mark a mission completed (locks actor payments). Owning fixer/admin/archivist.
router.post("/missions/:id/complete", requireAuth, async (req, res): Promise<void> => {
  const id = missionIdParam(req, res);
  if (id == null) return;
  const result = await setMissionCompleted(id, true, viewerOf(req), req);
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

// Reopen a completed mission (unlocks actor payments). Admin/archivist only.
router.post("/missions/:id/uncomplete", requireAuth, async (req, res): Promise<void> => {
  const id = missionIdParam(req, res);
  if (id == null) return;
  const result = await setMissionCompleted(id, false, viewerOf(req), req);
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

// Fixer submits a draft for staff review.
router.post("/missions/:id/submit", requireAuth, async (req, res): Promise<void> => {
  if (!canAuthorMissions(req)) {
    res.status(403).json({ error: "Fixer, trial fixer, or admin role required" });
    return;
  }
  const id = missionIdParam(req, res);
  if (id == null) return;
  const result = await submitMissionProposal(id, viewerOf(req), req);
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

// Archivist/admin approves a proposal.
router.post("/missions/:id/approve", requireAuth, async (req, res): Promise<void> => {
  if (!canApprove(req)) {
    res.status(403).json({ error: "Archivist or admin role required" });
    return;
  }
  const id = missionIdParam(req, res);
  if (id == null) return;
  const result = await approveMission(id, viewerOf(req), req);
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

// Post an approved mission to the public board (manager).
router.post("/missions/:id/post", requireAuth, async (req, res): Promise<void> => {
  const id = missionIdParam(req, res);
  if (id == null) return;
  if (!(await ensureCanManageMission(req, res, id))) return;
  const result = await postMission(id, viewerOf(req), req);
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

// ---------------- APPLICATIONS ----------------
// Player applies to a posted mission with one of their own characters.
router.post("/missions/:id/applications", requireAuth, async (req, res): Promise<void> => {
  const id = missionIdParam(req, res);
  if (id == null) return;
  const b = req.body ?? {};
  const characterId = Number(b.characterId);
  if (!Number.isInteger(characterId)) {
    res.status(400).json({ error: "characterId is required" });
    return;
  }
  const comment = typeof b.comment === "string" ? b.comment : null;
  const availability = Array.isArray(b.availability)
    ? (b.availability as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined;
  const makeDefault = b.makeDefault === true;
  const defaultPattern = Array.isArray(b.defaultPattern)
    ? (b.defaultPattern as unknown[])
        .map((v) => ({ weekday: Number((v as any)?.weekday), minutes: Number((v as any)?.minutes) }))
    : undefined;
  const timezone = typeof b.timezone === "string" ? b.timezone : undefined;
  const result = await applyToMission({
    missionId: id,
    userId: req.user!.id,
    characterId,
    comment,
    availability,
    makeDefault,
    defaultPattern,
    timezone,
  });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

// Player's saved weekly availability default — pre-fills the apply-form picker.
router.get("/me/availability-default", requireAuth, async (req, res): Promise<void> => {
  res.json(await getDefaultAvailability(req.user!.id));
});

// Player withdraws their own application.
router.delete("/missions/:id/applications/:appId", requireAuth, async (req, res): Promise<void> => {
  const id = missionIdParam(req, res);
  if (id == null) return;
  const appId = parseInt(String(req.params.appId), 10);
  if (!Number.isInteger(appId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const result = await withdrawApplication({ missionId: id, applicationId: appId, userId: req.user!.id });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

// Fixer/admin accepts or rejects an application.
router.post("/missions/:id/applications/:appId/review", requireAuth, async (req, res): Promise<void> => {
  const id = missionIdParam(req, res);
  if (id == null) return;
  if (!(await ensureCanManageMission(req, res, id))) return;
  const appId = parseInt(String(req.params.appId), 10);
  if (!Number.isInteger(appId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const action = req.body?.action;
  if (action !== "accept" && action !== "reject") {
    res.status(400).json({ error: "action must be 'accept' or 'reject'" });
    return;
  }
  const result = await reviewApplication({
    missionId: id,
    applicationId: appId,
    action,
    viewer: viewerOf(req),
    req,
  });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

// Fixer/admin removes an accepted player from a mission's roster. Reverts the
// player's attendance + frees their application; blocked if they were paid.
router.delete("/missions/:id/assignments/:userId", requireAuth, async (req, res): Promise<void> => {
  const id = missionIdParam(req, res);
  if (id == null) return;
  if (!(await ensureCanManageMission(req, res, id))) return;
  const userId = String(req.params.userId);
  if (!userId) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const result = await removeAssignedPlayer({
    missionId: id,
    userId,
    viewer: viewerOf(req),
    req,
  });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

// ---------------- NPC SIGN-UPS (Task #185) ----------------
// Player signs up to NPC on a not-yet-completed mission (optionally with one of
// their own characters). Idempotent.
router.post("/missions/:id/npc-signups", requireAuth, async (req, res): Promise<void> => {
  const id = missionIdParam(req, res);
  if (id == null) return;
  const b = req.body ?? {};
  let characterId: number | null = null;
  if (b.characterId !== undefined && b.characterId !== null) {
    characterId = Number(b.characterId);
    if (!Number.isInteger(characterId)) {
      res.status(400).json({ error: "characterId must be an integer" });
      return;
    }
  }
  const result = await signUpAsNpc({ missionId: id, userId: req.user!.id, characterId });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

// Player withdraws their own active (not-yet-confirmed) NPC sign-up.
router.delete("/missions/:id/npc-signups/me", requireAuth, async (req, res): Promise<void> => {
  const id = missionIdParam(req, res);
  if (id == null) return;
  const result = await withdrawNpcSignup({ missionId: id, userId: req.user!.id });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

// Fixer/admin confirms an NPC sign-up: attended (pays) or no_show.
router.post("/missions/:id/npc-signups/:signupId/confirm", requireAuth, async (req, res): Promise<void> => {
  const id = missionIdParam(req, res);
  if (id == null) return;
  const signupId = parseInt(String(req.params.signupId), 10);
  if (!Number.isInteger(signupId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const action = req.body?.action;
  if (action !== "attended" && action !== "no_show") {
    res.status(400).json({ error: "action must be 'attended' or 'no_show'" });
    return;
  }
  const result = await confirmNpcSignup({
    missionId: id,
    signupId,
    action,
    viewer: viewerOf(req),
    req,
  });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
});

export default router;
