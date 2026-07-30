import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));
vi.mock("../lib/discord", async (orig) => {
  const actual = await orig<typeof import("../lib/discord")>();
  return { ...actual, sendDirectMessage: vi.fn().mockResolvedValue(undefined) };
});

import {
  db,
  stores,
  storeStock,
  storeEmployees,
  inventoryItems,
  saleOffers,
  customRequests,
  botConfig,
  users,
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
  await db.insert(botConfig).values({ key, value }).onConflictDoUpdate({ target: botConfig.key, set: { value } });
}
async function enableLiveEconomy() {
  await setFlag("economy_enabled", true);
  await setFlag("master_live_mode", true);
  await setFlag("economy_live_mode", true);
}

// Gun store + owner character. kind:'guns' is what unlocks the endpoint.
async function seedGunStore() {
  const owner = await createUser();
  const ownerChar = await createCharacter({ ownerId: owner.id });
  const [store] = await db
    .insert(stores)
    .values({ ownerId: owner.id, ownerCharacterId: ownerChar.id, name: "Lead Farewell", kind: "guns", balance: 0 })
    .returning();
  return { owner, ownerChar, store };
}

function createFixer() {
  return createUser({ roles: ["fixer", "cs approver"] });
}

async function submitGunRequest(
  storeId: number,
  actorId: string,
  body: Record<string, unknown> = {},
) {
  return request(app)
    .post(`/api/stores/${storeId}/gun-requests`)
    .set("x-test-user", actorId)
    .send({ name: "Malorian 3516", description: "Silverhand special", ...body });
}

// Admin-override the request to approved, then close it (materialize).
async function approveAndClose(reqId: number, closeParams: Record<string, unknown> = {}) {
  const admin = await createAdmin();
  const ov = await request(app).post(`/api/requests/${reqId}/override`).set("x-test-user", admin.id).send({});
  expect(ov.status).toBe(200);
  const close = await request(app)
    .post(`/api/review/request/${reqId}/close`)
    .set("x-test-user", admin.id)
    .send(closeParams);
  return close;
}

describe("POST /stores/:id/gun-requests — submission gates", () => {
  it("403s a non-operator and 400s a non-gun store", async () => {
    const { store } = await seedGunStore();
    const stranger = await createUser();
    const res = await submitGunRequest(store.id, stranger.id);
    expect(res.status).toBe(403);

    const other = await createUser();
    const [gearStore] = await db
      .insert(stores)
      .values({ ownerId: other.id, name: "Gear Shed", kind: "gear", balance: 0 })
      .returning();
    const res2 = await submitGunRequest(gearStore.id, other.id);
    expect(res2.status).toBe(400);
  });

  it("lets an employee submit; the request carries storeId + specs + buyer + price", async () => {
    const { store } = await seedGunStore();
    const clerkUser = await createUser();
    const clerkChar = await createCharacter({ ownerId: clerkUser.id });
    await db.insert(storeEmployees).values({ storeId: store.id, characterId: clerkChar.id, role: "clerk" });
    const buyerUser = await createUser();
    const buyer = await createCharacter({ ownerId: buyerUser.id });

    const res = await submitGunRequest(store.id, clerkUser.id, {
      category: "Tech",
      weaponType: "Pistol",
      fireMode: "Semi-Auto",
      powerLevel: "H",
      manufacturer: "Malorian Arms",
      buyerCharacterId: buyer.id,
      salePrice: 7777,
    });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, res.body.id));
    expect(row.type).toBe("gun");
    // Attributed to the BUYER character so the buyer sees it on My Submissions.
    expect(row.characterId).toBe(buyer.id);
    const det = row.details as Record<string, unknown>;
    expect(det.storeId).toBe(store.id);
    expect(det.salePrice).toBe(7777);
    expect((det.specs as Record<string, unknown>).powerLevel).toBe("H");
  });

  it("rejects an archived buyer and a negative price", async () => {
    const { owner, store } = await seedGunStore();
    const buyerUser = await createUser();
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    await db.execute(
      // raw update to avoid importing characters here
      (await import("drizzle-orm")).sql`UPDATE characters SET archived = true WHERE id = ${buyer.id}`,
    );
    const res = await submitGunRequest(store.id, owner.id, { buyerCharacterId: buyer.id });
    expect(res.status).toBe(400);

    const res2 = await submitGunRequest(store.id, owner.id, { salePrice: -5 });
    expect(res2.status).toBe(400);
  });
});

describe("close & apply — store stock materialization", () => {
  it("stocks the gun at the store (not a character inventory), using details.specs as close defaults", async () => {
    const { owner, store } = await seedGunStore();
    const res = await submitGunRequest(store.id, owner.id, {
      category: "Power",
      weaponType: "Revolver",
      fireMode: "Semi-Auto",
      powerLevel: "M",
      salePrice: 1200,
    });
    expect(res.status).toBe(201);

    // Close WITHOUT params — specs from the submission must carry it.
    const close = await approveAndClose(res.body.id);
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");

    const stock = await db.select().from(storeStock).where(eq(storeStock.storeId, store.id));
    expect(stock).toHaveLength(1);
    expect(stock[0].name).toBe("Malorian 3516");
    expect(stock[0].category).toBe("Power");
    expect(stock[0].powerLevel).toBe("M");
    expect(stock[0].price).toBe(1200);
    expect(stock[0].quantity).toBe(1);
    expect(await db.select().from(inventoryItems)).toHaveLength(0);
    // No buyer named -> no offer.
    expect(await db.select().from(saleOffers)).toHaveLength(0);

    const [reqRow] = await db.select().from(customRequests).where(eq(customRequests.id, res.body.id));
    expect(reqRow.appliedRef).toBe(`store_stock:${stock[0].id}`);
  });

  it("with buyer + price, creates a PENDING sale offer the buyer can approve and pay", async () => {
    await enableLiveEconomy();
    const { owner, store } = await seedGunStore();
    const buyerUser = await createUser();
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    await db.update(users).set({ walletBalance: 10_000 }).where(eq(users.id, buyerUser.id));
    mockGetBalance.mockResolvedValue({ cash: 10_000, bank: 0, total: 10_000, source: "unbelievaboat" });

    const res = await submitGunRequest(store.id, owner.id, {
      category: "Smart",
      weaponType: "SMG",
      fireMode: "Full-Auto",
      powerLevel: "H",
      buyerCharacterId: buyer.id,
      salePrice: 2500,
    });
    expect(res.status).toBe(201);
    const close = await approveAndClose(res.body.id);
    expect(close.status).toBe(200);

    const offers = await db.select().from(saleOffers);
    expect(offers).toHaveLength(1);
    expect(offers[0].status).toBe("pending");
    expect(offers[0].buyerCharacterId).toBe(buyer.id);
    expect(offers[0].totalPrice).toBe(2500);
    expect(offers[0].storeId).toBe(store.id);

    // Buyer approves from their Inbox -> charged, stock moves to inventory.
    const approve = await request(app)
      .post(`/api/offers/${offers[0].id}/approve`)
      .set("x-test-user", buyerUser.id)
      .send({});
    expect(approve.status).toBe(200);
    const [after] = await db.select().from(saleOffers).where(eq(saleOffers.id, offers[0].id));
    expect(after.status).toBe("approved");
    const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, buyer.id));
    expect(inv).toHaveLength(1);
    // Stock is consumed: the row is either decremented to 0 or removed entirely.
    const stockAfter = await db.select().from(storeStock).where(eq(storeStock.storeId, store.id));
    expect(stockAfter.length === 0 || stockAfter[0].quantity === 0).toBe(true);
  });

  it("still stocks the gun (no offer) when the named buyer had no sale price", async () => {
    const { owner, store } = await seedGunStore();
    const buyerUser = await createUser();
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    const res = await submitGunRequest(store.id, owner.id, {
      category: "Tech",
      weaponType: "Rifle",
      fireMode: "Burst",
      powerLevel: "M",
      buyerCharacterId: buyer.id,
    });
    const close = await approveAndClose(res.body.id);
    expect(close.status).toBe(200);
    expect(await db.select().from(storeStock).where(eq(storeStock.storeId, store.id))).toHaveLength(1);
    expect(await db.select().from(saleOffers)).toHaveLength(0);
  });
});

describe("visibility", () => {
  it("the named buyer sees the request on GET /requests/mine", async () => {
    const { owner, store } = await seedGunStore();
    const buyerUser = await createUser();
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    const res = await submitGunRequest(store.id, owner.id, { buyerCharacterId: buyer.id, salePrice: 100 });
    expect(res.status).toBe(201);

    const mine = await request(app).get("/api/requests/mine").set("x-test-user", buyerUser.id);
    expect(mine.status).toBe(200);
    expect((mine.body as Array<{ id: number }>).some((r) => r.id === res.body.id)).toBe(true);
  });

  it("buyer and fellow store operators can read the review thread; strangers cannot", async () => {
    const { owner, store } = await seedGunStore();
    const clerkUser = await createUser();
    const clerkChar = await createCharacter({ ownerId: clerkUser.id });
    await db.insert(storeEmployees).values({ storeId: store.id, characterId: clerkChar.id, role: "clerk" });
    const buyerUser = await createUser();
    const buyer = await createCharacter({ ownerId: buyerUser.id });
    const res = await submitGunRequest(store.id, owner.id, { buyerCharacterId: buyer.id, salePrice: 100 });
    expect(res.status).toBe(201);

    for (const uid of [buyerUser.id, clerkUser.id, owner.id]) {
      const r = await request(app).get(`/api/review/request/${res.body.id}/comments`).set("x-test-user", uid);
      expect(r.status).toBe(200);
    }
    const stranger = await createUser();
    const r = await request(app).get(`/api/review/request/${res.body.id}/comments`).set("x-test-user", stranger.id);
    expect(r.status).toBe(403);
  });
});
