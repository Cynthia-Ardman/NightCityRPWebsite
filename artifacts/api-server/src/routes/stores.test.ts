import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));

import {
  db, stores, storeStock, storeEmployees, ripperdocs, ripperdocStock,
  inventoryItems, walletTransactions, characters, auditLog,
} from "@workspace/db";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockGetBalance = vi.mocked(getBalance);
const mockPatch = vi.mocked(patchBalance);

beforeEach(() => {
  mockGetBalance.mockReset();
  mockPatch.mockReset();
});

async function makeStore(ownerId: string, name = "Chrome Bazaar") {
  const [s] = await db.insert(stores).values({ ownerId, name }).returning();
  return s;
}
async function makeStock(storeId: number, opts: { price?: number; quantity?: number; name?: string } = {}) {
  const [it] = await db
    .insert(storeStock)
    .values({ storeId, name: opts.name ?? "Militech Pistol", price: opts.price ?? 100, quantity: opts.quantity ?? 5 })
    .returning();
  return it;
}

describe("POST /stores/:id/sell", () => {
  it("400s when stockId or buyerCharacterId is missing", async () => {
    const owner = await createUser();
    const store = await makeStore(owner.id);
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", owner.id)
      .send({ qty: 1 });
    expect(res.status).toBe(400);
  });

  it("403s when the actor is not owner, employee, or admin", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id);
    const buyer = await createCharacter({ ownerId: stranger.id });
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", stranger.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 1 });
    expect(res.status).toBe(403);
  });

  it("409s on insufficient stock", async () => {
    const owner = await createUser();
    const buyerUser = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id, { quantity: 2 });
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 5 });
    expect(res.status).toBe(409);
  });

  it("409s when the buyer character is unclaimed", async () => {
    const owner = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id);
    const buyer = await createCharacter({ ownerId: null });
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 1 });
    expect(res.status).toBe(409);
  });

  it("502s when the wallet provider is unavailable", async () => {
    mockGetBalance.mockResolvedValue(null);
    const owner = await createUser();
    const buyerUser = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id);
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 1 });
    expect(res.status).toBe(502);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("400s when the buyer cannot afford the purchase", async () => {
    mockGetBalance.mockResolvedValue({ cash: 50, bank: 0, total: 50, source: "unbelievaboat" });
    const owner = await createUser();
    const buyerUser = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id, { price: 100 });
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 1 });
    expect(res.status).toBe(400);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("refunds the buyer if crediting the seller fails", async () => {
    mockGetBalance.mockResolvedValue({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });
    // 1st patch (debit buyer) succeeds, 2nd patch (credit seller) fails -> 3rd patch refunds buyer
    mockPatch
      .mockResolvedValueOnce({ cash: 900, bank: 0, total: 900, source: "unbelievaboat" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });
    const owner = await createUser();
    const buyerUser = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id, { price: 100, quantity: 5 });
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 1 });
    expect(res.status).toBe(502);
    expect(mockPatch).toHaveBeenCalledTimes(3); // debit, failed credit, refund
    // The refund must return the debited amount to the BUYER (not the seller).
    expect(mockPatch.mock.calls[0][0]).toBe(buyerUser.discordId);
    expect(mockPatch.mock.calls[0][1]).toMatchObject({ cash: -100 });
    expect(mockPatch.mock.calls[2][0]).toBe(buyerUser.discordId);
    expect(mockPatch.mock.calls[2][1]).toMatchObject({ cash: 100 });
    // stock was NOT decremented and no inventory/ledger written
    const [stillStock] = await db.select().from(storeStock).where(eq(storeStock.id, stock.id));
    expect(stillStock.quantity).toBe(5);
    const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, buyer.id));
    expect(inv).toHaveLength(0);
    const ledger = await db.select().from(walletTransactions);
    expect(ledger).toHaveLength(0);
  });

  it("completes a sale: decrements stock, adds inventory, writes both ledger rows", async () => {
    mockGetBalance.mockResolvedValue({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });
    mockPatch.mockResolvedValue({ cash: 900, bank: 0, total: 900, source: "unbelievaboat" });
    const owner = await createUser();
    const buyerUser = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id, { price: 100, quantity: 5 });
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 2 });
    expect(res.status).toBe(200);
    expect(res.body.totalPaid).toBe(200);

    const [updatedStock] = await db.select().from(storeStock).where(eq(storeStock.id, stock.id));
    expect(updatedStock.quantity).toBe(3);

    const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, buyer.id));
    expect(inv).toHaveLength(1);
    expect(inv[0].quantity).toBe(2);
    expect(inv[0].pricePaid).toBe(200);

    const ledger = await db.select().from(walletTransactions);
    // one debit (-200) for the buyer, one credit (+200) for the seller
    expect(ledger.filter((l) => l.amount === -200)).toHaveLength(1);
    expect(ledger.filter((l) => l.amount === 200)).toHaveLength(1);
  });

  it("deletes the stock row when quantity reaches zero", async () => {
    mockGetBalance.mockResolvedValue({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });
    mockPatch.mockResolvedValue({ cash: 900, bank: 0, total: 900, source: "unbelievaboat" });
    const owner = await createUser();
    const buyerUser = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id, { price: 10, quantity: 2 });
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 2 });
    expect(res.status).toBe(200);
    const rows = await db.select().from(storeStock).where(eq(storeStock.id, stock.id));
    expect(rows).toHaveLength(0);
  });
});

async function makeRipperdoc(ownerId: string | null, name = "Vik's Clinic") {
  const [r] = await db.insert(ripperdocs).values({ ownerId: ownerId as string, name }).returning();
  return r;
}

describe("PATCH /stores/:id (staff + owner manage)", () => {
  it("lets the owner edit their own store and persists purpose", async () => {
    const owner = await createUser();
    const store = await makeStore(owner.id);
    const res = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", owner.id)
      .send({ purpose: "Best chrome in town" });
    expect(res.status).toBe(200);
    expect(res.body.purpose).toBe("Best chrome in town");
  });

  it("lets a FIXER edit any store and writes an audit row", async () => {
    const owner = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    const store = await makeStore(owner.id, "Old Name");
    const res = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", fixer.id)
      .send({ name: "New Name" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New Name");
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "store_update"));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("lets an ADMIN edit any store", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const store = await makeStore(owner.id);
    const res = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", admin.id)
      .send({ location: "Watson" });
    expect(res.status).toBe(200);
    expect(res.body.location).toBe("Watson");
  });

  it("lets staff edit the banner image", async () => {
    const owner = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    const store = await makeStore(owner.id);
    const res = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", fixer.id)
      .send({ bannerUrl: "/api/storage/objects/banner-1" });
    expect(res.status).toBe(200);
    expect(res.body.bannerUrl).toBe("/api/storage/objects/banner-1");
  });

  it("403s when a non-owner non-staff user edits a store", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const store = await makeStore(owner.id);
    const res = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", stranger.id)
      .send({ name: "Hijack" });
    expect(res.status).toBe(403);
  });

  it("lets staff reassign ownerId but ignores ownerId from a plain owner", async () => {
    const owner = await createUser();
    const newOwner = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    const store = await makeStore(owner.id);
    // staff reassign succeeds
    const ok = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", fixer.id)
      .send({ ownerId: newOwner.id });
    expect(ok.status).toBe(200);
    expect(ok.body.ownerId).toBe(newOwner.id);
    // the new owner cannot hand it off via ownerId
    const blocked = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", newOwner.id)
      .send({ ownerId: owner.id, name: "Renamed" });
    expect(blocked.status).toBe(200);
    expect(blocked.body.ownerId).toBe(newOwner.id);
  });

  it("404s for a store that does not exist", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const res = await request(app)
      .patch(`/api/stores/999999`)
      .set("x-test-user", fixer.id)
      .send({ name: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("does not write an audit row on a no-op edit", async () => {
    const owner = await createUser();
    const store = await makeStore(owner.id, "Same Name");
    const before = await db.select().from(auditLog).where(eq(auditLog.action, "store_update"));
    const res = await request(app)
      .patch(`/api/stores/${store.id}`)
      .set("x-test-user", owner.id)
      .send({ name: "Same Name" });
    expect(res.status).toBe(200);
    const after = await db.select().from(auditLog).where(eq(auditLog.action, "store_update"));
    expect(after.length).toBe(before.length);
  });
});

describe("DELETE /stores/:id", () => {
  it("lets a FIXER delete any store, cascades stock/employees, and audits", async () => {
    const owner = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    const store = await makeStore(owner.id);
    await makeStock(store.id);
    await db.insert(storeEmployees).values({ storeId: store.id, characterId: (await createCharacter({ ownerId: owner.id })).id });
    const res = await request(app)
      .delete(`/api/stores/${store.id}`)
      .set("x-test-user", fixer.id);
    expect(res.status).toBe(204);
    expect(await db.select().from(stores).where(eq(stores.id, store.id))).toHaveLength(0);
    expect(await db.select().from(storeStock).where(eq(storeStock.storeId, store.id))).toHaveLength(0);
    expect(await db.select().from(storeEmployees).where(eq(storeEmployees.storeId, store.id))).toHaveLength(0);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "store_delete"));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("lets the owner delete their own store", async () => {
    const owner = await createUser();
    const store = await makeStore(owner.id);
    const res = await request(app)
      .delete(`/api/stores/${store.id}`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(204);
  });

  it("403s when a non-owner non-staff user deletes a store", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const store = await makeStore(owner.id);
    const res = await request(app)
      .delete(`/api/stores/${store.id}`)
      .set("x-test-user", stranger.id);
    expect(res.status).toBe(403);
    expect(await db.select().from(stores).where(eq(stores.id, store.id))).toHaveLength(1);
  });
});

describe("PATCH /ripperdocs/:id (staff + owner manage)", () => {
  it("lets a FIXER edit any ripperdoc and writes an audit row", async () => {
    const owner = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    const rip = await makeRipperdoc(owner.id);
    const res = await request(app)
      .patch(`/api/ripperdocs/${rip.id}`)
      .set("x-test-user", fixer.id)
      .send({ purpose: "Cyberware specialist" });
    expect(res.status).toBe(200);
    expect(res.body.purpose).toBe("Cyberware specialist");
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "ripperdoc_update"));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("lets the owner edit their own ripperdoc", async () => {
    const owner = await createUser();
    const rip = await makeRipperdoc(owner.id);
    const res = await request(app)
      .patch(`/api/ripperdocs/${rip.id}`)
      .set("x-test-user", owner.id)
      .send({ location: "Heywood" });
    expect(res.status).toBe(200);
    expect(res.body.location).toBe("Heywood");
  });

  it("403s when a non-owner non-staff user edits a ripperdoc", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const rip = await makeRipperdoc(owner.id);
    const res = await request(app)
      .patch(`/api/ripperdocs/${rip.id}`)
      .set("x-test-user", stranger.id)
      .send({ name: "Hijack" });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /ripperdocs/:id", () => {
  it("lets an ADMIN delete any ripperdoc, cascades stock, and audits", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const rip = await makeRipperdoc(owner.id);
    await db.insert(ripperdocStock).values({ ripperdocId: rip.id, name: "Kiroshi Optics", price: 500, quantity: 3 });
    const res = await request(app)
      .delete(`/api/ripperdocs/${rip.id}`)
      .set("x-test-user", admin.id);
    expect(res.status).toBe(204);
    expect(await db.select().from(ripperdocs).where(eq(ripperdocs.id, rip.id))).toHaveLength(0);
    expect(await db.select().from(ripperdocStock).where(eq(ripperdocStock.ripperdocId, rip.id))).toHaveLength(0);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "ripperdoc_delete"));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("lets the owner delete their own ripperdoc", async () => {
    const owner = await createUser();
    const rip = await makeRipperdoc(owner.id);
    const res = await request(app)
      .delete(`/api/ripperdocs/${rip.id}`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(204);
    expect(await db.select().from(ripperdocs).where(eq(ripperdocs.id, rip.id))).toHaveLength(0);
  });

  it("403s when a non-owner non-staff user deletes a ripperdoc", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const rip = await makeRipperdoc(owner.id);
    const res = await request(app)
      .delete(`/api/ripperdocs/${rip.id}`)
      .set("x-test-user", stranger.id);
    expect(res.status).toBe(403);
  });
});
