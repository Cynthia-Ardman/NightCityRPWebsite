import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
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
    sendDirectMessage: vi.fn(async () => "dm-id"),
  };
});

import {
  db,
  missions,
  missionAssignments,
  missionActorPayments,
  missionApplications,
  missionNpcSignups,
  customRequests,
  botConfig,
} from "@workspace/db";
import { patchBalance } from "../lib/unbelievaboat";
import {
  postToChannel,
  createGuildScheduledEvent,
  modifyGuildScheduledEvent,
  deleteGuildScheduledEvent,
  sendDirectMessage,
} from "../lib/discord";
import {
  payMissionPlayers,
  payMissionActors,
  setMissionCompleted,
  runMissionAutoPay,
  runMissionNpcAnnouncements,
  signUpAsNpc,
  confirmNpcSignup,
  listActingForUser,
} from "../lib/missionsService";
import { MISSION_CONFIG_KEYS } from "../lib/missionsConfig";
import { LIVE_MODE_KEYS } from "../lib/liveMode";
import { isAutobillEnabled, AUTOBILL_FLAGS } from "../lib/jobs";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockPatch = vi.mocked(patchBalance);
const mockPost = vi.mocked(postToChannel);
const mockDM = vi.mocked(sendDirectMessage);
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
      // createdAt normally defaults to now(); allow tests to pin it so we can
      // force startAt/createdAt ties and exercise the id-descending tiebreaker.
      ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
      ...(opts.npcPayAmount !== undefined ? { npcPayAmount: opts.npcPayAmount } : {}),
      ...(opts.discordThreadId !== undefined ? { discordThreadId: opts.discordThreadId } : {}),
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

  it("never pays actors on a cancelled mission", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(50));
    const actor = await createUser();
    // Cancelling sets status='cancelled' but NOT completedAt, so the
    // completion lock alone would miss it — the status guard must catch it.
    const m = await seedMission({ status: "cancelled" });

    const result = await payMissionActors(m.id, [actor.id], 50, {});
    expect(result).toEqual({ blocked: "cancelled" });
    expect(mockPatch).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(missionActorPayments)
      .where(eq(missionActorPayments.missionId, m.id));
    expect(rows).toHaveLength(0);
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
      setMissionCompleted(m.id, true, { id: admin.id, isManager: true, isAdmin: true, isArchivist: true, isTrialAuthor: false }),
    ]);

    const paidRows = await db
      .select()
      .from(missionActorPayments)
      .where(eq(missionActorPayments.paymentStatus, "paid"));
    expect(paidRows.length).toBeLessThanOrEqual(1);
    expect(mockPatch.mock.calls.length).toBe(paidRows.length);
  });

  it("paying actors on a completed mission now SUCCEEDS (lock removed in #185)", async () => {
    // #185 removed the completion lock on actor payments: a fixer may pay actors
    // at any point in a mission's lifecycle (a session can run long after the
    // mission is marked completed). Only cancelled missions refuse.
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
    expect(res.status).toBe(200);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(missionActorPayments).where(eq(missionActorPayments.missionId, m.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].paymentStatus).toBe("paid");
  });

  it("paying actors on a CANCELLED mission is blocked (409) and credits no money", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(50));
    const admin = await createUser({ roles: ["admin"] });
    const actor = await createUser();
    const m = await seedMission({ fixerId: admin.id, status: "cancelled" });

    const res = await request(app)
      .post(`/api/missions/${m.id}/pay-actors`)
      .set("x-test-user", admin.id)
      .send({ userIds: [actor.id], amount: 50 });
    expect(res.status).toBe(409);
    expect(mockPatch).not.toHaveBeenCalled();
    const rows = await db.select().from(missionActorPayments).where(eq(missionActorPayments.missionId, m.id));
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
// NPC SIGN-UPS (Task #185) — players sign up, fixers confirm + pay.
// ===========================================================================
describe("NPC sign-ups", () => {
  it("a player can sign up, see mySignup, and withdraw", async () => {
    const player = await createUser();
    const m = await seedMission({ status: "open", workflowState: "posted", npcPayAmount: 75 });

    const signUp = await request(app)
      .post(`/api/missions/${m.id}/npc-signups`)
      .set("x-test-user", player.id)
      .send({});
    expect(signUp.status).toBe(200);
    expect(signUp.body.mySignup).not.toBeNull();
    expect(signUp.body.mySignup.state).toBe("signed_up");
    // Players never see the full roster.
    expect(signUp.body.npcSignups).toEqual([]);

    const withdraw = await request(app)
      .delete(`/api/missions/${m.id}/npc-signups/me`)
      .set("x-test-user", player.id);
    expect(withdraw.status).toBe(200);
    expect(withdraw.body.mySignup).toBeNull();
  });

  it("signing up twice is idempotent (one active row)", async () => {
    const player = await createUser();
    const m = await seedMission({ status: "open", workflowState: "posted" });
    await signUpAsNpc({ missionId: m.id, userId: player.id });
    await signUpAsNpc({ missionId: m.id, userId: player.id });
    const rows = await db
      .select()
      .from(missionNpcSignups)
      .where(eq(missionNpcSignups.missionId, m.id));
    expect(rows).toHaveLength(1);
  });

  it("a fixer confirming attended pays the player npcPayAmount exactly once", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(75));
    const admin = await createUser({ roles: ["admin"] });
    const player = await createUser();
    const m = await seedMission({ fixerId: admin.id, status: "open", workflowState: "posted", npcPayAmount: 75 });
    await signUpAsNpc({ missionId: m.id, userId: player.id });
    const [signup] = await db
      .select()
      .from(missionNpcSignups)
      .where(eq(missionNpcSignups.missionId, m.id));

    const r1 = await confirmNpcSignup({
      missionId: m.id,
      signupId: signup.id,
      action: "attended",
      viewer: { id: admin.id, isManager: true, isAdmin: true, isArchivist: false, isTrialAuthor: false },
    });
    expect(r1.ok).toBe(true);
    // Idempotent: confirming again does NOT pay twice.
    const r2 = await confirmNpcSignup({
      missionId: m.id,
      signupId: signup.id,
      action: "attended",
      viewer: { id: admin.id, isManager: true, isAdmin: true, isArchivist: false, isTrialAuthor: false },
    });
    expect(r2.ok).toBe(true);
    expect(mockPatch).toHaveBeenCalledTimes(1);

    const payments = await db
      .select()
      .from(missionActorPayments)
      .where(eq(missionActorPayments.missionId, m.id));
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(75);
    expect(payments[0].paymentStatus).toBe("paid");

    const [row] = await db
      .select()
      .from(missionNpcSignups)
      .where(eq(missionNpcSignups.id, signup.id));
    expect(row.state).toBe("attended");
    expect(row.paymentStatus).toBe("paid");
  });

  it("no_show resolves the sign-up with no payout", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(0));
    const admin = await createUser({ roles: ["admin"] });
    const player = await createUser();
    const m = await seedMission({ fixerId: admin.id, status: "open", workflowState: "posted", npcPayAmount: 75 });
    await signUpAsNpc({ missionId: m.id, userId: player.id });
    const [signup] = await db
      .select()
      .from(missionNpcSignups)
      .where(eq(missionNpcSignups.missionId, m.id));

    const r = await confirmNpcSignup({
      missionId: m.id,
      signupId: signup.id,
      action: "no_show",
      viewer: { id: admin.id, isManager: true, isAdmin: true, isArchivist: false, isTrialAuthor: false },
    });
    expect(r.ok).toBe(true);
    expect(mockPatch).not.toHaveBeenCalled();
    const payments = await db
      .select()
      .from(missionActorPayments)
      .where(eq(missionActorPayments.missionId, m.id));
    expect(payments).toHaveLength(0);
    const [row] = await db
      .select()
      .from(missionNpcSignups)
      .where(eq(missionNpcSignups.id, signup.id));
    expect(row.state).toBe("no_show");
  });

  it("a confirmed NPC payout surfaces in the player's Acting history", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(75));
    const admin = await createUser({ roles: ["admin"] });
    const player = await createUser();
    const m = await seedMission({ fixerId: admin.id, status: "open", workflowState: "posted", npcPayAmount: 75 });
    await signUpAsNpc({ missionId: m.id, userId: player.id });
    const [signup] = await db
      .select()
      .from(missionNpcSignups)
      .where(eq(missionNpcSignups.missionId, m.id));
    await confirmNpcSignup({
      missionId: m.id,
      signupId: signup.id,
      action: "attended",
      viewer: { id: admin.id, isManager: true, isAdmin: true, isArchivist: false, isTrialAuthor: false },
    });

    const acting = await listActingForUser(player.id);
    expect(acting.length).toBeGreaterThanOrEqual(1);
    expect(acting.some((a) => a.amount === 75)).toBe(true);
  });

  it("confirming an NPC on a cancelled mission is refused (409) with no payout", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(75));
    const admin = await createUser({ roles: ["admin"] });
    const player = await createUser();
    const m = await seedMission({ fixerId: admin.id, status: "open", workflowState: "posted", npcPayAmount: 75 });
    await signUpAsNpc({ missionId: m.id, userId: player.id });
    const [signup] = await db
      .select()
      .from(missionNpcSignups)
      .where(eq(missionNpcSignups.missionId, m.id));
    await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, m.id));

    const r = await confirmNpcSignup({
      missionId: m.id,
      signupId: signup.id,
      action: "attended",
      viewer: { id: admin.id, isManager: true, isAdmin: true, isArchivist: false, isTrialAuthor: false },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(409);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("the per-player acting lookup is fixer/admin-gated", async () => {
    const player = await createUser();
    const other = await createUser();
    const res = await request(app)
      .get(`/api/missions/acting/${other.id}`)
      .set("x-test-user", player.id);
    expect(res.status).toBe(403);
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
// ADD-PLAYER PARITY — assigning a player's character to a mission must raise a
// pending mission_participation request (the same row whose creation triggers
// the owner DM) whether the assignment arrives at CREATE time or via a later
// EDIT. Guards against the reported "edit doesn't notify the new player" gap.
// ===========================================================================
describe("add-player participation parity (create vs edit)", () => {
  async function participationRows(missionId: number, characterId: number) {
    const rows = await db
      .select()
      .from(customRequests)
      .where(eq(customRequests.characterId, characterId));
    return rows.filter(
      (r) =>
        r.type === "mission_participation" &&
        Number((r.details as { missionId?: number } | null)?.missionId) === missionId,
    );
  }

  it("raises a participation request when the player is added at CREATE time", async () => {
    const manager = await createUser({ roles: ["admin"] });
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });

    const res = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Run", tier: 1, assignments: [{ characterId: char.id }] });
    expect(res.status).toBe(201);

    const rows = await participationRows(res.body.id, char.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].requestedById).toBe(player.id);
    expect(rows[0].status).toBe("pending");
  });

  it("raises a participation request when the player is added via a later EDIT", async () => {
    const manager = await createUser({ roles: ["admin"] });
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });

    // Create with no roster, then add the player through PATCH.
    const created = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Run", tier: 1, assignments: [] });
    expect(created.status).toBe(201);
    expect(await participationRows(created.body.id, char.id)).toHaveLength(0);

    const edit = await request(app)
      .patch(`/api/missions/${created.body.id}`)
      .set("x-test-user", manager.id)
      .send({ assignments: [{ characterId: char.id }] });
    expect(edit.status).toBe(200);

    const rows = await participationRows(created.body.id, char.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].requestedById).toBe(player.id);
    expect(rows[0].status).toBe("pending");
  });
});

// ===========================================================================
// ROSTER PARTICIPATION CONFIRMATION — the mission detail must surface, per
// assigned player, whether they've accepted the invite ("accepted"), not yet
// responded ("pending"), or have no confirmation request (null). Lets a fixer
// see at a glance who is definitely coming.
// ===========================================================================
describe("roster participationStatus on mission detail", () => {
  async function detailAssignment(missionId: number, viewerId: string, characterId: number) {
    const res = await request(app).get(`/api/missions/${missionId}`).set("x-test-user", viewerId);
    expect(res.status).toBe(200);
    const a = (res.body.assignments as Array<{ characterId: number | null; participationStatus: string | null }>).find(
      (x) => x.characterId === characterId,
    );
    if (!a) throw new Error(`assignment for character ${characterId} not found`);
    return a;
  }

  it("reports pending after assignment and accepted once the player accepts", async () => {
    const manager = await createUser({ roles: ["admin"] });
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });

    // Fixer assigns the player → raises a pending participation request.
    const created = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Run", tier: 1, assignments: [{ characterId: char.id }] });
    expect(created.status).toBe(201);
    const missionId = created.body.id as number;

    expect((await detailAssignment(missionId, manager.id, char.id)).participationStatus).toBe("pending");

    // The owning player accepts → roster flips to accepted.
    const reqRow = (
      await db.select().from(customRequests).where(eq(customRequests.characterId, char.id))
    ).find((r) => r.type === "mission_participation");
    expect(reqRow).toBeTruthy();
    const decision = await request(app)
      .post(`/api/requests/${reqRow!.id}/participation-decision`)
      .set("x-test-user", player.id)
      .send({ decision: "accept" });
    expect(decision.status).toBe(200);

    expect((await detailAssignment(missionId, manager.id, char.id)).participationStatus).toBe("accepted");
  });

  it("scopes status per mission: accepted on one mission does not leak into a pending invite on another", async () => {
    const manager = await createUser({ roles: ["admin"] });
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });

    // Mission A: assign + accept → accepted.
    const a = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "A", tier: 1, assignments: [{ characterId: char.id }] });
    expect(a.status).toBe(201);
    const reqA = (
      await db.select().from(customRequests).where(eq(customRequests.characterId, char.id))
    ).find((r) => r.type === "mission_participation" && Number((r.details as { missionId?: number }).missionId) === a.body.id);
    await request(app)
      .post(`/api/requests/${reqA!.id}/participation-decision`)
      .set("x-test-user", player.id)
      .send({ decision: "accept" });

    // Mission B: assign the same character → still pending; must NOT inherit A's accept.
    const b = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "B", tier: 1, assignments: [{ characterId: char.id }] });
    expect(b.status).toBe(201);

    expect((await detailAssignment(a.body.id, manager.id, char.id)).participationStatus).toBe("accepted");
    expect((await detailAssignment(b.body.id, manager.id, char.id)).participationStatus).toBe("pending");
  });

  it("reports null for an assignment with no participation request (fixer self-assign)", async () => {
    const manager = await createUser({ roles: ["admin"] });
    const ownChar = await createCharacter({ ownerId: manager.id });

    const created = await request(app)
      .post("/api/missions")
      .set("x-test-user", manager.id)
      .send({ title: "Solo", tier: 1, assignments: [{ characterId: ownChar.id }] });
    expect(created.status).toBe(201);

    expect((await detailAssignment(created.body.id, manager.id, ownChar.id)).participationStatus).toBeNull();
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

  it("settles player pay end-to-end: complete → cron → simulated row with the mission's payAmount", async () => {
    const admin = await createUser({ roles: ["admin"] });
    const player = await createUser();
    // Scheduled far enough back that the run window (start + duration + delay)
    // has fully elapsed by the time the cron ticks.
    const m = await seedMission({
      playerPay: 150,
      status: "open",
      startAt: new Date(Date.now() - 10 * 3_600_000),
    });
    await seedAssignment(m.id, player.id);

    // Complete through the real completion path (not a raw column write).
    const done = await setMissionCompleted(m.id, true, {
      id: admin.id,
      isManager: true,
      isAdmin: true,
      isArchivist: true,
      isTrialAuthor: false,
    });
    expect(done.ok).toBe(true);

    const processed = await runMissionAutoPay();
    expect(processed).toBe(1);

    // Test mode: the roster row settles as 'simulated' with the right amount,
    // and no real money moves.
    const [a] = await db.select().from(missionAssignments).where(eq(missionAssignments.missionId, m.id));
    expect(a.paymentStatus).toBe("simulated");
    expect(a.payAmount).toBe(150);
    expect(a.paidAt).not.toBeNull();
    expect(mockPatch).not.toHaveBeenCalled();

    const [after] = await db.select().from(missions).where(eq(missions.id, m.id));
    expect(after.autoPayProcessedAt).not.toBeNull();
    expect(after.status).toBe("completed_players_paid");

    // Idempotent: a second tick re-selects nothing.
    expect(await runMissionAutoPay()).toBe(0);
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
// through the workflow (draft → proposal → posted). Approval now PUBLISHES the
// mission to the public board in one step (no separate manual /post), so the
// Discord sync fires on /approve. Returns the /approve response (full
// MissionDetail).
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
  return request(app).post(`/api/missions/${id}/approve`).set("x-test-user", managerId);
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

  // Regression: a reschedule must be announced IN the mission's Discord thread,
  // never as a DM to each participant. (The redundant DM fan-out was removed —
  // the thread is the single source of truth for mission lifecycle updates.)
  it("reschedule posts to the mission thread and does NOT DM participants", async () => {
    const admin = await createUser({ roles: ["admin"] });
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await seedMission({
      workflowState: "posted",
      status: "open",
      startAt: new Date(Date.now() + 86_400_000),
      fixerId: admin.id,
      discordThreadId: "thread-1",
    });
    await seedAssignment(m.id, player.id, { characterId: char.id });

    // Ignore any Discord chatter from setup; only assert on the reschedule edit.
    mockPost.mockClear();
    mockDM.mockClear();

    const newStart = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const patched = await request(app)
      .patch(`/api/missions/${m.id}`)
      .set("x-test-user", admin.id)
      .send({ startAt: newStart });
    expect(patched.status).toBe(200);

    // The reschedule is announced in the thread (the message id == thread id).
    const threadCalls = mockPost.mock.calls.filter((c) => c[0] === "thread-1");
    expect(threadCalls).toHaveLength(1);
    expect(String(threadCalls[0][1])).toContain("Rescheduled");
    // ...and nobody gets a DM about it.
    expect(mockDM).not.toHaveBeenCalled();
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

  it("finds a player by their character name, resolving to the owner", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser({ username: "discordhandle123" });
    await createCharacter({ ownerId: owner.id, name: "Vincent Silverhand" });
    const res = await request(app)
      .get("/api/missions/actor-search?q=Silverhand")
      .set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    expect(res.body.some((u: { id: string }) => u.id === owner.id)).toBe(true);
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

  it("submit → approve publishes the mission in one step (admin)", async () => {
    const admin = await createUser({ roles: ["admin"] });
    const m = await seedMission({ workflowState: "draft", status: "open" });

    const submitted = await request(app).post(`/api/missions/${m.id}/submit`).set("x-test-user", admin.id);
    expect(submitted.status).toBe(200);
    expect(submitted.body.workflowState).toBe("proposal");

    // Approval publishes to the public board in one step — workflowState jumps
    // straight to "posted" (no separate manual /post action).
    const approved = await request(app).post(`/api/missions/${m.id}/approve`).set("x-test-user", admin.id);
    expect(approved.status).toBe(200);
    expect(approved.body.workflowState).toBe("posted");

    // The mission is already posted, so a redundant /post is a no-op conflict.
    const posted = await request(app).post(`/api/missions/${m.id}/post`).set("x-test-user", admin.id);
    expect(posted.status).toBe(409);
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

  it("an archivist can approve a proposal (which publishes it)", async () => {
    const archivist = await createUser({ roles: ["archivist"] });
    const m = await seedMission({ workflowState: "proposal" });
    const approved = await request(app).post(`/api/missions/${m.id}/approve`).set("x-test-user", archivist.id);
    expect(approved.status).toBe(200);
    expect(approved.body.workflowState).toBe("posted");
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

  it("returns a posted mission to draft and (Live) tears down its Discord event", async () => {
    await setLiveMode(true);
    const admin = await createUser({ roles: ["admin"] });
    const created = await createPostedMission(admin.id, { startAt: futureIso() });
    expect(created.body.discordEventId).toBe("evt-1");

    const reverted = await request(app)
      .post(`/api/missions/${created.body.id}/revert-to-draft`)
      .set("x-test-user", admin.id);
    expect(reverted.status).toBe(200);
    expect(reverted.body.workflowState).toBe("draft");
    expect(reverted.body.status).toBe("open");
    // Drafts never own a scheduled event — the revert must tear it down.
    expect(mockDeleteEvent).toHaveBeenCalledTimes(1);
    expect(mockDeleteEvent.mock.calls[0][0]).toBe("evt-1");
    const [row] = await db.select().from(missions).where(eq(missions.id, created.body.id));
    expect(row.discordEventId).toBeNull();
    expect(row.workflowState).toBe("draft");
  });

  it("an approved (not yet posted) mission can also be returned to draft", async () => {
    const admin = await createUser({ roles: ["admin"] });
    const m = await seedMission({ workflowState: "approved", status: "open" });
    const reverted = await request(app)
      .post(`/api/missions/${m.id}/revert-to-draft`)
      .set("x-test-user", admin.id);
    expect(reverted.status).toBe(200);
    expect(reverted.body.workflowState).toBe("draft");
  });

  it("409s reverting a mission that is still a draft or a proposal", async () => {
    const admin = await createUser({ roles: ["admin"] });
    const draft = await seedMission({ workflowState: "draft", status: "open" });
    const proposal = await seedMission({ workflowState: "proposal", status: "open" });
    expect(
      (await request(app).post(`/api/missions/${draft.id}/revert-to-draft`).set("x-test-user", admin.id)).status,
    ).toBe(409);
    expect(
      (await request(app).post(`/api/missions/${proposal.id}/revert-to-draft`).set("x-test-user", admin.id)).status,
    ).toBe(409);
  });

  it("409s reverting a completed or cancelled mission — those are history", async () => {
    const admin = await createUser({ roles: ["admin"] });
    const done = await seedMission({ workflowState: "posted", status: "completed" });
    await db.update(missions).set({ completedAt: new Date() }).where(eq(missions.id, done.id));
    expect(
      (await request(app).post(`/api/missions/${done.id}/revert-to-draft`).set("x-test-user", admin.id)).status,
    ).toBe(409);

    const cancelled = await seedMission({ workflowState: "posted", status: "cancelled" });
    expect(
      (await request(app).post(`/api/missions/${cancelled.id}/revert-to-draft`).set("x-test-user", admin.id)).status,
    ).toBe(409);
  });

  it("a plain user cannot revert a mission to draft (403)", async () => {
    const user = await createUser();
    const m = await seedMission({ workflowState: "posted", status: "open" });
    const res = await request(app).post(`/api/missions/${m.id}/revert-to-draft`).set("x-test-user", user.id);
    expect(res.status).toBe(403);
  });

  it("a revert racing a concurrent post never strands a draft with a Discord event", async () => {
    await setLiveMode(true);
    const admin = await createUser({ roles: ["admin"] });
    const m = await seedMission({
      workflowState: "approved",
      status: "open",
      startAt: new Date(Date.now() + 86_400_000),
    });

    // Simulate the race: while /post is mid-flight talking to Discord (event
    // creation), a concurrent /revert-to-draft claims the row back. The post
    // must then refuse to persist the event id onto the now-draft row and
    // tear down the event it just created.
    mockCreateEvent.mockImplementationOnce(async () => {
      const reverted = await request(app)
        .post(`/api/missions/${m.id}/revert-to-draft`)
        .set("x-test-user", admin.id);
      expect(reverted.status).toBe(200);
      return { ok: true, id: "evt-race" } as never;
    });

    const posted = await request(app).post(`/api/missions/${m.id}/post`).set("x-test-user", admin.id);
    expect(posted.status).toBe(409);

    // Invariant: a draft mission never owns a scheduled event, and the event
    // created by the losing post was deleted rather than orphaned.
    expect(mockDeleteEvent).toHaveBeenCalledWith("evt-race");
    const [row] = await db.select().from(missions).where(eq(missions.id, m.id));
    expect(row.workflowState).toBe("draft");
    expect(row.discordEventId).toBeNull();
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

  // Regression: a player applied, but instead of "accept application" the fixer
  // added the character via the roster editor. That raises a participation
  // request and an assignment but never touches the application row, leaving
  // "My Applications" stuck on PENDING even after the player is on the roster
  // (and paid). My Applications must self-heal to ACCEPTED, and confirming the
  // participation request must flip the canonical row too.
  it("My Applications self-heals to accepted when added via the roster editor", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const admin = await createUser({ roles: ["admin"] });
    const m = await postedMission();

    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id });
    const appId = applied.body.myApplication.id as number;

    const mineBefore = await request(app).get("/api/missions/my-applications").set("x-test-user", player.id);
    expect(mineBefore.status).toBe(200);
    expect(mineBefore.body.find((a: { id: number }) => a.id === appId)?.status).toBe("pending");

    // Fixer adds the character through the roster editor (NOT "accept application").
    const edit = await request(app)
      .patch(`/api/missions/${m.id}`)
      .set("x-test-user", admin.id)
      .send({ assignments: [{ characterId: char.id }] });
    expect(edit.status).toBe(200);

    // The stored row is still pending, but My Applications derives "accepted"
    // because the character is now on the roster.
    const [rawApp] = await db.select().from(missionApplications).where(eq(missionApplications.id, appId));
    expect(rawApp.status).toBe("pending");
    const mineAfter = await request(app).get("/api/missions/my-applications").set("x-test-user", player.id);
    expect(mineAfter.body.find((a: { id: number }) => a.id === appId)?.status).toBe("accepted");

    // The mission-detail "YOUR APPLICATION" badge derives accepted too.
    const detail = await request(app).get(`/api/missions/${m.id}`).set("x-test-user", player.id);
    expect(detail.status).toBe(200);
    expect(detail.body.myApplication?.status).toBe("accepted");

    // The Open-tab mission card (list summary) derives accepted too.
    const list = await request(app).get("/api/missions?status=open").set("x-test-user", player.id);
    expect(list.status).toBe(200);
    const card = (list.body as Array<{ id: number; myApplication?: { status?: string } }>).find((x) => x.id === m.id);
    expect(card?.myApplication?.status).toBe("accepted");

    // Confirming the participation request flips the canonical row to accepted.
    const reqRow = (
      await db.select().from(customRequests).where(eq(customRequests.characterId, char.id))
    ).find((r) => r.type === "mission_participation" && Number((r.details as { missionId?: number }).missionId) === m.id);
    expect(reqRow).toBeTruthy();
    const decision = await request(app)
      .post(`/api/requests/${reqRow!.id}/participation-decision`)
      .set("x-test-user", player.id)
      .send({ decision: "accept" });
    expect(decision.status).toBe(200);
    const [appFinal] = await db.select().from(missionApplications).where(eq(missionApplications.id, appId));
    expect(appFinal.status).toBe("accepted");
  });

  // Race guard: if the fixer removes the (unpaid) assignment before the player
  // responds, the participation request goes stale. Accepting it must NOT
  // canonicalize the application to accepted (no roster membership), and My
  // Applications must not surface accepted either.
  it("a stale participation accept (assignment removed) does not mark the application accepted", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const admin = await createUser({ roles: ["admin"] });
    const m = await postedMission();

    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id });
    const appId = applied.body.myApplication.id as number;

    // Fixer adds the character, then removes them again (unpaid → deleted).
    await request(app)
      .patch(`/api/missions/${m.id}`)
      .set("x-test-user", admin.id)
      .send({ assignments: [{ characterId: char.id }] });
    await request(app)
      .patch(`/api/missions/${m.id}`)
      .set("x-test-user", admin.id)
      .send({ assignments: [] });
    const assigns = await db.select().from(missionAssignments).where(eq(missionAssignments.missionId, m.id));
    expect(assigns).toHaveLength(0);

    // The (now stale) participation request still exists; player accepts it.
    const reqRow = (
      await db.select().from(customRequests).where(eq(customRequests.characterId, char.id))
    ).find((r) => r.type === "mission_participation" && Number((r.details as { missionId?: number }).missionId) === m.id);
    expect(reqRow).toBeTruthy();
    await request(app)
      .post(`/api/requests/${reqRow!.id}/participation-decision`)
      .set("x-test-user", player.id)
      .send({ decision: "accept" });

    // No assignment ⇒ application stays pending, and My Applications shows pending.
    const [appFinal] = await db.select().from(missionApplications).where(eq(missionApplications.id, appId));
    expect(appFinal.status).toBe("pending");
    const mine = await request(app).get("/api/missions/my-applications").set("x-test-user", player.id);
    expect(mine.body.find((a: { id: number }) => a.id === appId)?.status).toBe("pending");
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

  // Regression: a withdrawn application must never block re-applying. The detail
  // page hides the apply form whenever `myApplication` is a non-withdrawn row, so
  // surfacing the wrong row (e.g. the oldest, when a player holds several rows on
  // one mission via different characters) used to lock a player out of reapplying
  // the very character they withdrew. The surfaced application must be the most
  // relevant one (active first, else the most recent terminal) and a withdrawn-only
  // state must fall through so the player can reapply.
  it("withdrawing then re-applying surfaces the withdrawn/pending row, not a stale sibling", async () => {
    const player = await createUser();
    const charA = await createCharacter({ ownerId: player.id });
    const charB = await createCharacter({ ownerId: player.id });
    const m = await postedMission();
    const apply = (characterId: number) =>
      request(app).post(`/api/missions/${m.id}/applications`).set("x-test-user", player.id).send({ characterId });
    const detail = () => request(app).get(`/api/missions/${m.id}`).set("x-test-user", player.id);

    // Player applies with A, then with B (B is the newer row).
    await apply(charA.id);
    const appliedB = await apply(charB.id);
    const appBId = appliedB.body.myApplication.id as number;

    // Withdraw the NEWER application (B). The player still has an active app (A),
    // so the detail page should surface A (pending) — not get stuck/blank.
    const wB = await request(app).delete(`/api/missions/${m.id}/applications/${appBId}`).set("x-test-user", player.id);
    expect(wB.status).toBe(200);
    const afterWithdrawB = await detail();
    expect(afterWithdrawB.body.myApplication?.characterId).toBe(charA.id);
    expect(afterWithdrawB.body.myApplication?.status).toBe("pending");

    // Now withdraw A too. With no active application, the surfaced row must be a
    // withdrawn one so the frontend renders the apply form (re-apply enabled).
    const [appA] = await db
      .select()
      .from(missionApplications)
      .where(and(eq(missionApplications.missionId, m.id), eq(missionApplications.characterId, charA.id)));
    const wA = await request(app).delete(`/api/missions/${m.id}/applications/${appA.id}`).set("x-test-user", player.id);
    expect(wA.status).toBe(200);
    const allWithdrawn = await detail();
    expect(allWithdrawn.body.myApplication?.status).toBe("withdrawn");

    // Re-applying with B succeeds and is surfaced as the active (pending) row.
    const reapplied = await apply(charB.id);
    expect(reapplied.status).toBe(200);
    const afterReapply = await detail();
    expect(afterReapply.body.myApplication?.characterId).toBe(charB.id);
    expect(afterReapply.body.myApplication?.status).toBe("pending");
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
// AVAILABILITY (When2Meet) — applicants attach absolute UTC instants; fixers
// read them back per-application; players can persist a weekly default.
// ===========================================================================
describe("Mission application availability", () => {
  async function postedMission() {
    return seedMission({ workflowState: "posted", status: "open" });
  }

  const A = "2026-06-21T20:00:00.000Z";
  const B = "2026-06-21T20:30:00.000Z";

  it("persists availability on the application and the fixer reads it back", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const admin = await createUser({ roles: ["admin"] });
    const m = await postedMission();

    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id, availability: [B, A, B] });
    expect(applied.status).toBe(200);

    // Stored normalized: deduped + sorted ascending.
    const [row] = await db.select().from(missionApplications).where(eq(missionApplications.missionId, m.id));
    expect(row.availability).toEqual([A, B]);

    // The fixer sees availability on the application view.
    const asAdmin = await request(app).get(`/api/missions/${m.id}`).set("x-test-user", admin.id);
    expect(asAdmin.body.applications[0].availability).toEqual([A, B]);
  });

  it("drops invalid instants and an absent availability field defaults to empty", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await postedMission();

    const withJunk = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id, availability: [A, "not-a-date", 42] });
    expect(withJunk.status).toBe(200);
    const [row] = await db.select().from(missionApplications).where(eq(missionApplications.missionId, m.id));
    expect(row.availability).toEqual([A]);
  });

  it("re-applying refreshes the availability slots", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await postedMission();

    await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id, availability: [A] });
    await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id, availability: [B] });

    const rows = await db.select().from(missionApplications).where(eq(missionApplications.missionId, m.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].availability).toEqual([B]);
  });

  it("saves and loads the player's weekly default when makeDefault is set", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await postedMission();

    const before = await request(app).get("/api/me/availability-default").set("x-test-user", player.id);
    expect(before.status).toBe(200);
    expect(before.body.pattern).toEqual([]);
    expect(before.body.timezone).toBeNull();

    const pattern = [
      { weekday: 0, minutes: 1200 },
      { weekday: 0, minutes: 1200 }, // dupe, should collapse
      { weekday: 9, minutes: 100 }, // invalid weekday, dropped
    ];
    const applied = await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({
        characterId: char.id,
        availability: [A],
        makeDefault: true,
        defaultPattern: pattern,
        timezone: "America/Los_Angeles",
      });
    expect(applied.status).toBe(200);

    const after = await request(app).get("/api/me/availability-default").set("x-test-user", player.id);
    expect(after.body.pattern).toEqual([{ weekday: 0, minutes: 1200 }]);
    expect(after.body.timezone).toBe("America/Los_Angeles");
  });

  it("does not persist a default when makeDefault is omitted", async () => {
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const m = await postedMission();

    await request(app)
      .post(`/api/missions/${m.id}/applications`)
      .set("x-test-user", player.id)
      .send({ characterId: char.id, availability: [A], defaultPattern: [{ weekday: 0, minutes: 1200 }] });

    const after = await request(app).get("/api/me/availability-default").set("x-test-user", player.id);
    expect(after.body.pattern).toEqual([]);
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

  it("owned: a fixer sees the staff-wide board", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const res = await request(app).get("/api/missions/owned").set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("owned: a plain player is forbidden", async () => {
    const player = await createUser();
    const res = await request(app).get("/api/missions/owned").set("x-test-user", player.id);
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
    const ids = (res.body.items as Array<{ id: number }>).map((m) => m.id);
    expect(ids).toContain(done.id);
    expect(ids).not.toContain(active.id);
    expect(res.body.hasMore).toBe(false);
  });

  it("history: a non-manager never sees non-posted missions", async () => {
    const player = await createUser();
    const hiddenDraft = await seedMission({ title: "Draft", workflowState: "draft", status: "cancelled" });
    await seedAssignment(hiddenDraft.id, player.id);
    const res = await request(app).get("/api/missions/history").set("x-test-user", player.id);
    const ids = (res.body.items as Array<{ id: number }>).map((m) => m.id);
    expect(ids).not.toContain(hiddenDraft.id);
  });

  it("history: a manager also sees terminal missions they ran", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const ran = await seedMission({ title: "Ran", fixerId: fixer.id, workflowState: "posted", status: "cancelled" });
    const res = await request(app).get("/api/missions/history").set("x-test-user", fixer.id);
    const ids = (res.body.items as Array<{ id: number }>).map((m) => m.id);
    expect(ids).toContain(ran.id);
  });

  it("history: paginates with limit/offset and reports hasMore", async () => {
    const player = await createUser();
    // Seed 3 terminal attended missions; with limit=2 the first page returns 2
    // rows + hasMore, the second page returns the last row + no more.
    const seeded: number[] = [];
    for (let i = 0; i < 3; i++) {
      const m = await seedMission({ title: `Done ${i}`, workflowState: "posted", status: "completed_paid" });
      await seedAssignment(m.id, player.id);
      seeded.push(m.id);
    }

    const page1 = await request(app)
      .get("/api/missions/history?limit=2&offset=0")
      .set("x-test-user", player.id);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.hasMore).toBe(true);

    const page2 = await request(app)
      .get("/api/missions/history?limit=2&offset=2")
      .set("x-test-user", player.id);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.hasMore).toBe(false);

    const allIds = [
      ...(page1.body.items as Array<{ id: number }>).map((m) => m.id),
      ...(page2.body.items as Array<{ id: number }>).map((m) => m.id),
    ];
    for (const id of seeded) expect(allIds).toContain(id);
    // No row appears on both pages.
    expect(new Set(allIds).size).toBe(3);
  });

  it("history: ties on startAt/createdAt fall back to a stable id-descending order with no page overlap or skip", async () => {
    const player = await createUser();
    // Five terminal attended missions that ALL share the exact same startAt and
    // createdAt. Without the desc(missions.id) tiebreaker the ORDER BY is
    // non-deterministic, so limit/offset paging could duplicate or skip rows.
    const sharedStartAt = new Date("2026-01-15T20:00:00.000Z");
    const sharedCreatedAt = new Date("2026-01-10T12:00:00.000Z");
    const seeded: number[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await seedMission({
        title: `Tie ${i}`,
        workflowState: "posted",
        status: "completed_paid",
        startAt: sharedStartAt,
        createdAt: sharedCreatedAt,
      });
      await seedAssignment(m.id, player.id);
      seeded.push(m.id);
    }
    // Highest id first: insertion order ascending, so reverse to get expected.
    const expectedOrder = [...seeded].sort((a, b) => b - a);

    // A single full page must already be id-descending.
    const all = await request(app)
      .get("/api/missions/history?limit=10&offset=0")
      .set("x-test-user", player.id);
    expect(all.status).toBe(200);
    const allIds = (all.body.items as Array<{ id: number }>).map((m) => m.id);
    expect(allIds).toEqual(expectedOrder);

    // Walk the same data two rows at a time; every page must be the matching
    // slice of the deterministic order — no row repeated, none skipped.
    const paged: number[] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      const res = await request(app)
        .get(`/api/missions/history?limit=2&offset=${offset}`)
        .set("x-test-user", player.id);
      expect(res.status).toBe(200);
      const ids = (res.body.items as Array<{ id: number }>).map((m) => m.id);
      expect(ids).toEqual(expectedOrder.slice(offset, offset + 2));
      paged.push(...ids);
    }
    // The concatenated pages exactly reconstruct the full ordering with no
    // duplicates and no gaps.
    expect(paged).toEqual(expectedOrder);
    expect(new Set(paged).size).toBe(5);
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

describe("Remove assigned player", () => {
  // Seed an accepted application + assignment for `player` on a fixer-owned
  // mission, mirroring the state after reviewApplication(action=accept).
  async function seedAccepted(opts: {
    fixerId: string;
    paymentStatus?: string;
    attendanceCreditedAt?: Date | null;
  }) {
    const player = await createUser({ username: "Player" });
    const char = await createCharacter({ ownerId: player.id });
    const m = await seedMission({ fixerId: opts.fixerId, status: "open", workflowState: "posted" });
    await db.insert(missionApplications).values({
      missionId: m.id,
      userId: player.id,
      characterId: char.id,
      status: "accepted",
    });
    const a = await seedAssignment(m.id, player.id, {
      characterId: char.id,
      paymentStatus: opts.paymentStatus ?? "unpaid",
      attendanceCreditedAt: opts.attendanceCreditedAt ?? null,
    });
    return { player, char, mission: m, assignment: a };
  }

  it("owning fixer removes an unpaid player: assignment deleted, application freed", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const { player, mission } = await seedAccepted({ fixerId: fixer.id });

    const res = await request(app)
      .delete(`/api/missions/${mission.id}/assignments/${player.id}`)
      .set("x-test-user", fixer.id);
    expect(res.status).toBe(200);

    const assignments = await db
      .select()
      .from(missionAssignments)
      .where(eq(missionAssignments.missionId, mission.id));
    expect(assignments).toHaveLength(0);

    const [app2] = await db
      .select()
      .from(missionApplications)
      .where(eq(missionApplications.userId, player.id));
    expect(app2.status).toBe("withdrawn");
  });

  it("reverts attendance for a player who attended but was not paid (failed)", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const { player, mission } = await seedAccepted({
      fixerId: fixer.id,
      paymentStatus: "failed",
      attendanceCreditedAt: new Date(),
    });

    const res = await request(app)
      .delete(`/api/missions/${mission.id}/assignments/${player.id}`)
      .set("x-test-user", fixer.id);
    expect(res.status).toBe(200);

    // Deleting the assignment row removes the attendance credit entirely.
    const rows = await db
      .select()
      .from(missionAssignments)
      .where(eq(missionAssignments.userId, player.id));
    expect(rows).toHaveLength(0);
  });

  it("refuses to remove a player who was already paid (409, assignment intact)", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const { player, mission } = await seedAccepted({
      fixerId: fixer.id,
      paymentStatus: "paid",
      attendanceCreditedAt: new Date(),
    });

    const res = await request(app)
      .delete(`/api/missions/${mission.id}/assignments/${player.id}`)
      .set("x-test-user", fixer.id);
    expect(res.status).toBe(409);

    const rows = await db
      .select()
      .from(missionAssignments)
      .where(eq(missionAssignments.userId, player.id));
    expect(rows).toHaveLength(1);
  });

  it("a fixer who does not own the mission cannot remove its players (403)", async () => {
    const owner = await createUser({ roles: ["fixer"] });
    const other = await createUser({ roles: ["fixer"] });
    const { player, mission } = await seedAccepted({ fixerId: owner.id });

    const res = await request(app)
      .delete(`/api/missions/${mission.id}/assignments/${player.id}`)
      .set("x-test-user", other.id);
    expect(res.status).toBe(403);

    const rows = await db
      .select()
      .from(missionAssignments)
      .where(eq(missionAssignments.userId, player.id));
    expect(rows).toHaveLength(1);
  });

  it("an admin can remove a player from any mission", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const admin = await createUser({ roles: ["admin"] });
    const { player, mission } = await seedAccepted({ fixerId: fixer.id });

    const res = await request(app)
      .delete(`/api/missions/${mission.id}/assignments/${player.id}`)
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(missionAssignments)
      .where(eq(missionAssignments.userId, player.id));
    expect(rows).toHaveLength(0);
  });

  it("returns 404 when the player is not assigned to the mission", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const stranger = await createUser({ username: "Stranger" });
    const m = await seedMission({ fixerId: fixer.id, status: "open", workflowState: "posted" });

    const res = await request(app)
      .delete(`/api/missions/${m.id}/assignments/${stranger.id}`)
      .set("x-test-user", fixer.id);
    expect(res.status).toBe(404);
  });

  it("requires a fixer/admin role (403 for a plain player)", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const { player, mission } = await seedAccepted({ fixerId: fixer.id });

    const res = await request(app)
      .delete(`/api/missions/${mission.id}/assignments/${player.id}`)
      .set("x-test-user", player.id);
    expect(res.status).toBe(403);
  });

  it("remove-vs-pay race never both pays AND removes the same player", async () => {
    await setLiveMode(true);
    mockPatch.mockResolvedValue(bal(100));
    const fixer = await createUser({ roles: ["fixer"] });
    const player = await createUser({ username: "RacePlayer" });
    const char = await createCharacter({ ownerId: player.id });
    const m = await seedMission({ fixerId: fixer.id, playerPay: 100 });
    await db
      .insert(missionApplications)
      .values({ missionId: m.id, userId: player.id, characterId: char.id, status: "accepted" });
    await seedAssignment(m.id, player.id, { characterId: char.id });

    const [removeRes, payRes] = await Promise.all([
      request(app).delete(`/api/missions/${m.id}/assignments/${player.id}`).set("x-test-user", fixer.id),
      payMissionPlayers(m.id, { source: "manual" }),
    ]);

    const rows = await db
      .select()
      .from(missionAssignments)
      .where(eq(missionAssignments.userId, player.id));
    const paid = payRes?.paid ?? 0;
    if (removeRes.status === 200) {
      // Removal won: the row is gone and the player was never paid.
      expect(rows).toHaveLength(0);
      expect(paid).toBe(0);
    } else {
      // Payout won: removal is blocked (409) and the row remains paid.
      expect(removeRes.status).toBe(409);
      expect(rows).toHaveLength(1);
      expect(rows[0].paymentStatus).toBe("paid");
      expect(paid).toBe(1);
    }
    // Money moved exactly when (and only when) the player was actually paid.
    expect(mockPatch).toHaveBeenCalledTimes(paid);
  });
});
