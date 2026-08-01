import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq, and, isNull } from "drizzle-orm";

vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));

import { db, stores, ripperdocs, walletTransactions, users, botConfig } from "@workspace/db";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";
import { runEconomyReconcile, MAX_WALLET_BALANCE } from "../lib/economy";

const app = buildTestApp();
const mockGetBalance = vi.mocked(getBalance);
const mockPatch = vi.mocked(patchBalance);

beforeEach(() => {
  mockGetBalance.mockReset();
  mockPatch.mockReset();
});

async function setFlag(key: string, value: boolean) {
  await db
    .insert(botConfig)
    .values({ key, value: String(value) })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: String(value) } });
}

/** Put the economy system into a given tri-state mode. */
async function setMode(mode: "disabled" | "test" | "enabled") {
  await setFlag("economy_enabled", mode !== "disabled");
  await setFlag("master_live_mode", mode === "enabled");
  await setFlag("economy_live_mode", mode === "enabled");
}

async function makeStore(ownerId: string, balance = 0) {
  const [s] = await db.insert(stores).values({ ownerId, name: "Chrome Bazaar", balance }).returning();
  return s;
}
async function makeRipperdoc(ownerId: string, balance = 0) {
  const [r] = await db.insert(ripperdocs).values({ ownerId, name: "Vik's Clinic", balance }).returning();
  return r;
}

describe("POST /stores/:id/deposit & /withdraw", () => {
  it("403s when the actor is not the owner", async () => {
    await setMode("enabled");
    const owner = await createUser();
    const stranger = await createUser();
    const store = await makeStore(owner.id);
    const res = await request(app)
      .post(`/api/stores/${store.id}/deposit`)
      .set("x-test-user", stranger.id)
      .send({ amount: 100 });
    expect(res.status).toBe(403);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("deposit moves eddies from the personal wallet to the store and writes dual ledger rows", async () => {
    await setMode("enabled");
    mockGetBalance.mockResolvedValue({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });
    mockPatch.mockResolvedValue({ cash: 800, bank: 0, total: 800, source: "unbelievaboat" });
    const owner = await createUser();
    await db.update(users).set({ walletBalance: 1000, lastSyncedUbBalance: 1000 }).where(eq(users.id, owner.id));
    const store = await makeStore(owner.id, 0);

    const res = await request(app)
      .post(`/api/stores/${store.id}/deposit`)
      .set("x-test-user", owner.id)
      .send({ amount: 200 });
    expect(res.status).toBe(200);

    // Personal leg syncs to UB (cash decreases on deposit).
    expect(mockPatch).toHaveBeenCalledWith(owner.discordId, expect.objectContaining({ cash: -200 }));

    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(200);

    // Venue leg (storeId set, userId null) + personal leg.
    const venueLeg = await db
      .select()
      .from(walletTransactions)
      .where(and(eq(walletTransactions.storeId, store.id), isNull(walletTransactions.userId)));
    expect(venueLeg).toHaveLength(1);
    expect(venueLeg[0].amount).toBe(200);
  });

  it("authorizes a debit by live UB cash when the website mirror is stale-low", async () => {
    await setMode("enabled");
    // Mirror says 100, but live UB cash covers the full amount (bot-side
    // earnings not yet reconciled). The debit must NOT be refused.
    mockGetBalance.mockResolvedValue({ cash: 8000, bank: 0, total: 8000, source: "unbelievaboat" });
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const owner = await createUser();
    await db.update(users).set({ walletBalance: 100, lastSyncedUbBalance: 100 }).where(eq(users.id, owner.id));
    const store = await makeStore(owner.id, 0);

    const res = await request(app)
      .post(`/api/stores/${store.id}/deposit`)
      .set("x-test-user", owner.id)
      .send({ amount: 8000 });
    expect(res.status).toBe(200);
    expect(mockPatch).toHaveBeenCalledWith(owner.discordId, expect.objectContaining({ cash: -8000 }));

    // The stale mirror must be self-healed (reconcile fold +7900) before the
    // debit applies, so the stored balance and ledger stay truthful.
    const [u] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(u.walletBalance).toBe(0); // 100 + 7900 fold - 8000 debit
    const rows = await db
      .select()
      .from(walletTransactions)
      .where(and(eq(walletTransactions.userId, owner.id), eq(walletTransactions.kind, "reconcile")));
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(7900);
  });

  it("still refuses a debit when live UB cash is also insufficient", async () => {
    await setMode("enabled");
    mockGetBalance.mockResolvedValue({ cash: 50, bank: 5000, total: 5050, source: "unbelievaboat" });
    const owner = await createUser();
    await db.update(users).set({ walletBalance: 50, lastSyncedUbBalance: 50 }).where(eq(users.id, owner.id));
    const store = await makeStore(owner.id, 0);

    const res = await request(app)
      .post(`/api/stores/${store.id}/deposit`)
      .set("x-test-user", owner.id)
      .send({ amount: 200 });
    // Bank does not count — debits target UB cash only.
    expect(res.status).toBe(400);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("rejects overdraw when withdrawing more than the store holds", async () => {
    await setMode("enabled");
    mockGetBalance.mockResolvedValue({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });
    const owner = await createUser();
    const store = await makeStore(owner.id, 50);
    const res = await request(app)
      .post(`/api/stores/${store.id}/withdraw`)
      .set("x-test-user", owner.id)
      .send({ amount: 100 });
    expect(res.status).toBe(400);
    expect(mockPatch).not.toHaveBeenCalled();
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(50);
  });

  it("rejects a withdrawal that would push the wallet past the int4 ceiling", async () => {
    await setMode("enabled");
    mockGetBalance.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const owner = await createUser();
    // Wallet sits 50 below the int4 ceiling; a 100-eddy withdrawal would overflow.
    await db
      .update(users)
      .set({ walletBalance: MAX_WALLET_BALANCE - 50, lastSyncedUbBalance: MAX_WALLET_BALANCE - 50 })
      .where(eq(users.id, owner.id));
    const store = await makeStore(owner.id, 100);

    const res = await request(app)
      .post(`/api/stores/${store.id}/withdraw`)
      .set("x-test-user", owner.id)
      .send({ amount: 100 });

    expect(res.status).toBe(400);
    // Rejected before any UB call or balance write.
    expect(mockPatch).not.toHaveBeenCalled();
    const [u] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(u.walletBalance).toBe(MAX_WALLET_BALANCE - 50);
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(100);
  });

  it("502s and does not touch the store when the personal-leg UB sync fails", async () => {
    await setMode("enabled");
    mockGetBalance.mockResolvedValue({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });
    mockPatch.mockResolvedValue(null);
    const owner = await createUser();
    const store = await makeStore(owner.id, 0);
    const res = await request(app)
      .post(`/api/stores/${store.id}/deposit`)
      .set("x-test-user", owner.id)
      .send({ amount: 200 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(0);
  });
});

describe("ripperdoc deposit/withdraw", () => {
  it("withdraw moves eddies from the clinic back to the owner wallet", async () => {
    await setMode("enabled");
    mockGetBalance.mockResolvedValue({ cash: 500, bank: 0, total: 500, source: "unbelievaboat" });
    mockPatch.mockResolvedValue({ cash: 600, bank: 0, total: 600, source: "unbelievaboat" });
    const owner = await createUser();
    const clinic = await makeRipperdoc(owner.id, 300);
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/withdraw`)
      .set("x-test-user", owner.id)
      .send({ amount: 100 });
    expect(res.status).toBe(200);
    expect(mockPatch).toHaveBeenCalledWith(owner.discordId, expect.objectContaining({ cash: 100 }));
    const [r] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, clinic.id));
    expect(r.balance).toBe(200);
  });
});

describe("economy reconciliation (UB -> website)", () => {
  it("folds an external UB increase into walletBalance without touching venues", async () => {
    await setMode("enabled");
    const owner = await createUser();
    // Seed a known baseline so the diff is deterministic.
    await db
      .update(users)
      .set({ walletBalance: 1000, lastSyncedUbBalance: 1000 })
      .where(eq(users.id, owner.id));
    const store = await makeStore(owner.id, 500);
    // UB now reports 1300 -> +300 external delta.
    mockGetBalance.mockResolvedValue({ cash: 1300, bank: 0, total: 1300, source: "unbelievaboat" });

    await runEconomyReconcile();

    const [u] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(u.walletBalance).toBe(1300);
    expect(u.lastSyncedUbBalance).toBe(1300);
    // Venue balance must be untouched.
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(500);
    // A reconciliation ledger row was written.
    const recon = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, owner.id));
    expect(recon.length).toBeGreaterThanOrEqual(1);
  });

  it("writes nothing in test (dry-run) mode", async () => {
    await setMode("test");
    const owner = await createUser();
    await db
      .update(users)
      .set({ walletBalance: 1000, lastSyncedUbBalance: 1000 })
      .where(eq(users.id, owner.id));
    mockGetBalance.mockResolvedValue({ cash: 1300, bank: 0, total: 1300, source: "unbelievaboat" });

    await runEconomyReconcile();

    const [u] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(u.walletBalance).toBe(1000);
    const ledger = await db.select().from(walletTransactions);
    expect(ledger).toHaveLength(0);
  });

  it("skips entirely when disabled", async () => {
    await setMode("disabled");
    const owner = await createUser();
    await db.update(users).set({ walletBalance: 1000, lastSyncedUbBalance: 1000 }).where(eq(users.id, owner.id));
    mockGetBalance.mockResolvedValue({ cash: 1300, bank: 0, total: 1300, source: "unbelievaboat" });

    await runEconomyReconcile();

    const [u] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(u.walletBalance).toBe(1000);
    expect(mockGetBalance).not.toHaveBeenCalled();
  });
});

describe("admin economy dashboard", () => {
  it("lists out-of-sync players and a non-admin is rejected", async () => {
    await setMode("enabled");
    const player = await createUser();
    await db.update(users).set({ walletBalance: 1000, lastSyncedUbBalance: 1000 }).where(eq(users.id, player.id));
    mockGetBalance.mockResolvedValue({ cash: 1300, bank: 0, total: 1300, source: "unbelievaboat" });

    const forbidden = await request(app)
      .get("/api/admin/economy/out-of-sync")
      .set("x-test-user", player.id);
    expect(forbidden.status).toBe(403);

    const admin = await createAdmin();
    const res = await request(app)
      .get("/api/admin/economy/out-of-sync")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("enabled");
    const entry = res.body.entries.find((e: any) => e.userId === player.id);
    expect(entry).toBeTruthy();
    expect(entry.diff).toBe(300);
  });

  it("retry re-syncs one user and 404s for unknown users", async () => {
    await setMode("enabled");
    const admin = await createAdmin();
    const player = await createUser();
    await db.update(users).set({ walletBalance: 1000, lastSyncedUbBalance: 1000 }).where(eq(users.id, player.id));
    mockGetBalance.mockResolvedValue({ cash: 1300, bank: 0, total: 1300, source: "unbelievaboat" });

    const res = await request(app)
      .post(`/api/admin/economy/retry/${player.id}`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const [u] = await db.select().from(users).where(eq(users.id, player.id));
    expect(u.walletBalance).toBe(1300);

    const missing = await request(app)
      .post(`/api/admin/economy/retry/does-not-exist`)
      .set("x-test-user", admin.id)
      .send({});
    expect(missing.status).toBe(404);
  });
});
