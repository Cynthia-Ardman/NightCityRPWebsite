import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));

import {
  db, stores, storeStock, wholesalerItems, wholesalerOrders, walletTransactions,
} from "@workspace/db";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockGetBalance = vi.mocked(getBalance);
const mockPatch = vi.mocked(patchBalance);

beforeEach(() => {
  mockGetBalance.mockReset();
  mockPatch.mockReset();
});

function createFixer(opts: { id?: string } = {}) {
  return createUser({ ...opts, roles: ["fixer"] });
}
async function makeItem(opts: { wholesalePrice?: number; cap?: number | null; tier?: string; archived?: boolean } = {}) {
  const [row] = await db
    .insert(wholesalerItems)
    .values({
      name: "Bulk Ammo",
      tier: opts.tier ?? "store",
      wholesalePrice: opts.wholesalePrice ?? 50,
      suggestedRetailPrice: 120,
      cap: opts.cap === undefined ? null : opts.cap,
      archived: opts.archived ?? false,
    })
    .returning();
  return row;
}
async function makeStore(ownerId: string) {
  const [s] = await db.insert(stores).values({ ownerId, name: "Fixer Outpost" }).returning();
  return s;
}

describe("POST /wholesaler/restock", () => {
  it("403s for a non-fixer/non-admin user", async () => {
    const user = await createUser();
    const store = await makeStore(user.id);
    const item = await makeItem();
    const res = await request(app)
      .post("/api/wholesaler/restock")
      .set("x-test-user", user.id)
      .send({ wholesalerItemId: item.id, quantity: 1, targetKind: "store", targetStoreId: store.id });
    expect(res.status).toBe(403);
  });

  it("400s on missing fields", async () => {
    const fixer = await createFixer();
    const res = await request(app)
      .post("/api/wholesaler/restock")
      .set("x-test-user", fixer.id)
      .send({ quantity: 1 });
    expect(res.status).toBe(400);
  });

  it("400s on a tier mismatch (store item ordered for a clinic)", async () => {
    const fixer = await createFixer();
    const store = await makeStore(fixer.id);
    const item = await makeItem({ tier: "store" });
    const res = await request(app)
      .post("/api/wholesaler/restock")
      .set("x-test-user", fixer.id)
      .send({ wholesalerItemId: item.id, quantity: 1, targetKind: "ripperdoc", targetStoreId: store.id });
    expect(res.status).toBe(400);
  });

  it("409s when the wholesaler cap would be exceeded", async () => {
    const fixer = await createFixer();
    const store = await makeStore(fixer.id);
    const item = await makeItem({ cap: 3 });
    await db.insert(wholesalerOrders).values({
      wholesalerItemId: item.id, fixerId: fixer.id, storeId: store.id,
      quantity: 2, unitWholesalePrice: 50, totalCost: 100,
    });
    const res = await request(app)
      .post("/api/wholesaler/restock")
      .set("x-test-user", fixer.id)
      .send({ wholesalerItemId: item.id, quantity: 2, targetKind: "store", targetStoreId: store.id });
    expect(res.status).toBe(409);
  });

  it("403s when the fixer does not own/work the target store", async () => {
    const fixer = await createFixer();
    const otherOwner = await createUser();
    const store = await makeStore(otherOwner.id);
    const item = await makeItem();
    const res = await request(app)
      .post("/api/wholesaler/restock")
      .set("x-test-user", fixer.id)
      .send({ wholesalerItemId: item.id, quantity: 1, targetKind: "store", targetStoreId: store.id });
    expect(res.status).toBe(403);
  });

  it("400s when the fixer cannot afford the wholesale order", async () => {
    mockGetBalance.mockResolvedValue({ cash: 10, bank: 0, total: 10, source: "unbelievaboat" });
    const fixer = await createFixer();
    const store = await makeStore(fixer.id);
    const item = await makeItem({ wholesalePrice: 50 });
    const res = await request(app)
      .post("/api/wholesaler/restock")
      .set("x-test-user", fixer.id)
      .send({ wholesalerItemId: item.id, quantity: 2, targetKind: "store", targetStoreId: store.id });
    expect(res.status).toBe(400);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("502s with no order/stock/ledger side effects when the wallet provider is unavailable", async () => {
    mockGetBalance.mockResolvedValue(null);
    const fixer = await createFixer();
    const store = await makeStore(fixer.id);
    const item = await makeItem({ wholesalePrice: 50 });
    const res = await request(app)
      .post("/api/wholesaler/restock")
      .set("x-test-user", fixer.id)
      .send({ wholesalerItemId: item.id, quantity: 2, targetKind: "store", targetStoreId: store.id });
    expect(res.status).toBe(502);
    expect(mockPatch).not.toHaveBeenCalled();
    expect(await db.select().from(wholesalerOrders)).toHaveLength(0);
    expect(await db.select().from(storeStock)).toHaveLength(0);
    expect(await db.select().from(walletTransactions)).toHaveLength(0);
  });

  it("502s with no order/stock/ledger side effects when the debit is rejected", async () => {
    mockGetBalance.mockResolvedValue({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });
    mockPatch.mockResolvedValue(null);
    const fixer = await createFixer();
    const store = await makeStore(fixer.id);
    const item = await makeItem({ wholesalePrice: 50 });
    const res = await request(app)
      .post("/api/wholesaler/restock")
      .set("x-test-user", fixer.id)
      .send({ wholesalerItemId: item.id, quantity: 2, targetKind: "store", targetStoreId: store.id });
    expect(res.status).toBe(502);
    expect(mockPatch).toHaveBeenCalledTimes(1); // debit attempted, rejected; no refund needed
    expect(await db.select().from(wholesalerOrders)).toHaveLength(0);
    expect(await db.select().from(storeStock)).toHaveLength(0);
    expect(await db.select().from(walletTransactions)).toHaveLength(0);
  });

  it("completes a restock: pushes stock, records the order + ledger", async () => {
    mockGetBalance.mockResolvedValue({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });
    mockPatch.mockResolvedValue({ cash: 900, bank: 0, total: 900, source: "unbelievaboat" });
    const fixer = await createFixer();
    const store = await makeStore(fixer.id);
    const item = await makeItem({ wholesalePrice: 50 });
    const res = await request(app)
      .post("/api/wholesaler/restock")
      .set("x-test-user", fixer.id)
      .send({ wholesalerItemId: item.id, quantity: 4, targetKind: "store", targetStoreId: store.id });
    expect(res.status).toBe(200);
    expect(res.body.totalCost).toBe(200);

    const stock = await db.select().from(storeStock).where(eq(storeStock.storeId, store.id));
    expect(stock).toHaveLength(1);
    expect(stock[0].quantity).toBe(4);
    expect(stock[0].price).toBe(120); // suggestedRetailPrice

    const orders = await db.select().from(wholesalerOrders).where(eq(wholesalerOrders.wholesalerItemId, item.id));
    expect(orders).toHaveLength(1);
    expect(orders[0].totalCost).toBe(200);

    const ledger = await db.select().from(walletTransactions);
    expect(ledger.filter((l) => l.amount === -200)).toHaveLength(1);
  });

  it("merges into an existing same-name stock row instead of duplicating", async () => {
    mockGetBalance.mockResolvedValue({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });
    mockPatch.mockResolvedValue({ cash: 900, bank: 0, total: 900, source: "unbelievaboat" });
    const fixer = await createFixer();
    const store = await makeStore(fixer.id);
    const item = await makeItem({ wholesalePrice: 50 });
    await db.insert(storeStock).values({ storeId: store.id, name: item.name, price: 99, quantity: 3 });
    const res = await request(app)
      .post("/api/wholesaler/restock")
      .set("x-test-user", fixer.id)
      .send({ wholesalerItemId: item.id, quantity: 2, targetKind: "store", targetStoreId: store.id });
    expect(res.status).toBe(200);
    const stock = await db.select().from(storeStock).where(eq(storeStock.storeId, store.id));
    expect(stock).toHaveLength(1);
    expect(stock[0].quantity).toBe(5); // 3 existing + 2 new
    expect(stock[0].price).toBe(99); // existing price preserved
  });
});
