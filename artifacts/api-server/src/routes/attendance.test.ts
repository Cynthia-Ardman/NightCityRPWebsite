import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, attendanceClaims, users, ubPushOutbox } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser } from "../test/testDb";

// UB is fully mocked: tests assert on how the route credits/refunds without
// touching the real economy. Only the Sunday-only gate is mocked (so the suite
// is deterministic regardless of when it runs) — the real sessionWeekKey /
// legacySessionWeekKeys are kept so the week-keying logic is exercised.
vi.mock("../lib/unbelievaboat", () => ({ patchBalance: vi.fn() }));
vi.mock("../lib/sessionWindow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sessionWindow")>();
  return {
    ...actual,
    isSessionWindowOpen: vi.fn(() => true),
    nextSessionWindowStart: vi.fn(() => new Date("2099-01-01T00:00:00Z")),
  };
});

import { patchBalance } from "../lib/unbelievaboat";
import { isSessionWindowOpen, legacySessionWeekKeys } from "../lib/sessionWindow";

const app = buildTestApp();
const mockPatch = vi.mocked(patchBalance);
const mockWindow = vi.mocked(isSessionWindowOpen);

beforeEach(() => {
  mockPatch.mockReset();
  mockWindow.mockReset();
  mockWindow.mockReturnValue(true);
});

describe("POST /attendance/claim", () => {
  it("401s when unauthenticated", async () => {
    const res = await request(app).post("/api/attendance/claim");
    expect(res.status).toBe(401);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("403s outside the session window and never touches UB", async () => {
    const user = await createUser();
    mockWindow.mockReturnValue(false);
    const res = await request(app).post("/api/attendance/claim").set("x-test-user", user.id);
    expect(res.status).toBe(403);
    expect(mockPatch).not.toHaveBeenCalled();
    const rows = await db.select().from(attendanceClaims);
    expect(rows).toHaveLength(0);
  });

  it("credits the website wallet, queues the UB mirror push, and writes one claim row", async () => {
    const user = await createUser();
    await db.update(users).set({ walletBalance: 1000, lastSyncedUbBalance: 1000 }).where(eq(users.id, user.id));
    const res = await request(app).post("/api/attendance/claim").set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(250);
    expect(res.body.newBalance).toBe(1250);
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u.walletBalance).toBe(1250);
    const queued = await db.select().from(ubPushOutbox).where(eq(ubPushOutbox.userId, user.id));
    expect(queued.some((q) => q.amount === 250)).toBe(true);
    const rows = await db.select().from(attendanceClaims);
    expect(rows).toHaveLength(1);
  });

  it("409s on a second claim in the same week and never double-credits", async () => {
    const user = await createUser();
    await db.update(users).set({ walletBalance: 0, lastSyncedUbBalance: 0 }).where(eq(users.id, user.id));
    const first = await request(app).post("/api/attendance/claim").set("x-test-user", user.id);
    expect(first.status).toBe(200);

    const second = await request(app).post("/api/attendance/claim").set("x-test-user", user.id);
    expect(second.status).toBe(409);
    // Pre-check short-circuits, so still only one credit total.
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u.walletBalance).toBe(250);
    const rows = await db.select().from(attendanceClaims);
    expect(rows).toHaveLength(1);
  });

  it("409s when a pre-cutover legacy-keyed claim already exists for this session", async () => {
    const user = await createUser();
    mockPatch.mockResolvedValue({ total: 1250 } as never);
    // Simulate a claim made before the Pacific-Sunday key cutover: stored under
    // the old UTC-Monday key but claimed inside the current session week. The
    // claimedAt is what disambiguates it as "this week".
    const [, legacyMondayKey] = legacySessionWeekKeys();
    await db.insert(attendanceClaims).values({
      userId: user.id,
      weekStart: legacyMondayKey,
      amount: 250,
      claimedAt: new Date(),
    });

    const res = await request(app).post("/api/attendance/claim").set("x-test-user", user.id);
    expect(res.status).toBe(409);
    expect(mockPatch).not.toHaveBeenCalled();
    const rows = await db.select().from(attendanceClaims);
    expect(rows).toHaveLength(1);
  });
});

describe("GET /attendance/me", () => {
  it("reports unclaimed then claimed across a claim", async () => {
    const user = await createUser();
    mockPatch.mockResolvedValue({ total: 1250 } as never);

    const before = await request(app).get("/api/attendance/me").set("x-test-user", user.id);
    expect(before.status).toBe(200);
    expect(before.body.claimed).toBe(false);
    expect(before.body.payout).toBe(250);

    await request(app).post("/api/attendance/claim").set("x-test-user", user.id);

    const after = await request(app).get("/api/attendance/me").set("x-test-user", user.id);
    expect(after.body.claimed).toBe(true);
    expect(after.body.history).toHaveLength(1);
  });
});
