import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

// Mock the currency provider so no test ever touches the real Unbelievaboat API.
vi.mock("../lib/unbelievaboat", () => ({
  patchBalance: vi.fn(),
  getBalance: vi.fn(),
}));

import { db, characters, users, walletTransactions, auditLog, botConfig } from "@workspace/db";
import { patchBalance } from "../lib/unbelievaboat";
import { nextWeeklyRunDate } from "../lib/jobs";
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
  // BILLED week is exactly N. weeksSinceLastCheckup maps a date D to
  // floor((runAt - D) / 1w) + 1.
  const billedWeeksOf = (iso: string) =>
    Math.floor((nextWeeklyRunDate().getTime() - new Date(iso).getTime()) / (7 * DAY)) + 1;

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
      nextWeeklyRunDate().getTime() - 3 * 7 * DAY,
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

  it("credits via the provider and writes a ledger row + audit on success", async () => {
    mockPatch.mockResolvedValue({ cash: 1100, bank: 0, total: 1100, source: "unbelievaboat" });
    const admin = await createAdmin();
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post("/api/admin/wallet/adjust")
      .set("x-test-user", admin.id)
      .send({ characterId: char.id, amount: 100, memo: "bonus" });
    expect(res.status).toBe(200);
    expect(mockPatch).toHaveBeenCalledWith(owner.discordId, expect.objectContaining({ cash: 100 }));
    const txns = await db.select().from(walletTransactions).where(eq(walletTransactions.characterId, char.id));
    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(100);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "admin_adjust"));
    expect(audits).toHaveLength(1);
  });

  it("does NOT write a ledger row if the provider rejects (502)", async () => {
    mockPatch.mockResolvedValue(null);
    const admin = await createAdmin();
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .post("/api/admin/wallet/adjust")
      .set("x-test-user", admin.id)
      .send({ characterId: char.id, amount: 100 });
    expect(res.status).toBe(502);
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
