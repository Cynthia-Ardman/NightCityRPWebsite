import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));

import {
  db, stores, storeStock, inventoryItems, walletTransactions, characters,
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
    // stock was NOT decremented and no inventory/ledger written
    const [stillStock] = await db.select().from(storeStock).where(eq(storeStock.id, stock.id));
    expect(stillStock.quantity).toBe(5);
    const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, buyer.id));
    expect(inv).toHaveLength(0);
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
