import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

// Mock the currency provider so no test ever touches the real Unbelievaboat API.
vi.mock("../lib/unbelievaboat", () => ({
  patchBalance: vi.fn(),
  getBalance: vi.fn(),
}));

import { db, characters, users, walletTransactions, auditLog, botConfig, ubPushOutbox } from "@workspace/db";
import { patchBalance } from "../lib/unbelievaboat";
import { nextWeeklyRunDate, weeksSinceLastCheckup } from "../lib/jobs";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockPatch = vi.mocked(patchBalance);

beforeEach(() => {
  mockPatch.mockReset();
});

describe("PUT /admin/characters/:id/owner", () => {
  it("requires ADMIN or FIXER (403 for plain user)", async () => {
    const user = await createUser();
    const char = await createCharacter();
    const res = await request(app)
      .put(`/api/admin/characters/${char.id}/owner`)
      .set("x-test-user", user.id)
      .send({ ownerId: user.id });
    expect(res.status).toBe(403);
  });

  it("assigns an owner and marks the character claimed", async () => {
    const admin = await createAdmin();
    const target = await createUser();
    const char = await createCharacter({ ownerId: null });
    const res = await request(app)
      .put(`/api/admin/characters/${char.id}/owner`)
      .set("x-test-user", admin.id)
      .send({ ownerId: target.id });
    expect(res.status).toBe(200);
    const [updated] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(updated.ownerId).toBe(target.id);
    expect(updated.claimed).toBe(true);
  });

  it("400s without an ownerId and 404s for unknown user", async () => {
    const admin = await createAdmin();
    const char = await createCharacter();
    const noBody = await request(app)
      .put(`/api/admin/characters/${char.id}/owner`)
      .set("x-test-user", admin.id)
      .send({});
    expect(noBody.status).toBe(400);
    const unknown = await request(app)
      .put(`/api/admin/characters/${char.id}/owner`)
      .set("x-test-user", admin.id)
      .send({ ownerId: "nobody" });
    expect(unknown.status).toBe(404);
  });
});

describe("DELETE /admin/characters/:id/owner", () => {
  it("clears the owner and marks the character unclaimed", async () => {
    const admin = await createAdmin();
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .delete(`/api/admin/characters/${char.id}/owner`)
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const [updated] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(updated.ownerId).toBeNull();
    expect(updated.claimed).toBe(false);
  });
});

describe("POST /admin/characters/:id/checkup", () => {
  it("forbids users without ADMIN or RIPPERDOC", async () => {
    const user = await createUser();
    const char = await createCharacter();
    const res = await request(app)
      .post(`/api/admin/characters/${char.id}/checkup`)
      .set("x-test-user", user.id)
      .send({});
    expect(res.status).toBe(403);
  });

  it("resets the missed-checkup streak and optionally re-bands", async () => {
    const admin = await createAdmin();
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, cyberwareLevel: "none" });
    await db.update(characters).set({ checkupStreak: 5 }).where(eq(characters.id, char.id));
    const res = await request(app)
      .post(`/api/admin/characters/${char.id}/checkup`)
      .set("x-test-user", admin.id)
      .send({ cyberwareLevel: "high" });
    expect(res.status).toBe(200);
    expect(res.body.checkupStreak).toBe(0);
    expect(res.body.cyberwareLevel).toBe("high");
    expect(res.body.lastCheckupAt).toBeTruthy();
  });

  it("rejects an invalid cyberware level with 400", async () => {
    const admin = await createAdmin();
    const char = await createCharacter();
    const res = await request(app)
      .post(`/api/admin/characters/${char.id}/checkup`)
      .set("x-test-user", admin.id)
      .send({ cyberwareLevel: "bogus" });
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/characters/:id/checkup — temporary reset floor", () => {
  const FLOOR_KEY = "checkup_reset_floor_weeks";
  const DAY = 86400000;

  const setFloor = (weeks: number) =>
    db
      .insert(botConfig)
      .values({ key: FLOOR_KEY, value: weeks })
      .onConflictDoUpdate({ target: botConfig.key, set: { value: weeks } });

  const clearFloor = () => db.delete(botConfig).where(eq(botConfig.key, FLOOR_KEY));

  // The billing week is evaluated AT the next weekly cron run (Monday 05:00
  // UTC), not "now" — the floor anchors against that same instant so the
  // BILLED week is exactly N. Use the real billing helper so this stays in
  // lockstep with the formula (including the grace window).
  const billedWeeksOf = (iso: string) =>
    weeksSinceLastCheckup(new Date(iso), nextWeeklyRunDate());

  beforeEach(async () => {
    await clearFloor();
  });

  it("caps a week-5 character so the NEXT BILLING RUN charges week 4 when the floor is 4", async () => {
    await setFloor(4);
    const admin = await createAdmin();
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const fiveWeeksAgo = new Date(Date.now() - 40 * DAY); // week 6+ at the next run
    await db.update(characters).set({ lastCheckupAt: fiveWeeksAgo }).where(eq(characters.id, char.id));
    const res = await request(app)
      .post(`/api/admin/characters/${char.id}/checkup`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);
    // The stamped date is exactly nextRun - 3 weeks → billed week is 4, not 5
    // (the old "now - 3 weeks" anchor read as week 5 by Monday's cron).
    expect(billedWeeksOf(res.body.lastCheckupAt)).toBe(4);
    expect(new Date(res.body.lastCheckupAt).getTime()).toBe(
      // Anchor pre-adds the grace window so the billed week is exactly N.
      nextWeeklyRunDate().getTime() - 3 * 7 * DAY - 2 * DAY,
    );
    await clearFloor();
  });

  it("leaves a character already under the floor untouched when the floor is 4", async () => {
    await setFloor(4);
    const admin = await createAdmin();
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    // Week 2 at the next run — newer than the floor anchor, so no backdating.
    const recent = new Date(nextWeeklyRunDate().getTime() - 10 * DAY);
    await db.update(characters).set({ lastCheckupAt: recent }).where(eq(characters.id, char.id));
    const res = await request(app)
      .post(`/api/admin/characters/${char.id}/checkup`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);
    // Date must be exactly the pre-existing one — never moved backward.
    expect(new Date(res.body.lastCheckupAt).getTime()).toBe(recent.getTime());
    expect(billedWeeksOf(res.body.lastCheckupAt)).toBe(2);
    await clearFloor();
  });

  it("resets fully to now when the floor key is absent", async () => {
    const admin = await createAdmin();
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const fiveWeeksAgo = new Date(Date.now() - 32 * DAY);
    await db.update(characters).set({ lastCheckupAt: fiveWeeksAgo }).where(eq(characters.id, char.id));
    const res = await request(app)
      .post(`/api/admin/characters/${char.id}/checkup`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);
    expect(Date.now() - new Date(res.body.lastCheckupAt).getTime()).toBeLessThan(60_000);
  });

  it("medical endpoint reports the ACTUAL visit date even when the floor backdates lastCheckupAt", async () => {
    await setFloor(4);
    const admin = await createAdmin();
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const fiveWeeksAgo = new Date(Date.now() - 32 * DAY);
    await db.update(characters).set({ lastCheckupAt: fiveWeeksAgo }).where(eq(characters.id, char.id));
    // Record a checkup NOW — the floor backdates lastCheckupAt to week 4.
    const checkupRes = await request(app)
      .post(`/api/admin/characters/${char.id}/checkup`)
      .set("x-test-user", admin.id)
      .send({});
    expect(checkupRes.status).toBe(200);
    expect(billedWeeksOf(checkupRes.body.lastCheckupAt)).toBe(4);

    const res = await request(app)
      .get(`/api/admin/characters/${char.id}/medical`)
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    // Billing-effective date is backdated so the next run bills week 4…
    expect(billedWeeksOf(res.body.lastCheckupAt)).toBe(4);
    // …but the actual visit date is just now (from the audit trail).
    expect(res.body.lastCheckupActualAt).toBeTruthy();
    expect(Date.now() - new Date(res.body.lastCheckupActualAt).getTime()).toBeLessThan(60_000);
    await clearFloor();
  });
});

describe("POST /admin/wallet/adjust", () => {
  it("requires ADMIN (403 for plain user)", async () => {
    const user = await createUser();
    const char = await createCharacter({ ownerId: user.id });
    const res = await request(app)
      .post("/api/admin/wallet/adjust")
      .set("x-test-user", user.id)
      .send({ characterId: char.id, amount: 100 });
    expect(res.status).toBe(403);
  });

  it("400s for missing fields and for an unclaimed character", async () => {
    const admin = await createAdmin();
    const missing = await request(app)
      .post("/api/admin/wallet/adjust")
      .set("x-test-user", admin.id)
      .send({ characterId: 1 });
    expect(missing.status).toBe(400);

    const orphan = await createCharacter({ ownerId: null });
    const unclaimed = await request(app)
      .post("/api/admin/wallet/adjust")
      .set("x-test-user", admin.id)
      .send({ characterId: orphan.id, amount: 100 });
    expect(unclaimed.status).toBe(400);
  });

  it("credits the website wallet, queues a mirror push, and writes a ledger row + audit on success", async () => {
    const admin = await createAdmin();
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post("/api/admin/wallet/adjust")
      .set("x-test-user", admin.id)
      .send({ characterId: char.id, amount: 100, memo: "bonus" });
    expect(res.status).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(u.walletBalance).toBe(100);
    const queued = await db.select().from(ubPushOutbox).where(eq(ubPushOutbox.userId, owner.id));
    expect(queued.some((q) => q.amount === 100)).toBe(true);
    const txns = await db.select().from(walletTransactions).where(eq(walletTransactions.characterId, char.id));
    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(100);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "admin_adjust"));
    expect(audits).toHaveLength(1);
  });

  it("does NOT write a ledger row if the wallet credit fails (502)", async () => {
    // Force the +100 credit to fail: the target wallet is pinned near the max
    // balance so the credit would overflow it.
    const admin = await createAdmin();
    const owner = await createUser();
    await db.update(users).set({ walletBalance: 2_147_483_600, lastSyncedUbBalance: 2_147_483_600 }).where(eq(users.id, owner.id));
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post("/api/admin/wallet/adjust")
      .set("x-test-user", admin.id)
      .send({ characterId: char.id, amount: 100 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const txns = await db.select().from(walletTransactions).where(eq(walletTransactions.characterId, char.id));
    expect(txns).toHaveLength(0);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "admin_adjust"));
    expect(audits).toHaveLength(0);
  });
});

describe("POST /admin/jobs/run", () => {
  it("rejects an unknown job name with 400", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post("/api/admin/jobs/run")
      .set("x-test-user", admin.id)
      .send({ job: "drop_tables" });
    expect(res.status).toBe(400);
  });

  it("runs a known job and reports a result", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post("/api/admin/jobs/run")
      .set("x-test-user", admin.id)
      .send({ job: "role_sync" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status");
  });
});

describe("bot-config flags", () => {
  it("upserts and deletes a config key (admin-only)", async () => {
    const admin = await createAdmin();
    const put = await request(app)
      .put("/api/admin/bot-config/cyberware_autobill_enabled")
      .set("x-test-user", admin.id)
      .send({ value: true });
    expect(put.status).toBe(200);

    const list = await request(app).get("/api/admin/bot-config").set("x-test-user", admin.id);
    expect(list.body.some((r: { key: string }) => r.key === "cyberware_autobill_enabled")).toBe(true);

    const del = await request(app)
      .delete("/api/admin/bot-config/cyberware_autobill_enabled")
      .set("x-test-user", admin.id);
    expect(del.status).toBe(204);
  });
});

describe("POST /admin/wallet/adjust — fixer access + user targets", () => {
  it("allows a FIXER to adjust via a bare userId (no character)", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const player = await createUser();
    const res = await request(app)
      .post("/api/admin/wallet/adjust")
      .set("x-test-user", fixer.id)
      .send({ userId: player.id, amount: 250, reason: "starter funds" });
    expect(res.status).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.id, player.id));
    expect(u.walletBalance).toBe(250);
    const txns = await db.select().from(walletTransactions).where(eq(walletTransactions.userId, player.id));
    expect(txns).toHaveLength(1);
    expect(txns[0].characterId).toBeNull();
    expect(txns[0].amount).toBe(250);
  });

  it("400 when both characterId and userId are supplied", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const char = await createCharacter({ ownerId: player.id });
    const res = await request(app)
      .post("/api/admin/wallet/adjust")
      .set("x-test-user", admin.id)
      .send({ characterId: char.id, userId: player.id, amount: 10, reason: "x" });
    expect(res.status).toBe(400);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("404 for an unknown userId", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post("/api/admin/wallet/adjust")
      .set("x-test-user", admin.id)
      .send({ userId: "nope", amount: 10, reason: "x" });
    expect(res.status).toBe(404);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("still 403s a plain user", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/admin/wallet/adjust")
      .set("x-test-user", user.id)
      .send({ userId: user.id, amount: 10, reason: "x" });
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/wallet/adjust — idempotency replay", () => {
  it("does not move money again for a repeated key", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const body = { userId: player.id, amount: 100, reason: "grant", idempotencyKey: "adj-key-1" };
    const first = await request(app).post("/api/admin/wallet/adjust").set("x-test-user", admin.id).send(body);
    expect(first.status).toBe(200);
    const second = await request(app).post("/api/admin/wallet/adjust").set("x-test-user", admin.id).send(body);
    expect(second.status).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.id, player.id));
    expect(u.walletBalance).toBe(100);
    const txns = await db.select().from(walletTransactions).where(eq(walletTransactions.userId, player.id));
    expect(txns).toHaveLength(1);
    const queued = await db.select().from(ubPushOutbox).where(eq(ubPushOutbox.userId, player.id));
    expect(queued).toHaveLength(1);
  });
});
