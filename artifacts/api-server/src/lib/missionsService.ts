import type { Request } from "express";
import { and, eq, desc, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  missions,
  missionAssignments,
  missionActorPayments,
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
} from "./discord";
import { getMissionContext, type MissionExternalContext } from "./missionsConfig";

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
    startAt: iso(m.startAt),
    durationMinutes: m.durationMinutes,
    location: m.location,
    descriptionPreview: preview(m.description),
    imageUrl: m.imageUrl,
    playerPay: m.playerPay,
    slots: m.slots,
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
  const where = opts.status && isMissionStatus(opts.status) ? eq(missions.status, opts.status) : undefined;
  const rows = await loadMissions(where, opts.limit ?? 200);
  const byMission = await loadAssignments(rows.map((r) => r.id));
  return rows.map((m) => toSummary(m, byMission.get(m.id) ?? [], opts.viewer.id));
}

/** Missions the caller is assigned to that are not cancelled/fully closed. */
export async function listMyMissionSummaries(viewer: MissionViewer) {
  const mine = await db
    .select({ missionId: missionAssignments.missionId })
    .from(missionAssignments)
    .where(eq(missionAssignments.userId, viewer.id));
  const ids = [...new Set(mine.map((m) => m.missionId))];
  if (ids.length === 0) return [];
  const rows = (await loadMissions(undefined)).filter((m) => ids.includes(m.id) && m.status !== "cancelled");
  const byMission = await loadAssignments(rows.map((r) => r.id));
  return rows.map((m) => toSummary(m, byMission.get(m.id) ?? [], viewer.id));
}

export async function getMissionDetail(missionId: number, viewer: MissionViewer) {
  const rows = await loadMissions(eq(missions.id, missionId));
  const m = rows[0];
  if (!m) return null;
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

  const canManage = viewer.isManager;
  return {
    id: m.id,
    title: m.title,
    tier: m.tier,
    status: m.status,
    startAt: iso(m.startAt),
    durationMinutes: m.durationMinutes,
    location: m.location,
    description: m.description,
    imageUrl: m.imageUrl,
    playerPay: m.playerPay,
    slots: m.slots,
    fixerId: m.fixerId,
    fixerName: m.fixerName,
    fixerAvatarUrl: m.fixerAvatarUrl,
    discordEventId: m.discordEventId,
    discordSyncError: m.discordSyncError,
    canManage,
    live: ctx.live,
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

  const shouldExist = mission.status !== "cancelled" && !!mission.startAt;

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

function advanceAfterPlayersPaid(status: string): string {
  // Players just got paid: move any pre-payout state to "players paid".
  if (status === "open" || status === "pending" || status === "completed") {
    return "completed_players_paid";
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

  // Mark processed (auto-pay idempotency) and advance status.
  const newStatus = advanceAfterPlayersPaid(mission.status);
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
