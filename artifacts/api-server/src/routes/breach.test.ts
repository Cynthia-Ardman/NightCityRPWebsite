import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

// Stub the economy + Discord side-effects so the reward path settles in-process
// without touching the network. patchBalance is the UB credit leg.
vi.mock("../lib/unbelievaboat", () => ({
  patchBalance: vi.fn(),
  getBalance: vi.fn(),
}));
vi.mock("../lib/discord", async (orig) => {
  const actual = await orig<typeof import("../lib/discord")>();
  return {
    ...actual,
    sendDirectMessage: vi.fn().mockResolvedValue(undefined),
    postToChannel: vi.fn().mockResolvedValue(undefined),
  };
});

import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";
import { db, botConfig, users, walletTransactions } from "@workspace/db";
import { patchBalance } from "../lib/unbelievaboat";

const app = buildTestApp();
const mockPatch = vi.mocked(patchBalance);

async function setFlag(key: string, value: boolean): Promise<void> {
  await db
    .insert(botConfig)
    .values({ key, value: String(value) })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: String(value) } });
}

async function enableEconomy(): Promise<void> {
  await setFlag("economy_enabled", true);
  await setFlag("master_live_mode", true);
  await setFlag("economy_live_mode", true);
}

beforeEach(() => {
  mockPatch.mockReset();
});

describe("breach staff endpoints", () => {
  it("gates the puzzle log behind FIXER/ADMIN", async () => {
    const player = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });

    const denied = await request(app).get("/api/breach/puzzles").set("x-test-user", player.id);
    expect(denied.status).toBe(403);

    const allowed = await request(app).get("/api/breach/puzzles").set("x-test-user", fixer.id);
    expect(allowed.status).toBe(200);
    expect(Array.isArray(allowed.body)).toBe(true);
  });

  it("previews a puzzle for staff and validates difficulty", async () => {
    const player = await createUser();
    const admin = await createAdmin();

    const denied = await request(app)
      .post("/api/breach/puzzles/preview")
      .set("x-test-user", player.id)
      .send({ difficulty: "easy" });
    expect(denied.status).toBe(403);

    const bad = await request(app)
      .post("/api/breach/puzzles/preview")
      .set("x-test-user", admin.id)
      .send({ difficulty: "trivial" });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .post("/api/breach/puzzles/preview")
      .set("x-test-user", admin.id)
      .send({ difficulty: "easy" });
    expect(ok.status).toBe(200);
    expect(ok.body.difficulty).toBe("easy");
    expect(Array.isArray(ok.body.grid)).toBe(true);
    expect(Array.isArray(ok.body.solutionPath)).toBe(true);
  });
});

describe("breach player endpoints", () => {
  it("returns an empty assigned list for a fresh player", async () => {
    const player = await createUser();
    const res = await request(app).get("/api/breach/mine").set("x-test-user", player.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("reports a zero pending-count for a fresh player", async () => {
    const player = await createUser();
    const res = await request(app)
      .get("/api/breach/mine/pending-count")
      .set("x-test-user", player.id);
    expect(res.status).toBe(200);
  });

  it("401s on assigned puzzles without auth", async () => {
    const res = await request(app).get("/api/breach/mine");
    expect(res.status).toBe(401);
  });
});

describe("breach practice leaderboard", () => {
  it("is publicly readable without authentication", async () => {
    const res = await request(app).get("/api/breach/practice/leaderboard");
    expect(res.status).toBe(200);
  });
});

describe("breach reward — exactly-once at the HTTP layer", () => {
  it("credits the eddies reward once across the full preview→assign→start→result flow, and a repeat submit is a no-op", async () => {
    await enableEconomy();
    const admin = await createAdmin();
    const player = await createUser();
    await db.update(users).set({ walletBalance: 0, lastSyncedUbBalance: 0 }).where(eq(users.id, player.id));
    const character = await createCharacter({ ownerId: player.id });

    // Staff previews a solvable grid and assigns it to the player's character.
    const preview = await request(app)
      .post("/api/breach/puzzles/preview")
      .set("x-test-user", admin.id)
      .send({ difficulty: "easy" });
    expect(preview.status).toBe(200);
    const { grid, daemons, bufferSize, solutionPath } = preview.body;
    expect(solutionPath.length).toBeGreaterThan(0);

    const created = await request(app)
      .post("/api/breach/puzzles")
      .set("x-test-user", admin.id)
      .send({
        assignedCharacterId: character.id,
        difficulty: "easy",
        timeLimitSeconds: 600,
        rewardEddies: 500,
        puzzle: { grid, daemons, bufferSize },
      });
    expect(created.status).toBe(201);
    const puzzleId = created.body.id as number;

    // Player must anchor the server-side timer before any result is accepted.
    const start = await request(app)
      .post(`/api/breach/puzzles/${puzzleId}/start`)
      .set("x-test-user", player.id);
    expect(start.status).toBe(200);

    // UB credit succeeds → reward settles on the first submit.
    mockPatch.mockResolvedValue({ cash: 500, bank: 0, total: 500, source: "unbelievaboat" });
    const first = await request(app)
      .post(`/api/breach/puzzles/${puzzleId}/result`)
      .set("x-test-user", player.id)
      .send({ selection: solutionPath });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ success: true, rewardPaid: true });

    // A repeat submit must NOT pay again.
    const second = await request(app)
      .post(`/api/breach/puzzles/${puzzleId}/result`)
      .set("x-test-user", player.id)
      .send({ selection: solutionPath });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ rewardPaid: false });

    // Credited exactly once, with a single synced ledger row under the idem key.
    const [p] = await db.select().from(users).where(eq(users.id, player.id));
    expect(p.walletBalance).toBe(500);
    const ledger = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, `breach-reward-${puzzleId}`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].syncStatus).toBe("synced");
  });
});
