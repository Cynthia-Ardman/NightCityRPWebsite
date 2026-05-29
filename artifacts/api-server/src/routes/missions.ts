import { Router, type IRouter, type Request } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  missions,
  missionAssignments,
  characters,
  botConfig,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole } from "../lib/discord";
import { getMissionContext, MISSION_CONFIG_KEYS } from "../lib/missionsConfig";
import { recordAudit } from "../lib/audit";
import {
  listMissionSummaries,
  listMyMissionSummaries,
  listOwnedMissionSummaries,
  getMissionDetail,
  payMissionPlayers,
  payMissionActors,
  syncMissionDiscordEvent,
  getActorReport,
  getAttendanceReport,
  isMissionStatus,
  isJobType,
  submitMissionProposal,
  approveMission,
  postMission,
  applyToMission,
  withdrawApplication,
  reviewApplication,
  checkDiscordEventConflict,
  type MissionViewer,
} from "../lib/missionsService";

const router: IRouter = Router();

function viewerOf(req: Request): MissionViewer {
  const u = req.user!;
  const isAdmin = hasRole(u.roles, "ADMIN");
  return {
    id: u.id,
    isManager: isAdmin || hasRole(u.roles, "FIXER"),
    isAdmin,
    isArchivist: isAdmin || hasRole(u.roles, "ARCHIVIST"),
  };
}

function canApprove(req: Request): boolean {
  const roles = req.user?.roles ?? [];
  return hasRole(roles, "ADMIN") || hasRole(roles, "ARCHIVIST");
}

function isManager(req: Request): boolean {
  const roles = req.user?.roles ?? [];
  return hasRole(roles, "ADMIN") || hasRole(roles, "FIXER");
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
): Promise<void> {
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

  for (const d of desired) {
    const cur = existingByUser.get(d.userId);
    if (cur) {
      if (cur.characterId !== d.characterId) {
        await db.update(missionAssignments).set({ characterId: d.characterId }).where(eq(missionAssignments.id, cur.id));
      }
    } else {
      await db.insert(missionAssignments).values({ missionId, userId: d.userId, characterId: d.characterId });
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
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
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
  if (assignments) await applyAssignments(created.id, assignments);

  // Discord sync (Test/Live gated). Persist event id / error without blocking.
  const sync = await syncMissionDiscordEvent(created, ctx, created.imageUrl);
  if (sync.discordEventId !== created.discordEventId || sync.discordSyncError !== created.discordSyncError) {
    await db.update(missions).set(sync).where(eq(missions.id, created.id));
  }

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

// ---------------- SPECIFIC ROUTES (must precede /missions/:id) ----------------
router.get("/missions/mine", requireAuth, async (req, res): Promise<void> => {
  res.json(await listMyMissionSummaries(viewerOf(req)));
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

// Fail-safe Discord scheduling-conflict check for the create/reschedule form.
router.get("/missions/conflicts", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
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
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const ctx = await getMissionContext();
  res.json({
    live: ctx.live,
    bankingChannelId: ctx.bankingChannelId,
    npcSpendingChannelId: ctx.npcSpendingChannelId,
    npcAnnouncementChannelId: ctx.npcAnnouncementChannelId,
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
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
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
  if (assignments) await applyAssignments(id, assignments);

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

// ---------------- PAYMENTS ----------------
router.post("/missions/:id/pay-players", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const result = await payMissionPlayers(id, { source: "manual", req });
  if (result == null) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }
  const detail = await getMissionDetail(id, viewerOf(req));
  res.json(detail);
});

router.post("/missions/:id/pay-actors", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
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
  const result = await payMissionActors(id, userIds, amount, { req });
  if (result == null) {
    res.status(404).json({ error: "Mission not found" });
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

// Fixer submits a draft for staff review.
router.post("/missions/:id/submit", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
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
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const id = missionIdParam(req, res);
  if (id == null) return;
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
  const result = await applyToMission({ missionId: id, userId: req.user!.id, characterId, comment });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getMissionDetail(id, viewerOf(req)));
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
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const id = missionIdParam(req, res);
  if (id == null) return;
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

export default router;
