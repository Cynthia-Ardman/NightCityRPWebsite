import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));

import {
  db, stores, storeStock, storeEmployees, ripperdocs, ripperdocStock,
  inventoryItems, walletTransactions, characters, auditLog, saleOffers,
  catalogGuns, catalogCyberware, users, botConfig,
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
  mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
});

async function setFlag(key: string, value: boolean) {
  await db
    .insert(botConfig)
    .values({ key, value })
    .onConflictDoUpdate({ target: botConfig.key, set: { value } });
}
async function setEconomyMode(mode: "disabled" | "test" | "enabled") {
  await setFlag("economy_enabled", mode !== "disabled");
  await setFlag("master_live_mode", mode === "enabled");
  await setFlag("economy_live_mode", mode === "enabled");
}
async function fund(userId: string, amount: number) {
  await db.update(users).set({ walletBalance: amount }).where(eq(users.id, userId));
}

async function makeStore(ownerId: string, name = "Chrome Bazaar") {
  const [s] = await db.insert(stores).values({ ownerId, name }).returning();
  return s;
}
async function makeStock(storeId: number, opts: { price?: number; cost?: number; quantity?: number; name?: string } = {}) {
  const [it] = await db
    .insert(storeStock)
    .values({ storeId, name: opts.name ?? "Militech Pistol", price: opts.price ?? 100, cost: opts.cost ?? 0, quantity: opts.quantity ?? 5 })
    .returning();
  return it;
}

describe("POST /stores/:id/sell (charges the buyer instantly)", () => {
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

  it("completes the sale instantly: debits the buyer, moves stock and inventory", async () => {
    await setEconomyMode("enabled");
    const owner = await createUser();
    const buyerUser = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id, { price: 100, quantity: 5 });
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    await fund(buyerUser.id, 1000);
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 2 });
    expect(res.status).toBe(200);
    expect(res.body.offer.status).toBe("approved");
    expect(res.body.offer.kind).toBe("store");
    expect(res.body.offer.quantity).toBe(2);
    expect(res.body.offer.unitPrice).toBe(100);
    expect(res.body.offer.totalPrice).toBe(200);
    expect(res.body.offer.buyerCharacterId).toBe(buyer.id);
    expect(res.body.offer.buyerUserId).toBe(buyerUser.id);

    // Owner sale => no commission attribution.
    expect(res.body.offer.commissionPct).toBe(0);
    expect(res.body.offer.sellerEmployeeId).toBeNull();

    // Stock pulled, item delivered, buyer charged, store credited — all now.
    const [stillStock] = await db.select().from(storeStock).where(eq(storeStock.id, stock.id));
    expect(stillStock.quantity).toBe(3);
    const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, buyer.id));
    expect(inv).toHaveLength(1);
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(800);
    const [st] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(st.balance).toBe(200);
  });

  it("409s without moving anything when the economy is disabled", async () => {
    await setEconomyMode("disabled");
    const owner = await createUser();
    const buyerUser = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id, { price: 100, quantity: 5 });
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    await fund(buyerUser.id, 1000);
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 2 });
    expect(res.status).toBe(409);
    // No dangling pending offer, nothing moved.
    expect(await db.select().from(saleOffers)).toHaveLength(0);
    const [stillStock] = await db.select().from(storeStock).where(eq(storeStock.id, stock.id));
    expect(stillStock.quantity).toBe(5);
    expect(await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, buyer.id))).toHaveLength(0);
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(1000);
  });

  it("snapshots the selling employee's commission percentage on the offer", async () => {
    await setEconomyMode("enabled");
    const owner = await createUser();
    const clerkUser = await createUser();
    const buyerUser = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id, { price: 100, quantity: 5 });
    const clerkChar = await createCharacter({ ownerId: clerkUser.id });
    await db.insert(storeEmployees).values({ storeId: store.id, characterId: clerkChar.id, role: "clerk", commissionPct: 15 });
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    await fund(buyerUser.id, 1000);
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell`)
      .set("x-test-user", clerkUser.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 1 });
    expect(res.status).toBe(200);
    expect(res.body.offer.commissionPct).toBe(15);
    expect(res.body.offer.sellerCharacterId).toBe(clerkChar.id);
  });
});

describe("POST /ripperdocs/:id/sell (charges the buyer instantly)", () => {
  it("completes the cyberware sale instantly: debits the buyer and pulls stock", async () => {
    await setEconomyMode("enabled");
    const owner = await createUser();
    const buyerUser = await createUser();
    const rip = await makeRipperdoc(owner.id);
    const [stock] = await db.insert(ripperdocStock).values({ ripperdocId: rip.id, name: "Kiroshi Optics", price: 500, quantity: 3 }).returning();
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    await fund(buyerUser.id, 1000);
    const res = await request(app)
      .post(`/api/ripperdocs/${rip.id}/sell`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id, qty: 1 });
    expect(res.status).toBe(200);
    expect(res.body.offer.kind).toBe("ripperdoc");
    expect(res.body.offer.status).toBe("approved");
    expect(res.body.offer.totalPrice).toBe(500);
    const [stillStock] = await db.select().from(ripperdocStock).where(eq(ripperdocStock.id, stock.id));
    expect(stillStock.quantity).toBe(2);
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(500);
  });
});

describe("POST /stores/:id/purchase (store-funded catalog restock)", () => {
  it("debits the venue account, merges stock, and writes a ledger row", async () => {
    const owner = await createUser();
    const [store] = await db.insert(stores).values({ ownerId: owner.id, name: "Chrome Bazaar", balance: 1000 }).returning();
    const [gun] = await db.insert(catalogGuns).values({ name: "Militech Pistol", price: 100, wholesalePrice: 40 }).returning();
    const res = await request(app)
      .post(`/api/stores/${store.id}/purchase`)
      .set("x-test-user", owner.id)
      .send({ catalogId: gun.id, qty: 3 });
    expect(res.status).toBe(201);
    expect(res.body.unitCost).toBe(100); // catalog price (no wholesaler discount)
    expect(res.body.totalCost).toBe(300);
    expect(res.body.balance).toBe(700);
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(700);
    const stockRows = await db.select().from(storeStock).where(eq(storeStock.storeId, store.id));
    expect(stockRows).toHaveLength(1);
    expect(stockRows[0].quantity).toBe(3);
    expect(stockRows[0].price).toBe(0); // sale price defaults to 0 (owner sets their markup)
    expect(stockRows[0].cost).toBe(100); // shop cost seeded from the wholesale price they paid
    const ledger = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "stock_purchase"));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount).toBe(-300);
  });

  it("400s and moves nothing when the venue cannot afford the restock", async () => {
    const owner = await createUser();
    const [store] = await db.insert(stores).values({ ownerId: owner.id, name: "Broke Shop", balance: 50 }).returning();
    const [gun] = await db.insert(catalogGuns).values({ name: "Overture", price: 200, wholesalePrice: 120 }).returning();
    const res = await request(app)
      .post(`/api/stores/${store.id}/purchase`)
      .set("x-test-user", owner.id)
      .send({ catalogId: gun.id, qty: 1 });
    expect(res.status).toBe(400);
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(50);
    expect(await db.select().from(storeStock).where(eq(storeStock.storeId, store.id))).toHaveLength(0);
  });

  it("403s when a stranger tries to restock", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const [store] = await db.insert(stores).values({ ownerId: owner.id, name: "Chrome Bazaar", balance: 1000 }).returning();
    const [gun] = await db.insert(catalogGuns).values({ name: "Militech Pistol", price: 100, wholesalePrice: 40 }).returning();
    const res = await request(app)
      .post(`/api/stores/${store.id}/purchase`)
      .set("x-test-user", stranger.id)
      .send({ catalogId: gun.id, qty: 1 });
    expect(res.status).toBe(403);
  });

  it("ripperdoc purchase uses the catalog price and debits the clinic", async () => {
    const owner = await createUser();
    const [rip] = await db.insert(ripperdocs).values({ ownerId: owner.id, name: "Vik's Clinic", balance: 2000 }).returning();
    const [cw] = await db.insert(catalogCyberware).values({ name: "Gorilla Arms", slot: "arms", price: 1000, wholesalePrice: 600 }).returning();
    const res = await request(app)
      .post(`/api/ripperdocs/${rip.id}/purchase`)
      .set("x-test-user", owner.id)
      .send({ catalogId: cw.id, qty: 2 });
    expect(res.status).toBe(201);
    expect(res.body.unitCost).toBe(1000); // catalog price (no wholesaler discount)
    expect(res.body.totalCost).toBe(2000);
    expect(res.body.balance).toBe(0);
    const stockRows = await db.select().from(ripperdocStock).where(eq(ripperdocStock.ripperdocId, rip.id));
    expect(stockRows).toHaveLength(1);
    expect(stockRows[0].quantity).toBe(2);
  });
});

describe("PATCH /stores/:id/employees/:employeeId (commission)", () => {
  it("lets the owner set an employee's commission percentage and audits it", async () => {
    const owner = await createUser();
    const clerk = await createCharacter({ ownerId: owner.id });
    const store = await makeStore(owner.id);
    const [emp] = await db.insert(storeEmployees).values({ storeId: store.id, characterId: clerk.id, role: "clerk", commissionPct: 0 }).returning();
    const res = await request(app)
      .patch(`/api/stores/${store.id}/employees/${emp.id}`)
      .set("x-test-user", owner.id)
      .send({ commissionPct: 20 });
    expect(res.status).toBe(200);
    expect(res.body.commissionPct).toBe(20);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "store_employee_update"));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("clamps commission to 0..100", async () => {
    const owner = await createUser();
    const clerk = await createCharacter({ ownerId: owner.id });
    const store = await makeStore(owner.id);
    const [emp] = await db.insert(storeEmployees).values({ storeId: store.id, characterId: clerk.id, role: "clerk", commissionPct: 0 }).returning();
    const res = await request(app)
      .patch(`/api/stores/${store.id}/employees/${emp.id}`)
      .set("x-test-user", owner.id)
      .send({ commissionPct: 500 });
    expect(res.status).toBe(200);
    expect(res.body.commissionPct).toBe(100);
  });

  it("403s when a stranger edits an employee", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const clerk = await createCharacter({ ownerId: owner.id });
    const store = await makeStore(owner.id);
    const [emp] = await db.insert(storeEmployees).values({ storeId: store.id, characterId: clerk.id, role: "clerk" }).returning();
    const res = await request(app)
      .patch(`/api/stores/${store.id}/employees/${emp.id}`)
      .set("x-test-user", stranger.id)
      .send({ commissionPct: 50 });
    expect(res.status).toBe(403);
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

describe("PATCH /stores/:id/stock/:stockId (manual stock edit is audited)", () => {
  it("404s for an unknown stock row", async () => {
    const owner = await createUser();
    const store = await makeStore(owner.id);
    const res = await request(app)
      .patch(`/api/stores/${store.id}/stock/999999`)
      .set("x-test-user", owner.id)
      .send({ price: 1 });
    expect(res.status).toBe(404);
  });

  it("applies the edit and writes a store_stock_edit audit row with before/after", async () => {
    const owner = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id, { name: "Militech Pistol", price: 100, quantity: 5 });

    const res = await request(app)
      .patch(`/api/stores/${store.id}/stock/${stock.id}`)
      .set("x-test-user", owner.id)
      .send({ price: 250, cost: 120, quantity: 3 });
    expect(res.status).toBe(200);
    expect(res.body.price).toBe(250);
    expect(res.body.cost).toBe(120);
    expect(res.body.quantity).toBe(3);

    const [row] = await db.select().from(storeStock).where(eq(storeStock.id, stock.id));
    expect(row.price).toBe(250);
    expect(row.cost).toBe(120);
    expect(row.quantity).toBe(3);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "store_stock_edit"));
    expect(audits.length).toBe(1);
    expect(audits[0].category).toBe("shop");
    expect(audits[0].targetId).toBe(String(store.id));
    expect((audits[0].beforeJson as Record<string, unknown>).price).toBe(100);
    expect((audits[0].afterJson as Record<string, unknown>).price).toBe(250);
  });

  it("400s on a no-op edit and writes no audit row", async () => {
    const owner = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id);
    const res = await request(app)
      .patch(`/api/stores/${store.id}/stock/${stock.id}`)
      .set("x-test-user", owner.id)
      .send({});
    expect(res.status).toBe(400);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "store_stock_edit"));
    expect(audits.length).toBe(0);
  });

  it("coerces malformed/negative numeric input to a safe non-negative integer", async () => {
    const owner = await createUser();
    const store = await makeStore(owner.id);
    const stock = await makeStock(store.id, { price: 100, quantity: 5 });
    const res = await request(app)
      .patch(`/api/stores/${store.id}/stock/${stock.id}`)
      .set("x-test-user", owner.id)
      .send({ price: "abc", quantity: -10 });
    expect(res.status).toBe(200);
    expect(res.body.price).toBe(0);
    expect(res.body.quantity).toBe(0);
  });
});

describe("PATCH /ripperdocs/:id/stock/:stockId (manual clinic stock edit is audited)", () => {
  it("403s when the actor is not the owner or staff", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const rip = await makeRipperdoc(owner.id);
    const [stock] = await db
      .insert(ripperdocStock)
      .values({ ripperdocId: rip.id, name: "Kiroshi Optics", price: 500, quantity: 3 })
      .returning();
    const res = await request(app)
      .patch(`/api/ripperdocs/${rip.id}/stock/${stock.id}`)
      .set("x-test-user", stranger.id)
      .send({ cost: 300 });
    expect(res.status).toBe(403);
    const [row] = await db.select().from(ripperdocStock).where(eq(ripperdocStock.id, stock.id));
    expect(row.cost).toBe(0);
  });

  it("404s for an unknown stock row", async () => {
    const owner = await createUser();
    const rip = await makeRipperdoc(owner.id);
    const res = await request(app)
      .patch(`/api/ripperdocs/${rip.id}/stock/999999`)
      .set("x-test-user", owner.id)
      .send({ cost: 1 });
    expect(res.status).toBe(404);
  });

  it("applies a cost edit and writes a ripperdoc_stock_edit audit row with before/after", async () => {
    const owner = await createUser();
    const rip = await makeRipperdoc(owner.id);
    const [stock] = await db
      .insert(ripperdocStock)
      .values({ ripperdocId: rip.id, name: "Kiroshi Optics", price: 500, cost: 0, quantity: 3 })
      .returning();

    const res = await request(app)
      .patch(`/api/ripperdocs/${rip.id}/stock/${stock.id}`)
      .set("x-test-user", owner.id)
      .send({ cost: 300 });
    expect(res.status).toBe(200);
    expect(res.body.cost).toBe(300);

    const [row] = await db.select().from(ripperdocStock).where(eq(ripperdocStock.id, stock.id));
    expect(row.cost).toBe(300);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "ripperdoc_stock_edit"));
    expect(audits.length).toBe(1);
    expect(audits[0].category).toBe("shop");
    expect(audits[0].targetId).toBe(String(rip.id));
    expect((audits[0].beforeJson as Record<string, unknown>).cost).toBe(0);
    expect((audits[0].afterJson as Record<string, unknown>).cost).toBe(300);
  });

  it("400s on a no-op edit and writes no audit row", async () => {
    const owner = await createUser();
    const rip = await makeRipperdoc(owner.id);
    const [stock] = await db
      .insert(ripperdocStock)
      .values({ ripperdocId: rip.id, name: "Kiroshi Optics", price: 500, quantity: 3 })
      .returning();
    const res = await request(app)
      .patch(`/api/ripperdocs/${rip.id}/stock/${stock.id}`)
      .set("x-test-user", owner.id)
      .send({});
    expect(res.status).toBe(400);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "ripperdoc_stock_edit"));
    expect(audits.length).toBe(0);
  });
});
