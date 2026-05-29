import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";

// Currency provider is fully mocked: no test ever hits the real UB API.
vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));

// Discord is PARTIALLY mocked: keep the real role helpers (hasRole/ROLE_NAMES)
// so route authorization is genuinely exercised, but stub every network call
// so we can assert whether the Test/Live gate fired them.
vi.mock("../lib/discord", async (importActual) => {
  const actual = await importActual<typeof import("../lib/discord")>();
  return {
    ...actual,
    postToChannel: vi.fn(async () => "msg-id"),
    createGuildScheduledEvent: vi.fn(async () => ({ ok: true, id: "evt-1" })),
    modifyGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
    deleteGuildScheduledEvent: vi.fn(async (id: string) => ({ ok: true, id })),
  };
});

import {
  db,
  missions,
  missionAssignments,
  missionActorPayments,
  missionApplications,
  botConfig,
} from "@workspace/db";
import { patchBalance } from "../lib/unbelievaboat";
import {
  postToChannel,
  createGuildScheduledEvent,
  modifyGuildScheduledEvent,
  deleteGuildScheduledEvent,
} from "../lib/discord";
import {
  payMissionPlayers,
  payMissionActors,
  runMissionAutoPay,
  runMissionNpcAnnouncements,
} from "../lib/missionsService";
import { MISSION_CONFIG_KEYS } from "../lib/missionsConfig";
import { LIVE_MODE_KEYS } from "../lib/liveMode";
import { isAutobillEnabled, AUTOBILL_FLAGS } from "../lib/jobs";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockPatch = vi.mocked(patchBalance);
const mockPost = vi.mocked(postToChannel);
const mockCreateEvent = vi.mocked(createGuildScheduledEvent);
const mockModifyEvent = vi.mocked(modifyGuildScheduledEvent);
const mockDeleteEvent = vi.mocked(deleteGuildScheduledEvent);

const bal = (cash: number) => ({ cash, bank: 0, total: cash, source: "unbelievaboat" as const });

beforeEach(() => {
  mockPatch.mockReset();
  mockPost.mockReset();
  mockPost.mockResolvedValue("msg-id");
  mockCreateEvent.mockReset();
  mockCreateEvent.mockResolvedValue({ ok: true, id: "evt-1" });
  mockModifyEvent.mockReset();
  mockModifyEvent.mockImplementation(async (id: string) => ({ ok: true, id }));
  mockDeleteEvent.mockReset();
  mockDeleteEvent.mockImplementation(async (id: string) => ({ ok: true, id }));
});

// --- config helpers --------------------------------------------------------
async function setConfig(key: string, value: unknown): Promise<void> {
  await db
    .insert(botConfig)
    .values({ key, value: value as never })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: value as never } });
}
// Missions go Live only when BOTH the master switch and the missions override
// are Live, so the helper flips both. Test-mode setup just leaves them off.
async function setLiveMode(live: boolean): Promise<void> {
  await setConfig(LIVE_MODE_KEYS.master, live);
  await setConfig(MISSION_CONFIG_KEYS.liveMode, live);
}

// --- seed helpers ----------------------------------------------------------
async function seedMission(opts: Partial<typeof missions.$inferInsert> = {}) {
  const [m] = await db
    .insert(missions)
    .values({
      title: opts.title ?? "Test Mission",
      tier: opts.tier ?? 1,
      playerPay: opts.playerPay ?? 100,
      status: opts.status ?? "completed",
      // Default workflowState to the schema default unless a test overrides it.
      ...(opts.workflowState !== undefined ? { workflowState: opts.workflowState } : {}),
      worldLink: opts.worldLink ?? null,
      jobType: opts.jobType ?? null,
      requestedSkills: opts.requestedSkills ?? null,
      fixerId: opts.fixerId ?? null,
      startAt: opts.startAt ?? null,
      durationMinutes: opts.durationMinutes ?? 120,
      slots: opts.slots ?? 4,
      npcAnnouncedAt: opts.npcAnnouncedAt ?? null,
      autoPayProcessedAt: opts.autoPayProcessedAt ?? null,
    })
    .returning();
  return m;
}

async function seedAssignment(
  missionId: number,
  userId: string,
  opts: Partial<typeof missionAssignments.$inferInsert> = {},
) {
  const [a] = await db
    .insert(missionAssignments)
    .values({
      missionId,
      userId,
      characterId: opts.characterId ?? null,
      paymentStatus: opts.paymentStatus ?? "unpaid",
      attendanceCreditedAt: opts.attendanceCreditedAt ?? null,
    })
    .returning();
  return a;
}

// ===========================================================================
// TEST MODE — the Test/Live safety gate must never touch real money/Discord.
// ===========================================================================
describe("Test mode (default) records simulated rows and fires NO external effects", () => {
  it("player payout: records simulated, no UB call, no Discord post", async () => {
    const player = await createUser();
    const m = await seedMission({ playerPay: 100 });
    await seedAssignment(m.id, player.id);

    const result = await payMissionPlayers(m.id, { source: "manual" });
    expect(result).not.toBeNull();
    expect(result!.live).toBe(false);
    expect(result!.simulated).toBe(1);
    expect(result!.paid).toBe(0);
    // The defining safety property: no real money, no banking post.
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();

    const [a] = await db.select().from(missionAssignments).where(eq(missionAssignments.missionId, m.id));
    expect(a.paymentStatus).toBe("simulated");
    expect(a.payAmount).toBe(100);
    expect(a.paidAt).not.toBeNull();
    // Status still advances so fixers can rehearse the whole flow.
    const [after] = await db.select().from(missions).where(eq(missions.id, m.id));
    expect(after.status).toBe("completed_players_paid");
  });

  it("actor payout: records a simulated row, no UB call, no Discord post", async () => {
    const actor = await createUser();
    const m = await seedMission();

    const result = await payMissionActors(m.id, [actor.id], 50, {});
    expect(result!.live).toBe(false);
    expect(result!.simulated).toBe(1);
    expect(result!.paid).toBe(0);
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();

    const rows = await db.select().from(missionActorPayments).where(eq(missionActorPayments.missionId, m.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].paymentStatus).toBe("simulated");
    expect(rows[0].amount).toBe(50);
  });

  it("creating a mission in Test mode does not sync a Discord event", async () => {
    const manager = await createUser({ roles: ["admin"] });
    const res = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Heist", tier: 2, startAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(res.status).toBe(201);
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(res.body.discordEventId).toBeNull();
  });
});

// ===========================================================================
// LIVE MODE — real payouts happen, exactly once.
// ===========================================================================
describe("Live mode player payout", () => {
  it("credits the player via UB, posts to banking, marks paid", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(100));
    const player = await createUser();
    const m = await seedMission({ playerPay: 100 });
    await seedAssignment(m.id, player.id);

    const result = await payMissionPlayers(m.id, { source: "manual" });
    expect(result!.live).toBe(true);
    expect(result!.paid).toBe(1);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch.mock.calls[0][0]).toBe(player.discordId);
    expect(mockPatch.mock.calls[0][1]).toMatchObject({ cash: 100 });
    expect(mockPost).toHaveBeenCalledTimes(1); // banking summary

    const [a] = await db.select().from(missionAssignments).where(eq(missionAssignments.missionId, m.id));
    expect(a.paymentStatus).toBe("paid");
  });

  it("zero-pay assignment credits attendance without touching UB", async () => {
    await setLiveMode(true);
    const player = await createUser();
    const m = await seedMission({ playerPay: 0 });
    await seedAssignment(m.id, player.id);

    const result = await payMissionPlayers(m.id, { source: "manual" });
    expect(result!.paid).toBe(1);
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("records 'failed' and does not advance status when the UB payout fails", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(null); // UB rejected
    const player = await createUser();
    const m = await seedMission({ playerPay: 100, status: "completed" });
    await seedAssignment(m.id, player.id);

    const result = await payMissionPlayers(m.id, { source: "manual" });
    expect(result!.failed).toBe(1);
    expect(result!.paid).toBe(0);
    const [a] = await db.select().from(missionAssignments).where(eq(missionAssignments.missionId, m.id));
    expect(a.paymentStatus).toBe("failed");
    // A player went unpaid → mission must NOT be marked players-paid.
    const [after] = await db.select().from(missions).where(eq(missions.id, m.id));
    expect(after.status).toBe("completed");
  });

  it("never pays a cancelled mission", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(100));
    const player = await createUser();
    const m = await seedMission({ playerPay: 100, status: "cancelled" });
    await seedAssignment(m.id, player.id);

    const result = await payMissionPlayers(m.id, { source: "manual" });
    expect(result!.paid).toBe(0);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// IDEMPOTENCY — repeated/concurrent calls must never double-pay real money.
// ===========================================================================
describe("Player pay idempotency", () => {
  it("a repeated pay call skips the already-paid assignment (no double-pay)", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(100));
    const player = await createUser();
    const m = await seedMission({ playerPay: 100 });
    await seedAssignment(m.id, player.id);

    const first = await payMissionPlayers(m.id, { source: "manual" });
    const second = await payMissionPlayers(m.id, { source: "auto", actorName: "cron" });
    expect(first!.paid).toBe(1);
    expect(second!.paid).toBe(0);
    expect(second!.skipped).toBe(1);
    expect(mockPatch).toHaveBeenCalledTimes(1); // paid exactly once
  });

  it("concurrent pay calls credit the player exactly once", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(100));
    const player = await createUser();
    const m = await seedMission({ playerPay: 100 });
    await seedAssignment(m.id, player.id);

    const [r1, r2] = await Promise.all([
      payMissionPlayers(m.id, { source: "manual" }),
      payMissionPlayers(m.id, { source: "auto", actorName: "cron" }),
    ]);
    // Exactly one worker paid; the other saw the row already claimed/paid.
    expect((r1!.paid ?? 0) + (r2!.paid ?? 0)).toBe(1);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const [a] = await db.select().from(missionAssignments).where(eq(missionAssignments.missionId, m.id));
    expect(a.paymentStatus).toBe("paid");
  });
});

describe("Actor pay idempotency", () => {
  it("a repeated actor pay skips the already-paid actor", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(50));
    const actor = await createUser();
    const m = await seedMission();

    const first = await payMissionActors(m.id, [actor.id], 50, {});
    const second = await payMissionActors(m.id, [actor.id], 50, {});
    expect(first!.paid).toBe(1);
    expect(second!.paid).toBe(0);
    expect(second!.skipped).toBe(1);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const paidRows = await db
      .select()
      .from(missionActorPayments)
      .where(eq(missionActorPayments.paymentStatus, "paid"));
    expect(paidRows).toHaveLength(1);
  });

  it("concurrent actor pays credit the actor exactly once", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(50));
    const actor = await createUser();
    const m = await seedMission();

    const [r1, r2] = await Promise.all([
      payMissionActors(m.id, [actor.id], 50, {}),
      payMissionActors(m.id, [actor.id], 50, {}),
    ]);
    expect((r1!.paid ?? 0) + (r2!.paid ?? 0)).toBe(1);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    // The partial unique index guarantees a single successful (mission, actor) row.
    const paidRows = await db
      .select()
      .from(missionActorPayments)
      .where(eq(missionActorPayments.paymentStatus, "paid"));
    expect(paidRows).toHaveLength(1);
  });
});

// ===========================================================================
// normalizeAssignments — exercised end-to-end via POST /missions.
// ===========================================================================
describe("normalizeAssignments (via mission create)", () => {
  async function createMissionWith(managerId: string, assignments: unknown[]) {
    const res = await request(app)
      .post("/api/missions")
      .set("x-test-user", managerId)
      .send({ title: "Run", tier: 1, assignments });
    expect(res.status).toBe(201);
    return res.body as { id: number; assignments: Array<{ userId: string; characterId: number | null }> };
  }

  it("derives the userId from a character's owner when only characterId is supplied", async () => {
    const manager = await createUser({ roles: ["admin"] });
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const body = await createMissionWith(manager.id, [{ characterId: char.id }]);
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0].userId).toBe(player.id);
    expect(body.assignments[0].characterId).toBe(char.id);
  });

  it("skips an unclaimed character (no owner, no explicit userId)", async () => {
    const manager = await createUser({ roles: ["admin"] });
    const orphan = await createCharacter({ ownerId: null });
    const body = await createMissionWith(manager.id, [{ characterId: orphan.id }]);
    expect(body.assignments).toHaveLength(0);
  });

  it("nulls a character whose owner does not match the explicit userId", async () => {
    const manager = await createUser({ roles: ["admin"] });
    const playerA = await createUser();
    const playerB = await createUser();
    const charB = await createCharacter({ ownerId: playerB.id });
    const body = await createMissionWith(manager.id, [{ userId: playerA.id, characterId: charB.id }]);
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0].userId).toBe(playerA.id);
    expect(body.assignments[0].characterId).toBeNull();
  });
});

// ===========================================================================
// AUTO-PAY CRON — only processes past-window missions; gated by a kill switch.
// ===========================================================================
describe("runMissionAutoPay window selection", () => {
  it("processes only missions whose run window has fully elapsed", async () => {
    const player = await createUser();
    // Past: started 10h ago, 2h duration + 3.5h default delay → window long gone.
    const past = await seedMission({ playerPay: 0, status: "completed", startAt: new Date(Date.now() - 10 * 3_600_000) });
    await seedAssignment(past.id, player.id);
    // Future: starts in 1h → window not reached.
    const future = await seedMission({ playerPay: 0, status: "open", startAt: new Date(Date.now() + 3_600_000) });
    await seedAssignment(future.id, player.id);

    const processed = await runMissionAutoPay();
    expect(processed).toBe(1);

    const [pastAfter] = await db.select().from(missions).where(eq(missions.id, past.id));
    expect(pastAfter.autoPayProcessedAt).not.toBeNull();
    const [futureAfter] = await db.select().from(missions).where(eq(missions.id, future.id));
    expect(futureAfter.autoPayProcessedAt).toBeNull();

    const [futureAssign] = await db.select().from(missionAssignments).where(eq(missionAssignments.missionId, future.id));
    expect(futureAssign.paymentStatus).toBe("unpaid"); // untouched
  });

  it("skips missions that were already auto-processed", async () => {
    const player = await createUser();
    const m = await seedMission({
      playerPay: 0,
      status: "completed_players_paid",
      startAt: new Date(Date.now() - 10 * 3_600_000),
      autoPayProcessedAt: new Date(),
    });
    await seedAssignment(m.id, player.id, { paymentStatus: "paid" });
    const processed = await runMissionAutoPay();
    expect(processed).toBe(0);
  });

  it("skips cancelled and unscheduled missions", async () => {
    const player = await createUser();
    const cancelled = await seedMission({ status: "cancelled", startAt: new Date(Date.now() - 10 * 3_600_000) });
    await seedAssignment(cancelled.id, player.id);
    const unscheduled = await seedMission({ status: "open", startAt: null });
    await seedAssignment(unscheduled.id, player.id);
    const processed = await runMissionAutoPay();
    expect(processed).toBe(0);
  });
});

describe("auto-pay kill switch", () => {
  it("defaults OFF so the cron skips on a fresh environment", async () => {
    // The */15 cron callback runs runMissionAutoPay ONLY when this predicate is
    // true; with no bot_config row it must be false (fail-safe).
    expect(await isAutobillEnabled(AUTOBILL_FLAGS.missionAutopay)).toBe(false);
  });

  it("enables the cron only when explicitly flipped to the literal true", async () => {
    await setConfig(AUTOBILL_FLAGS.missionAutopay, false);
    expect(await isAutobillEnabled(AUTOBILL_FLAGS.missionAutopay)).toBe(false);
    await setConfig(AUTOBILL_FLAGS.missionAutopay, true);
    expect(await isAutobillEnabled(AUTOBILL_FLAGS.missionAutopay)).toBe(true);
  });
});

// ===========================================================================
// DISCORD SCHEDULED-EVENT SYNC — gated by the Test/Live switch, driven through
// the real create/patch/cancel HTTP endpoints.
// ===========================================================================
const futureIso = () => new Date(Date.now() + 86_400_000).toISOString();

describe("Discord scheduled-event sync", () => {
  it("creates an event and persists its id when a scheduled mission is created Live", async () => {
    await setLiveMode(true);
    const manager = await createUser({ roles: ["admin"] });
    const res = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Heist", tier: 2, startAt: futureIso() });
    expect(res.status).toBe(201);
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(res.body.discordEventId).toBe("evt-1");
    expect(res.body.discordSyncError).toBeNull();
  });

  it("does NOT create an event for a Live mission with no start date", async () => {
    await setLiveMode(true);
    const manager = await createUser({ roles: ["admin"] });
    const res = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Open Run", tier: 1 });
    expect(res.status).toBe(201);
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(res.body.discordEventId).toBeNull();
  });

  it("records the sync error and leaves the event id null when create fails", async () => {
    await setLiveMode(true);
    mockCreateEvent.mockResolvedValue({ ok: false, error: "rate limited" });
    const manager = await createUser({ roles: ["admin"] });
    const res = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Doomed", tier: 1, startAt: futureIso() });
    expect(res.status).toBe(201);
    expect(res.body.discordEventId).toBeNull();
    expect(res.body.discordSyncError).toBe("rate limited");
    const [row] = await db.select().from(missions).where(eq(missions.id, res.body.id));
    expect(row.discordSyncError).toBe("rate limited");
  });

  it("modifies the existing event when a scheduled Live mission is edited", async () => {
    await setLiveMode(true);
    const manager = await createUser({ roles: ["admin"] });
    const created = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Heist", tier: 2, startAt: futureIso() });
    expect(created.body.discordEventId).toBe("evt-1");

    const patched = await request(app)
      .patch(`/api/missions/${created.body.id}`)
      .set("x-test-user", manager.id)
      .send({ title: "Heist (Reschedule)", startAt: futureIso() });
    expect(patched.status).toBe(200);
    expect(mockModifyEvent).toHaveBeenCalledTimes(1);
    expect(mockModifyEvent.mock.calls[0][0]).toBe("evt-1");
    expect(mockCreateEvent).toHaveBeenCalledTimes(1); // not re-created
  });

  it("tears down the event when a scheduled Live mission is cancelled", async () => {
    await setLiveMode(true);
    const manager = await createUser({ roles: ["admin"] });
    const created = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Heist", tier: 2, startAt: futureIso() });
    expect(created.body.discordEventId).toBe("evt-1");

    const patched = await request(app)
      .patch(`/api/missions/${created.body.id}`)
      .set("x-test-user", manager.id)
      .send({ status: "cancelled" });
    expect(patched.status).toBe(200);
    expect(mockDeleteEvent).toHaveBeenCalledTimes(1);
    expect(mockDeleteEvent.mock.calls[0][0]).toBe("evt-1");
    const [row] = await db.select().from(missions).where(eq(missions.id, created.body.id));
    expect(row.discordEventId).toBeNull();
  });

  it("does not touch Discord at all when editing in Test mode", async () => {
    const manager = await createUser({ roles: ["admin"] });
    const created = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Heist", tier: 2, startAt: futureIso() });
    await request(app)
      .patch(`/api/missions/${created.body.id}`)
      .set("x-test-user", manager.id)
      .send({ title: "Heist v2", status: "cancelled" });
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockModifyEvent).not.toHaveBeenCalled();
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// REPORTING ENDPOINTS — actor-report and attendance-report. Manager-gated;
// fixers are scoped to their own data, admins can query across fixers.
// ===========================================================================
describe("GET /missions/actor-report", () => {
  it("forbids a plain user (manager role required)", async () => {
    const user = await createUser();
    const res = await request(app).get("/api/missions/actor-report").set("x-test-user", user.id);
    expect(res.status).toBe(403);
  });

  it("aggregates paid acts per actor for a fixer", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(50));
    const fixer = await createUser({ roles: ["fixer"] });
    const actor = await createUser({ username: "ActorOne" });
    const m = await seedMission({ fixerId: fixer.id });
    await payMissionActors(m.id, [actor.id], 50, { actorId: fixer.id });

    const res = await request(app).get("/api/missions/actor-report").set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const row = res.body.find((r: { userId: string }) => r.userId === actor.id);
    expect(row).toBeTruthy();
    expect(row.actCount).toBe(1);
    expect(row.totalPaid).toBe(50);
  });

  it("scopes a fixer to their own report (cannot see another fixer's acts)", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(50));
    const fixerA = await createUser({ roles: ["fixer"] });
    const fixerB = await createUser({ roles: ["fixer"] });
    const actor = await createUser();
    const m = await seedMission({ fixerId: fixerB.id });
    await payMissionActors(m.id, [actor.id], 50, { actorId: fixerB.id });

    // fixerA queries (their own fixerId is forced server-side) → sees nothing.
    const res = await request(app).get("/api/missions/actor-report").set("x-test-user", fixerA.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe("GET /missions/attendance-report", () => {
  it("forbids a plain user (manager role required)", async () => {
    const user = await createUser();
    const res = await request(app).get("/api/missions/attendance-report").set("x-test-user", user.id);
    expect(res.status).toBe(403);
  });

  it("lists attendance once a player has been credited via a payout", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(100));
    const admin = await createUser({ roles: ["admin"] });
    const player = await createUser({ username: "PlayerOne" });
    const m = await seedMission({ playerPay: 100 });
    await seedAssignment(m.id, player.id);
    await payMissionPlayers(m.id, { source: "manual" });

    const res = await request(app).get("/api/missions/attendance-report").set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const row = res.body.find((r: { userId: string }) => r.userId === player.id);
    expect(row).toBeTruthy();
    expect(row.attendedCount).toBe(1);
  });
});

// ===========================================================================
// WORKFLOW TRANSITIONS (Task #62) — draft → proposal → approved → posted.
// Role-gated and audit-logged; enforced through the real HTTP endpoints.
// ===========================================================================
describe("Mission workflow transitions", () => {
  it("a new mission defaults to the draft workflow state", async () => {
    const manager = await createUser({ roles: ["admin"] });
    const res = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Draft Run", tier: 1 });
    expect(res.status).toBe(201);
    expect(res.body.workflowState).toBe("draft");
  });

  it("submit → approve → post walks the full pipeline (admin can do all)", async () => {
    const admin = await createUser({ roles: ["admin"] });
    const m = await seedMission({ workflowState: "draft", status: "open" });

    const submitted = await request(app).post(`/api/missions/${m.id}/submit`).set("x-test-user", admin.id);
    expect(submitted.status).toBe(200);
    expect(submitted.body.workflowState).toBe("proposal");

    const approved = await request(app).post(`/api/missions/${m.id}/approve`).set("x-test-user", admin.id);
    expect(approved.status).toBe(200);
    expect(approved.body.workflowState).toBe("approved");

    const posted = await request(app).post(`/api/missions/${m.id}/post`).set("x-test-user", admin.id);
    expect(posted.status).toBe(200);
    expect(posted.body.workflowState).toBe("posted");
  });

  it("a fixer can submit but cannot approve (archivist/admin only)", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const m = await seedMission({ workflowState: "draft" });

    const submitted = await request(app).post(`/api/missions/${m.id}/submit`).set("x-test-user", fixer.id);
    expect(submitted.status).toBe(200);
    expect(submitted.body.workflowState).toBe("proposal");

    const approved = await request(app).post(`/api/missions/${m.id}/approve`).set("x-test-user", fixer.id);
    expect(approved.status).toBe(403);
  });

  it("an archivist can approve a proposal", async () => {
    const archivist = await createUser({ roles: ["archivist"] });
    const m = await seedMission({ workflowState: "proposal" });
    const approved = await request(app).post(`/api/missions/${m.id}/approve`).set("x-test-user", archivist.id);
    expect(approved.status).toBe(200);
    expect(approved.body.workflowState).toBe("approved");
  });

  it("a plain user cannot drive any transition (403)", async () => {
    const user = await createUser();
    const m = await seedMission({ workflowState: "draft" });
    expect((await request(app).post(`/api/missions/${m.id}/submit`).set("x-test-user", user.id)).status).toBe(403);
    expect((await request(app).post(`/api/missions/${m.id}/approve`).set("x-test-user", user.id)).status).toBe(403);
    expect((await request(app).post(`/api/missions/${m.id}/post`).set("x-test-user", user.id)).status).toBe(403);
  });

  it("an archivist can approve but cannot submit or post (manager-only)", async () => {
    const archivist = await createUser({ roles: ["archivist"] });
    const draft = await seedMission({ workflowState: "draft" });
    // submit is a fixer/admin action — an archivist must be rejected.
    expect((await request(app).post(`/api/missions/${draft.id}/submit`).set("x-test-user", archivist.id)).status).toBe(
      403,
    );
    const approved = await seedMission({ workflowState: "approved" });
    // post is a fixer/admin action — an archivist must be rejected.
    expect((await request(app).post(`/api/missions/${approved.id}/post`).set("x-test-user", archivist.id)).status).toBe(
      403,
    );
  });

  it("rejects out-of-order transitions with 409 (cannot approve a draft)", async () => {
    const admin = await createUser({ roles: ["admin"] });
    const m = await seedMission({ workflowState: "draft" });
    const approved = await request(app).post(`/api/missions/${m.id}/approve`).set("x-test-user", admin.id);
    expect(approved.status).toBe(409);
    // And cannot post something that isn't approved.
    const posted = await request(app).post(`/api/missions/${m.id}/post`).set("x-test-user", admin.id);
    expect(posted.status).toBe(409);
  });

  it("posting an approved mission opens it and (Live) syncs a Discord event", async () => {
    await setLiveMode(true);
    const admin = await createUser({ roles: ["admin"] });
    const m = await seedMission({ workflowState: "approved", status: "open", startAt: new Date(Date.now() + 86_400_000) });
    const posted = await request(app).post(`/api/missions/${m.id}/post`).set("x-test-user", admin.id);
    expect(posted.status).toBe(200);
    expect(posted.body.workflowState).toBe("posted");
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(posted.body.discordEventId).toBe("evt-1");
  });
});

// ===========================================================================
// VISIBILITY — the draft pipeline is staff-internal; players only ever see
// posted missions in both the list and the detail endpoints.
// ===========================================================================
describe("Mission visibility for non-managers", () => {
  it("the public list shows only posted missions to a plain user", async () => {
    const user = await createUser();
    await seedMission({ title: "Hidden Draft", workflowState: "draft", status: "open" });
    await seedMission({ title: "Hidden Proposal", workflowState: "proposal", status: "open" });
    const live = await seedMission({ title: "Live One", workflowState: "posted", status: "open" });

    const res = await request(app).get("/api/missions").set("x-test-user", user.id);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).toContain(live.id);
    const titles = (res.body as Array<{ title: string }>).map((m) => m.title);
    expect(titles).not.toContain("Hidden Draft");
    expect(titles).not.toContain("Hidden Proposal");
  });

  it("a manager's owned board shows missions across every workflow state", async () => {
    const admin = await createUser({ roles: ["admin"] });
    await seedMission({ title: "D", workflowState: "draft" });
    await seedMission({ title: "P", workflowState: "proposal" });
    await seedMission({ title: "Posted", workflowState: "posted" });
    const res = await request(app).get("/api/missions/owned").set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBe(3);
  });

  it("a plain user gets 404 on a draft detail but 200 on a posted detail", async () => {
    const user = await createUser();
    const draft = await seedMission({ workflowState: "draft" });
    const posted = await seedMission({ workflowState: "posted" });
    expect((await request(app).get(`/api/missions/${draft.id}`).set("x-test-user", user.id)).status).toBe(404);
    expect((await request(app).get(`/api/missions/${posted.id}`).set("x-test-user", user.id)).status).toBe(200);
  });

  it("hides the staff-only worldLink from players but shows it to managers", async () => {
    const user = await createUser();
    const admin = await createUser({ roles: ["admin"] });
    const m = await seedMission({ workflowState: "posted", worldLink: "https://example.com/world" });
    const asPlayer = await request(app).get(`/api/missions/${m.id}`).set("x-test-user", user.id);
    expect(asPlayer.body.worldLink).toBeNull();
    const asAdmin = await request(app).get(`/api/missions/${m.id}`).set("x-test-user", admin.id);
    expect(asAdmin.body.worldLink).toBe("https://example.com/world");
  });
});

// ===========================================================================
// APPLICATIONS — players apply with their OWN character; dedupe per character;
// fixers accept (which assigns) or reject.
// ===========================================================================
describe("Mission applications", () => {
  async function postedMission() {
    return seedMission({ workflowState: "posted", status: "open" });
  }

  it("a player applies with their own character and the fixer sees it", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const admin = await createUser({ roles: ["admin"] });
    const m = await postedMission();

    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id, comment: "I'm in" });
    expect(applied.status).toBe(200);
    // The applicant sees their own application echoed back.
    expect(applied.body.myApplication?.characterId).toBe(char.id);

    const asAdmin = await request(app).get(`/api/missions/${m.id}`).set("x-test-user", admin.id);
    expect(asAdmin.body.applications).toHaveLength(1);
    expect(asAdmin.body.applications[0].comment).toBe("I'm in");
  });

  it("rejects applying with a character the player does not own (403)", async () => {
    const player = await createUser();
    const other = await createUser();
    const notMine = await createCharacter({ ownerId: other.id });
    const m = await postedMission();
    const res = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: notMine.id });
    expect(res.status).toBe(403);
  });

  it("cannot apply to a non-posted (draft) mission (409)", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await seedMission({ workflowState: "draft" });
    const res = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id });
    expect(res.status).toBe(409);
  });

  it("re-applying with the same character dedupes to a single application", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await postedMission();
    await request(app).post(`/api/missions/${m.id}/applications`).set("x-test-user", player.id).send({ characterId: char.id, comment: "first" });
    await request(app).post(`/api/missions/${m.id}/applications`).set("x-test-user", player.id).send({ characterId: char.id, comment: "second" });

    const rows = await db.select().from(missionApplications).where(eq(missionApplications.missionId, m.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].comment).toBe("second");
    expect(rows[0].status).toBe("pending");
  });

  it("accepting an application assigns the player+character to the mission", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const admin = await createUser({ roles: ["admin"] });
    const m = await postedMission();
    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id });
    const appId = applied.body.myApplication.id as number;

    const reviewed = await request(app)
      .post(`/api/missions/${m.id}/applications/${appId}/review`)
      .set("x-test-user", admin.id)
      .send({ action: "accept" });
    expect(reviewed.status).toBe(200);

    const assigns = await db.select().from(missionAssignments).where(eq(missionAssignments.missionId, m.id));
    expect(assigns).toHaveLength(1);
    expect(assigns[0].userId).toBe(player.id);
    expect(assigns[0].characterId).toBe(char.id);
    const [appAfter] = await db.select().from(missionApplications).where(eq(missionApplications.id, appId));
    expect(appAfter.status).toBe("accepted");
  });

  it("rejecting an application does NOT create an assignment", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const admin = await createUser({ roles: ["admin"] });
    const m = await postedMission();
    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id });
    const appId = applied.body.myApplication.id as number;
    await request(app).post(`/api/missions/${m.id}/applications/${appId}/review`).set("x-test-user", admin.id).send({ action: "reject" });

    const assigns = await db.select().from(missionAssignments).where(eq(missionAssignments.missionId, m.id));
    expect(assigns).toHaveLength(0);
  });

  it("a player can withdraw their own application", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await postedMission();
    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id });
    const appId = applied.body.myApplication.id as number;
    const res = await request(app).delete(`/api/missions/${m.id}/applications/${appId}`).set("x-test-user", player.id);
    expect(res.status).toBe(200);
    const [appAfter] = await db.select().from(missionApplications).where(eq(missionApplications.id, appId));
    expect(appAfter.status).toBe("withdrawn");
  });

  it("a player cannot review applications (manager only)", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const other = await createUser();
    const m = await postedMission();
    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id });
    const appId = applied.body.myApplication.id as number;
    const res = await request(app)
      .post(`/api/missions/${m.id}/applications/${appId}/review`)
      .set("x-test-user", other.id)
      .send({ action: "accept" });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// RECENCY WARNING — non-blocking flag when an applicant's character played a
// mission within the last 21 days.
// ===========================================================================
describe("Application recency warning", () => {
  it("flags a character that recently attended a mission", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const admin = await createUser({ roles: ["admin"] });

    // A previous mission this character attended just 3 days ago.
    const past = await seedMission({ status: "completed_players_paid" });
    await seedAssignment(past.id, player.id, {
      characterId: char.id,
      attendanceCreditedAt: new Date(Date.now() - 3 * 86_400_000),
    });

    const m = await seedMission({ workflowState: "posted", status: "open" });
    await request(app).post(`/api/missions/${m.id}/applications`).set("x-test-user", player.id).send({ characterId: char.id });

    const asAdmin = await request(app).get(`/api/missions/${m.id}`).set("x-test-user", admin.id);
    const appView = asAdmin.body.applications[0];
    expect(appView.recencyWarning).toBe(true);
    expect(appView.daysSinceLastMission).toBe(3);
    expect(appView.attendanceCount).toBe(1);
  });

  it("does NOT flag a character whose last mission was long ago", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const admin = await createUser({ roles: ["admin"] });

    const past = await seedMission({ status: "completed_players_paid" });
    await seedAssignment(past.id, player.id, {
      characterId: char.id,
      attendanceCreditedAt: new Date(Date.now() - 60 * 86_400_000),
    });

    const m = await seedMission({ workflowState: "posted", status: "open" });
    await request(app).post(`/api/missions/${m.id}/applications`).set("x-test-user", player.id).send({ characterId: char.id });

    const asAdmin = await request(app).get(`/api/missions/${m.id}`).set("x-test-user", admin.id);
    expect(asAdmin.body.applications[0].recencyWarning).toBe(false);
  });

  it("does NOT flag a first-time applicant (no prior attendance)", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const admin = await createUser({ roles: ["admin"] });
    const m = await seedMission({ workflowState: "posted", status: "open" });
    await request(app).post(`/api/missions/${m.id}/applications`).set("x-test-user", player.id).send({ characterId: char.id });
    const asAdmin = await request(app).get(`/api/missions/${m.id}`).set("x-test-user", admin.id);
    expect(asAdmin.body.applications[0].recencyWarning).toBe(false);
    expect(asAdmin.body.applications[0].daysSinceLastMission).toBeNull();
  });
});

// ===========================================================================
// PRE-MISSION NPC ANNOUNCEMENT — fires ~1h before start, once, only for
// posted non-cancelled missions; gated by the Test/Live toggle.
// ===========================================================================
describe("runMissionNpcAnnouncements", () => {
  it("Test mode: marks announced but posts NOTHING to Discord", async () => {
    const m = await seedMission({
      workflowState: "posted",
      status: "open",
      startAt: new Date(Date.now() + 30 * 60_000), // 30 min out → within the 1h window
    });
    const r = await runMissionNpcAnnouncements();
    expect(r.announced).toBe(1);
    expect(mockPost).not.toHaveBeenCalled();
    const [after] = await db.select().from(missions).where(eq(missions.id, m.id));
    expect(after.npcAnnouncedAt).not.toBeNull();
  });

  it("Live mode: posts the announcement to the configured channel exactly once", async () => {
    await setLiveMode(true);
    const m = await seedMission({
      workflowState: "posted",
      status: "open",
      startAt: new Date(Date.now() + 30 * 60_000),
    });
    const r = await runMissionNpcAnnouncements();
    expect(r.announced).toBe(1);
    expect(mockPost).toHaveBeenCalledTimes(1);

    // Idempotent: a second pass announces nothing (npcAnnouncedAt is set).
    mockPost.mockClear();
    const second = await runMissionNpcAnnouncements();
    expect(second.announced).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
    expect(m.id).toBeGreaterThan(0);
  });

  it("skips draft, cancelled, far-future, and unscheduled missions", async () => {
    await seedMission({ workflowState: "draft", status: "open", startAt: new Date(Date.now() + 30 * 60_000) });
    await seedMission({ workflowState: "posted", status: "cancelled", startAt: new Date(Date.now() + 30 * 60_000) });
    await seedMission({ workflowState: "posted", status: "open", startAt: new Date(Date.now() + 5 * 3_600_000) }); // 5h out
    await seedMission({ workflowState: "posted", status: "open", startAt: null }); // unscheduled
    const r = await runMissionNpcAnnouncements();
    expect(r.announced).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
  });
});
