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
  setMissionCompleted,
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

// Narrow payMissionActors' union result (it may return null or a completion
// "blocked" sentinel) to the success payload for assertions.
function actorPay(r: Awaited<ReturnType<typeof payMissionActors>>) {
  if (!r || "blocked" in r) throw new Error(`expected actor-pay result, got ${JSON.stringify(r)}`);
  return r;
}

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
      // Real missions always have a Job Type; the submit gate now requires one,
      // so default to a valid value unless a test overrides it.
      jobType: opts.jobType ?? "combat",
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

    const result = actorPay(await payMissionActors(m.id, [actor.id], 50, {}));
    expect(result.live).toBe(false);
    expect(result.simulated).toBe(1);
    expect(result.paid).toBe(0);
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

    const first = actorPay(await payMissionActors(m.id, [actor.id], 50, {}));
    const second = actorPay(await payMissionActors(m.id, [actor.id], 50, {}));
    expect(first.paid).toBe(1);
    expect(second.paid).toBe(0);
    expect(second.skipped).toBe(1);
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

    const [r1, r2] = (
      await Promise.all([
        payMissionActors(m.id, [actor.id], 50, {}),
        payMissionActors(m.id, [actor.id], 50, {}),
      ])
    ).map(actorPay);
    expect(r1.paid + r2.paid).toBe(1);
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
// MISSION COMPLETION — the read-only lock that blocks actor payments.
// ===========================================================================
describe("Mission completion lock", () => {
  it("the owning fixer can mark their mission completed", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const m = await seedMission({ fixerId: fixer.id });

    const res = await request(app).post(`/api/missions/${m.id}/complete`).set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    expect(res.body.completedAt).not.toBeNull();
    expect(res.body.completedBy).toBe(fixer.id);

    const [after] = await db.select().from(missions).where(eq(missions.id, m.id));
    expect(after.completedAt).not.toBeNull();
    expect(after.completedBy).toBe(fixer.id);
  });

  it("a fixer who does not own the mission cannot mark it completed", async () => {
    const owner = await createUser({ roles: ["fixer"] });
    const other = await createUser({ roles: ["fixer"] });
    const m = await seedMission({ fixerId: owner.id });

    const res = await request(app).post(`/api/missions/${m.id}/complete`).set("x-test-user", other.id);
    expect(res.status).toBe(403);

    const [after] = await db.select().from(missions).where(eq(missions.id, m.id));
    expect(after.completedAt).toBeNull();
  });

  it("an archivist can complete and reopen any mission", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const archivist = await createUser({ roles: ["archivist"] });
    const m = await seedMission({ fixerId: fixer.id });

    const completed = await request(app).post(`/api/missions/${m.id}/complete`).set("x-test-user", archivist.id);
    expect(completed.status).toBe(200);
    expect(completed.body.completedAt).not.toBeNull();

    const reopened = await request(app).post(`/api/missions/${m.id}/uncomplete`).set("x-test-user", archivist.id);
    expect(reopened.status).toBe(200);
    expect(reopened.body.completedAt).toBeNull();

    const [after] = await db.select().from(missions).where(eq(missions.id, m.id));
    expect(after.completedAt).toBeNull();
  });

  it("the owning fixer cannot reopen a completed mission", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const m = await seedMission({ fixerId: fixer.id });
    await request(app).post(`/api/missions/${m.id}/complete`).set("x-test-user", fixer.id);

    const res = await request(app).post(`/api/missions/${m.id}/uncomplete`).set("x-test-user", fixer.id);
    expect(res.status).toBe(403);

    const [after] = await db.select().from(missions).where(eq(missions.id, m.id));
    expect(after.completedAt).not.toBeNull();
  });

  it("an admin can reopen a completed mission", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const admin = await createUser({ roles: ["admin"] });
    const m = await seedMission({ fixerId: fixer.id });
    await request(app).post(`/api/missions/${m.id}/complete`).set("x-test-user", fixer.id);

    const res = await request(app).post(`/api/missions/${m.id}/uncomplete`).set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    expect(res.body.completedAt).toBeNull();
  });

  it("an admin can mark a mission completed", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const admin = await createUser({ roles: ["admin"] });
    const m = await seedMission({ fixerId: fixer.id });

    const res = await request(app).post(`/api/missions/${m.id}/complete`).set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    expect(res.body.completedAt).not.toBeNull();
    expect(res.body.completedBy).toBe(admin.id);
  });

  it("completing an already-completed mission is an idempotent no-op", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const m = await seedMission({ fixerId: fixer.id });

    const first = await request(app).post(`/api/missions/${m.id}/complete`).set("x-test-user", fixer.id);
    expect(first.status).toBe(200);
    const firstCompletedAt = first.body.completedAt;

    const second = await request(app).post(`/api/missions/${m.id}/complete`).set("x-test-user", fixer.id);
    expect(second.status).toBe(200);
    // The timestamp is not rewritten on a repeat complete.
    expect(second.body.completedAt).toBe(firstCompletedAt);
    expect(second.body.completedBy).toBe(fixer.id);
  });

  it("reopening an already-open mission is an idempotent no-op", async () => {
    const admin = await createUser({ roles: ["admin"] });
    const m = await seedMission({ fixerId: admin.id });

    const res = await request(app).post(`/api/missions/${m.id}/uncomplete`).set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    expect(res.body.completedAt).toBeNull();
  });

  it("a completion racing a payout never produces an orphaned or duplicate credit", async () => {
    // Safety invariant under concurrency: the number of real UB credits must
    // always equal the number of 'paid' rows, and at most one 'paid' row can
    // exist per (mission, actor). This holds regardless of which op wins the
    // race, proving the atomic INSERT...SELECT guard leaves no inconsistency.
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(50));
    const admin = await createUser({ roles: ["admin"] });
    const actor = await createUser();
    const m = await seedMission({ fixerId: admin.id });

    await Promise.all([
      payMissionActors(m.id, [actor.id], 50, { actorId: admin.id }),
      setMissionCompleted(m.id, true, { id: admin.id, isManager: true, isAdmin: true, isArchivist: true }),
    ]);

    const paidRows = await db
      .select()
      .from(missionActorPayments)
      .where(eq(missionActorPayments.paymentStatus, "paid"));
    expect(paidRows.length).toBeLessThanOrEqual(1);
    expect(mockPatch.mock.calls.length).toBe(paidRows.length);
  });

  it("paying actors on a completed mission is blocked (409) and credits no money", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(50));
    const admin = await createUser({ roles: ["admin"] });
    const actor = await createUser();
    const m = await seedMission({ fixerId: admin.id });
    await request(app).post(`/api/missions/${m.id}/complete`).set("x-test-user", admin.id);

    const res = await request(app)
      .post(`/api/missions/${m.id}/pay-actors`)
      .set("x-test-user", admin.id)
      .send({ userIds: [actor.id], amount: 50 });
    expect(res.status).toBe(409);
    expect(mockPatch).not.toHaveBeenCalled();
    const rows = await db.select().from(missionActorPayments).where(eq(missionActorPayments.missionId, m.id));
    expect(rows).toHaveLength(0);

    // Reopening the mission unlocks actor payments again.
    await request(app).post(`/api/missions/${m.id}/uncomplete`).set("x-test-user", admin.id);
    const ok = await request(app)
      .post(`/api/missions/${m.id}/pay-actors`)
      .set("x-test-user", admin.id)
      .send({ userIds: [actor.id], amount: 50 });
    expect(ok.status).toBe(200);
    expect(mockPatch).toHaveBeenCalledTimes(1);
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

// Only POSTED missions own a Discord event, so drive a fresh draft all the way
// through the workflow (draft → proposal → approved → posted). The Discord sync
// fires on the final /post. Returns the /post response (full MissionDetail).
async function createPostedMission(
  managerId: string,
  body: Record<string, unknown> = {},
) {
  const created = await request(app)
    .post("/api/missions")
    .set("x-test-user", managerId)
    .send({ title: "Heist", tier: 2, jobType: "combat", ...body });
  const id = created.body.id;
  await request(app).post(`/api/missions/${id}/submit`).set("x-test-user", managerId);
  await request(app).post(`/api/missions/${id}/approve`).set("x-test-user", managerId);
  return request(app).post(`/api/missions/${id}/post`).set("x-test-user", managerId);
}

describe("Discord scheduled-event sync", () => {
  it("creates an event and persists its id when a scheduled mission is posted Live", async () => {
    await setLiveMode(true);
    const manager = await createUser({ roles: ["admin"] });
    const res = await createPostedMission(manager.id, { startAt: futureIso() });
    expect(res.status).toBe(200);
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(res.body.discordEventId).toBe("evt-1");
    expect(res.body.discordSyncError).toBeNull();
  });

  it("does NOT create an event for a posted Live mission with no start date", async () => {
    await setLiveMode(true);
    const manager = await createUser({ roles: ["admin"] });
    const res = await createPostedMission(manager.id, { title: "Open Run", tier: 1 });
    expect(res.status).toBe(200);
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(res.body.discordEventId).toBeNull();
  });

  it("does NOT touch Discord while a scheduled mission is still a draft", async () => {
    await setLiveMode(true);
    const manager = await createUser({ roles: ["admin"] });
    const res = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Heist", tier: 2, jobType: "combat", startAt: futureIso() });
    expect(res.status).toBe(201);
    expect(res.body.workflowState).toBe("draft");
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(res.body.discordEventId).toBeNull();
  });

  it("records the sync error and leaves the event id null when posting fails", async () => {
    await setLiveMode(true);
    mockCreateEvent.mockResolvedValue({ ok: false, error: "rate limited" });
    const manager = await createUser({ roles: ["admin"] });
    const res = await createPostedMission(manager.id, { title: "Doomed", tier: 1, startAt: futureIso() });
    expect(res.status).toBe(200);
    expect(res.body.discordEventId).toBeNull();
    expect(res.body.discordSyncError).toBe("rate limited");
    const [row] = await db.select().from(missions).where(eq(missions.id, res.body.id));
    expect(row.discordSyncError).toBe("rate limited");
  });

  it("modifies the existing event when a scheduled Live mission is edited", async () => {
    await setLiveMode(true);
    const manager = await createUser({ roles: ["admin"] });
    const created = await createPostedMission(manager.id, { startAt: futureIso() });
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
    const created = await createPostedMission(manager.id, { startAt: futureIso() });
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

describe("GET /missions/actor-search", () => {
  it("forbids a plain user (manager role required)", async () => {
    const user = await createUser();
    const res = await request(app).get("/api/missions/actor-search?q=x").set("x-test-user", user.id);
    expect(res.status).toBe(403);
  });

  // Guards against Express route shadowing: this literal path must be matched
  // before "/missions/:id", otherwise a fixer gets a 404 (id="actor-search").
  it("returns users matching the query for a fixer (not shadowed by /:id)", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const target = await createUser({ username: "SearchTarget" });
    const res = await request(app).get("/api/missions/actor-search?q=SearchTarget").set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((u: { id: string }) => u.id === target.id)).toBe(true);
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

  it("cannot apply to a posted mission that is no longer Open (409)", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await seedMission({ workflowState: "posted", status: "completed" });
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

  it("a different fixer cannot see or review another fixer's applications", async () => {
    const fixerA = await createUser({ roles: ["fixer"] });
    const fixerB = await createUser({ roles: ["fixer"] });
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await seedMission({ workflowState: "posted", status: "open", fixerId: fixerA.id });
    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id });
    const appId = applied.body.myApplication.id as number;

    // fixerB is a manager but NOT this mission's fixer → no applicant pool and
    // no ability to act on it.
    const asB = await request(app).get(`/api/missions/${m.id}`).set("x-test-user", fixerB.id);
    expect(asB.body.applications).toHaveLength(0);
    const reviewB = await request(app)
      .post(`/api/missions/${m.id}/applications/${appId}/review`)
      .set("x-test-user", fixerB.id)
      .send({ action: "accept" });
    expect(reviewB.status).toBe(403);

    // The owning fixer sees the pool and can act on it.
    const asA = await request(app).get(`/api/missions/${m.id}`).set("x-test-user", fixerA.id);
    expect(asA.body.applications).toHaveLength(1);
    const reviewA = await request(app)
      .post(`/api/missions/${m.id}/applications/${appId}/review`)
      .set("x-test-user", fixerA.id)
      .send({ action: "accept" });
    expect(reviewA.status).toBe(200);
  });

  it("rejects review/withdraw when the application belongs to a different mission (404)", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const admin = await createUser({ roles: ["admin"] });
    const m1 = await postedMission();
    const m2 = await postedMission();
    const applied = await request(app)
      .post(`/api/missions/${m1.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id });
    const appId = applied.body.myApplication.id as number;

    // Pairing m2's id with m1's application must not mutate the record.
    const reviewMismatch = await request(app)
      .post(`/api/missions/${m2.id}/applications/${appId}/review`)
      .set("x-test-user", admin.id)
      .send({ action: "accept" });
    expect(reviewMismatch.status).toBe(404);
    const withdrawMismatch = await request(app)
      .delete(`/api/missions/${m2.id}/applications/${appId}`)
      .set("x-test-user", player.id);
    expect(withdrawMismatch.status).toBe(404);

    const [appAfter] = await db
      .select()
      .from(missionApplications)
      .where(eq(missionApplications.id, appId));
    expect(appAfter.status).toBe("pending");
  });

  it("my-application-outcomes returns reviewed (accepted/rejected) apps, newest first, and excludes pending/withdrawn", async () => {
    const player = await createUser();
    const admin = await createUser({ roles: ["admin"] });
    const charA = await createCharacter({ ownerId: player.id });
    const charB = await createCharacter({ ownerId: player.id });
    const charC = await createCharacter({ ownerId: player.id });
    const charD = await createCharacter({ ownerId: player.id });
    const accepted = await postedMission();
    const rejected = await postedMission();
    const pending = await postedMission();
    const withdrawn = await postedMission();

    async function apply(mId: number, charId: number) {
      const r = await request(app)
        .post(`/api/missions/${mId}/applications`)
        .set("x-test-user", player.id)
        .send({ characterId: charId });
      return r.body.myApplication.id as number;
    }

    const acceptedAppId = await apply(accepted.id, charA.id);
    await request(app)
      .post(`/api/missions/${accepted.id}/applications/${acceptedAppId}/review`)
      .set("x-test-user", admin.id)
      .send({ action: "accept" });
    const rejectedAppId = await apply(rejected.id, charB.id);
    await request(app)
      .post(`/api/missions/${rejected.id}/applications/${rejectedAppId}/review`)
      .set("x-test-user", admin.id)
      .send({ action: "reject" });
    await apply(pending.id, charC.id); // left pending
    const withdrawnAppId = await apply(withdrawn.id, charD.id);
    await request(app)
      .delete(`/api/missions/${withdrawn.id}/applications/${withdrawnAppId}`)
      .set("x-test-user", player.id);

    const res = await request(app)
      .get("/api/missions/my-application-outcomes")
      .set("x-test-user", player.id);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ missionId: number; status: string }>).map((o) => o.missionId);
    expect(ids).toContain(accepted.id);
    expect(ids).toContain(rejected.id);
    expect(ids).not.toContain(pending.id);
    expect(ids).not.toContain(withdrawn.id);
    // Newest reviewed first (rejected was reviewed after accepted).
    expect(res.body[0].missionId).toBe(rejected.id);
    expect(res.body.find((o: { missionId: number }) => o.missionId === accepted.id).status).toBe("accepted");
  });

  it("my-application-outcomes only returns the caller's own outcomes", async () => {
    const player = await createUser();
    const other = await createUser();
    const admin = await createUser({ roles: ["admin"] });
    const char = await createCharacter({ ownerId: other.id });
    const m = await postedMission();
    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", other.id)
      .send({ characterId: char.id });
    const appId = applied.body.myApplication.id as number;
    await request(app)
      .post(`/api/missions/${m.id}/applications/${appId}/review`)
      .set("x-test-user", admin.id)
      .send({ action: "accept" });

    const res = await request(app)
      .get("/api/missions/my-application-outcomes")
      .set("x-test-user", player.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("an accepted/rejected application stays visible to the player after the mission closes", async () => {
    const player = await createUser();
    const admin = await createUser({ roles: ["admin"] });
    const char = await createCharacter({ ownerId: player.id });
    const m = await postedMission();
    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id });
    const appId = applied.body.myApplication.id as number;
    await request(app)
      .post(`/api/missions/${m.id}/applications/${appId}/review`)
      .set("x-test-user", admin.id)
      .send({ action: "reject" });
    // Mission moves out of the Open state.
    await db.update(missions).set({ status: "completed" }).where(eq(missions.id, m.id));

    // The mission detail still echoes the player's reviewed application (the
    // workflow state stays "posted", so the player can still load it).
    const detail = await request(app).get(`/api/missions/${m.id}`).set("x-test-user", player.id);
    expect(detail.status).toBe(200);
    expect(detail.body.myApplication?.status).toBe("rejected");
  });

  it("a player's My Missions excludes non-posted missions they are assigned to", async () => {
    const player = await createUser();
    const draft = await seedMission({ workflowState: "draft", status: "open" });
    const posted = await seedMission({ workflowState: "posted", status: "open" });
    await seedAssignment(draft.id, player.id);
    await seedAssignment(posted.id, player.id);

    const res = await request(app).get("/api/missions/mine").set("x-test-user", player.id);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((x) => x.id);
    expect(ids).toContain(posted.id);
    expect(ids).not.toContain(draft.id);
  });

  it("a manager's My Missions still includes non-posted missions they are assigned to", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const draft = await seedMission({ workflowState: "draft", status: "open" });
    await seedAssignment(draft.id, fixer.id);
    const res = await request(app).get("/api/missions/mine").set("x-test-user", fixer.id);
    const ids = (res.body as Array<{ id: number }>).map((x) => x.id);
    expect(ids).toContain(draft.id);
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

// ===========================================================================
// MISSION LISTING TABS — created / history / my-applications endpoints that
// back the role-aware Missions page.
// ===========================================================================
describe("Mission listing tabs", () => {
  it("created: a fixer sees ONLY missions they personally run", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const other = await createUser({ roles: ["fixer"] });
    const mine = await seedMission({ title: "Mine", fixerId: fixer.id, workflowState: "draft" });
    await seedMission({ title: "Theirs", fixerId: other.id, workflowState: "draft" });

    const res = await request(app).get("/api/missions/created").set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).toEqual([mine.id]);
  });

  it("created: a plain player is forbidden", async () => {
    const player = await createUser();
    const res = await request(app).get("/api/missions/created").set("x-test-user", player.id);
    expect(res.status).toBe(403);
  });

  it("history: a player sees terminal missions they attended, not active ones", async () => {
    const player = await createUser();
    const done = await seedMission({ title: "Done", workflowState: "posted", status: "completed_paid" });
    const active = await seedMission({ title: "Active", workflowState: "posted", status: "open" });
    await seedAssignment(done.id, player.id);
    await seedAssignment(active.id, player.id);

    const res = await request(app).get("/api/missions/history").set("x-test-user", player.id);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).toContain(done.id);
    expect(ids).not.toContain(active.id);
  });

  it("history: a non-manager never sees non-posted missions", async () => {
    const player = await createUser();
    const hiddenDraft = await seedMission({ title: "Draft", workflowState: "draft", status: "cancelled" });
    await seedAssignment(hiddenDraft.id, player.id);
    const res = await request(app).get("/api/missions/history").set("x-test-user", player.id);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).not.toContain(hiddenDraft.id);
  });

  it("history: a manager also sees terminal missions they ran", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const ran = await seedMission({ title: "Ran", fixerId: fixer.id, workflowState: "posted", status: "cancelled" });
    const res = await request(app).get("/api/missions/history").set("x-test-user", fixer.id);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).toContain(ran.id);
  });

  it("my-applications: returns the caller's own applications across all states", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await seedMission({ title: "Recruiting", workflowState: "posted", status: "open" });
    await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id, comment: "pick me" });

    const res = await request(app).get("/api/missions/my-applications").set("x-test-user", player.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].missionTitle).toBe("Recruiting");
    expect(res.body[0].status).toBe("pending");
    expect(res.body[0].comment).toBe("pick me");
    expect(res.body[0].characterId).toBe(char.id);
  });

  it("my-applications: never leaks another player's applications", async () => {
    const player = await createUser();
    const intruder = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await seedMission({ workflowState: "posted", status: "open" });
    await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id });

    const res = await request(app).get("/api/missions/my-applications").set("x-test-user", intruder.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});
