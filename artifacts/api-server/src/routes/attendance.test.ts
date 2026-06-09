import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { db, attendanceClaims } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser } from "../test/testDb";

// UB is fully mocked: tests assert on how the route credits/refunds without
// touching the real economy. sessionWindow is mocked so the Sunday-only gate
// is deterministic regardless of when the suite runs.
vi.mock("../lib/unbelievaboat", () => ({ patchBalance: vi.fn() }));
vi.mock("../lib/sessionWindow", () => ({
  SESSION_WINDOW_HINT: "Sundays 2:00pm–9:00pm Pacific",
  isSessionWindowOpen: vi.fn(() => true),
  nextSessionWindowStart: vi.fn(() => new Date("2099-01-01T00:00:00Z")),
}));

import { patchBalance } from "../lib/unbelievaboat";
import { isSessionWindowOpen } from "../lib/sessionWindow";

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

  it("credits UB and writes one claim row on success", async () => {
    const user = await createUser();
    mockPatch.mockResolvedValue({ total: 1250 } as never);
    const res = await request(app).post("/api/attendance/claim").set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(250);
    expect(res.body.newBalance).toBe(1250);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch).toHaveBeenCalledWith(
      user.discordId,
      expect.objectContaining({ cash: 250 }),
    );
    const rows = await db.select().from(attendanceClaims);
    expect(rows).toHaveLength(1);
  });

  it("502s without inserting a row when the UB credit fails", async () => {
    const user = await createUser();
    mockPatch.mockResolvedValue(null as never);
    const res = await request(app).post("/api/attendance/claim").set("x-test-user", user.id);
    expect(res.status).toBe(502);
    const rows = await db.select().from(attendanceClaims);
    expect(rows).toHaveLength(0);
  });

  it("409s on a second claim in the same week and never double-credits", async () => {
    const user = await createUser();
    mockPatch.mockResolvedValue({ total: 1250 } as never);
    const first = await request(app).post("/api/attendance/claim").set("x-test-user", user.id);
    expect(first.status).toBe(200);

    const second = await request(app).post("/api/attendance/claim").set("x-test-user", user.id);
    expect(second.status).toBe(409);
    // Pre-check short-circuits before UB, so still only one credit total.
    expect(mockPatch).toHaveBeenCalledTimes(1);
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
