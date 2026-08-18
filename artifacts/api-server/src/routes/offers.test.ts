import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";

vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));
vi.mock("../lib/discord", async (orig) => {
  const actual = await orig<typeof import("../lib/discord")>();
  return { ...actual, sendDirectMessage: vi.fn().mockResolvedValue(undefined) };
});

import {
  db, stores, ripperdocs, storeStock, ripperdocStock, storeEmployees,
  inventoryItems, walletTransactions, characters, users, saleOffers, botConfig,
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
// mode: "disabled" | "test" | "enabled"
async function setEconomyMode(mode: "disabled" | "test" | "enabled") {
  await setFlag("economy_enabled", mode !== "disabled");
  await setFlag("master_live_mode", mode === "enabled");
  await setFlag("economy_live_mode", mode === "enabled");
}

async function fund(userId: string, amount: number) {
  await db.update(users).set({ walletBalance: amount }).where(eq(users.id, userId));
}

// Build a store + claimed buyer + a pending offer, returning the pieces.
async function seedStoreOffer(opts: { price?: number; cost?: number; qty?: number; stockQty?: number; commissionPct?: number } = {}) {
  const owner = await createUser();
  const buyerUser = await createUser();
  const [store] = await db.insert(stores).values({ ownerId: owner.id, name: "Chrome Bazaar", balance: 0 }).returning();
  const [stock] = await db
    .insert(storeStock)
    .values({ storeId: store.id, name: "Militech Pistol", price: opts.price ?? 100, cost: opts.cost ?? 0, quantity: opts.stockQty ?? 5 })
    .returning();
  const buyer = await createCharacter({ ownerId: buyerUser.id });

  let actorId = owner.id;
  let sellerCharacterId: number | null = null;
  let sellerEmployeeId: number | null = null;
  let commissionPct = 0;
  let clerkUser: Awaited<ReturnType<typeof createUser>> | undefined;
  if (opts.commissionPct && opts.commissionPct > 0) {
    clerkUser = await createUser();
    const clerkChar = await createCharacter({ ownerId: clerkUser.id });
    const [emp] = await db
      .insert(storeEmployees)
      .values({ storeId: store.id, characterId: clerkChar.id, role: "clerk", commissionPct: opts.commissionPct })
      .returning();
    actorId = clerkUser.id;
    sellerCharacterId = clerkChar.id;
    sellerEmployeeId = emp.id;
    commissionPct = opts.commissionPct;
  }

  const qty = opts.qty ?? 1;
  const unitPrice = opts.price ?? 100;
  const [offer] = await db
    .insert(saleOffers)
    .values({
      kind: "store",
      storeId: store.id,
      stockId: stock.id,
      itemName: stock.name,
      itemCategory: null,
      unitPrice,
      quantity: qty,
      totalPrice: unitPrice * qty,
      costBasis: (opts.cost ?? 0) * qty,
      buyerCharacterId: buyer.id,
      buyerUserId: buyerUser.id,
      sellerCharacterId,
      sellerEmployeeId,
      commissionPct,
      createdById: actorId,
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning();

  return { owner, buyerUser, store, stock, buyer, offer, clerkUser };
}

describe("POST /offers/:id/approve", () => {
  it("403s when a non-buyer non-admin tries to approve", async () => {
    await setEconomyMode("enabled");
    const stranger = await createUser();
    const { offer } = await seedStoreOffer();
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", stranger.id);
    expect(res.status).toBe(403);
  });

  it("409s when the economy is disabled (offer left pending)", async () => {
    await setEconomyMode("disabled");
    const { offer, buyerUser } = await seedStoreOffer();
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(409);
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(fresh.status).toBe("pending");
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("returns a dry-run preview in Test mode and leaves the offer pending", async () => {
    await setEconomyMode("test");
    const { offer, buyerUser } = await seedStoreOffer({ price: 100, qty: 2, commissionPct: 10 });
    await fund(buyerUser.id, 1000);
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.wouldDebitBuyer).toBe(200);
    expect(res.body.wouldCreditStore).toBe(200);
    expect(res.body.wouldPayCommission).toBe(20);
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(fresh.status).toBe("pending");
    expect(mockPatch).not.toHaveBeenCalled();
    expect(await db.select().from(inventoryItems)).toHaveLength(0);
  });

  it("400s when the buyer cannot afford the purchase", async () => {
    await setEconomyMode("enabled");
    const { offer, buyerUser } = await seedStoreOffer({ price: 100, qty: 1 });
    await fund(buyerUser.id, 50);
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(400);
    expect(mockPatch).not.toHaveBeenCalled();
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(fresh.status).toBe("pending");
  });

  it("completes the sale even when UnbelievaBoat is unreachable (website wallet authoritative)", async () => {
    await setEconomyMode("enabled");
    // UB down: the website wallet is the source of truth, so the sale still
    // commits and the mirror push waits in the outbox.
    mockPatch.mockResolvedValue(null);
    const { offer, buyerUser } = await seedStoreOffer({ price: 100, qty: 1 });
    await fund(buyerUser.id, 1000);
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(fresh.status).toBe("approved");
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(900);
  });

  it("completes the sale: debits buyer, decrements stock, adds inventory, credits the store", async () => {
    await setEconomyMode("enabled");
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const { offer, buyerUser, store, stock } = await seedStoreOffer({ price: 100, qty: 2, stockQty: 5 });
    await fund(buyerUser.id, 1000);
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.offer.status).toBe("approved");
    expect(res.body.venueBalance).toBe(200);

    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(200);
    const [stk] = await db.select().from(storeStock).where(eq(storeStock.id, stock.id));
    expect(stk.quantity).toBe(3);
    const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, offer.buyerCharacterId));
    expect(inv).toHaveLength(1);
    expect(inv[0].quantity).toBe(2);
    expect(inv[0].pricePaid).toBe(200);
    // buyer website wallet was debited by the delta
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(800);
  });

  it("takes commission from PROFIT (price − cost), not the full sale price", async () => {
    await setEconomyMode("enabled");
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    // User's example: cost 4000, sells 5000, 50% commission.
    // profit = 1000 → commission = 500; store nets 5000 − 500 = 4500.
    const { offer, buyerUser, store, clerkUser } = await seedStoreOffer({ price: 5000, cost: 4000, qty: 1, commissionPct: 50 });
    await fund(buyerUser.id, 10000);
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.commissionPaid).toBe(500);
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(4500);
    const [offerRow] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(offerRow.commissionAmount).toBe(500);
    const [cu] = await db.select().from(users).where(eq(users.id, clerkUser!.id));
    expect(cu.walletBalance).toBe(500);
  });

  it("floors the commission down to the nearest integer on fractional profit", async () => {
    await setEconomyMode("enabled");
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    // profit = 13 − 10 = 3, 50% → 1.5 → floor 1; store nets 13 − 1 = 12.
    const { offer, buyerUser, store } = await seedStoreOffer({ price: 13, cost: 10, qty: 1, commissionPct: 50 });
    await fund(buyerUser.id, 1000);
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.commissionPaid).toBe(1);
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(12);
  });

  it("pays no commission when the item sells at or below cost (profit floored at zero)", async () => {
    await setEconomyMode("enabled");
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    // cost 100 == price 100 → zero profit → zero commission, store keeps full price.
    const { offer, buyerUser, store } = await seedStoreOffer({ price: 100, cost: 100, qty: 2, commissionPct: 25 });
    await fund(buyerUser.id, 1000);
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.commissionPaid).toBe(0);
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(200);
  });

  it("pays the selling employee's commission exactly once and nets it from the store (zero cost → full price is profit)", async () => {
    await setEconomyMode("enabled");
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const { offer, buyerUser, store, clerkUser } = await seedStoreOffer({ price: 100, qty: 2, commissionPct: 25 });
    await fund(buyerUser.id, 1000);
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    // total 200, cost 0 → profit 200, commission 25% = 50
    expect(res.body.commissionPaid).toBe(50);
    // store keeps total minus commission
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(150);
    const [offerRow] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(offerRow.commissionAmount).toBe(50);
    expect(offerRow.commissionSettledAt).not.toBeNull();
    // employee wallet credited once
    const [cu] = await db.select().from(users).where(eq(users.id, clerkUser!.id));
    expect(cu.walletBalance).toBe(50);
    const commissionLedger = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "commission"));
    // one credit to the employee (+50) and one venue debit (-50)
    expect(commissionLedger.filter((l) => l.amount === 50)).toHaveLength(1);
    expect(commissionLedger.filter((l) => l.amount === -50)).toHaveLength(1);
  });

  it("holds the commission reservation when the employee credit fails (money conserved, no minting)", async () => {
    await setEconomyMode("enabled");
    const { offer, buyerUser, store, clerkUser } = await seedStoreOffer({ price: 100, qty: 2, commissionPct: 25 });
    await fund(buyerUser.id, 1000);
    // Force the employee's +50 commission credit to fail: their website wallet
    // sits so close to the max balance that the credit would overflow it.
    await fund(clerkUser!.id, 2_147_483_620);

    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    // The sale completes; the commission is reserved but not yet paid out.
    expect(res.status).toBe(200);
    expect(res.body.commissionPaid).toBe(0);

    // Venue is debited for the reserved commission (200 sale - 50 reserved = 150).
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(150);
    // Reservation is HELD (not reversed) so a later approve can pay it.
    const [offerRow] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(offerRow.status).toBe("approved");
    expect(offerRow.commissionSettledAt).not.toBeNull();
    expect(offerRow.commissionAmount).toBe(50);
    // Employee was NOT paid (the failed credit changed nothing).
    const [cu] = await db.select().from(users).where(eq(users.id, clerkUser!.id));
    expect(cu.walletBalance).toBe(2_147_483_620);
    // Buyer was still charged for the purchase.
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(800);
  });

  it("recovers an unpaid commission on a later approve, without re-debiting the venue (deterministic retry)", async () => {
    await setEconomyMode("enabled");
    // First approve: buyer debit succeeds, commission credit fails (the
    // employee wallet is pinned at near-max so +50 would overflow) -> held.
    const { offer, buyerUser, store, clerkUser } = await seedStoreOffer({ price: 100, qty: 2, commissionPct: 25 });
    await fund(buyerUser.id, 1000);
    await fund(clerkUser!.id, 2_147_483_620);

    const first = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(first.status).toBe(200);
    expect(first.body.commissionPaid).toBe(0);
    const [afterFail] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(afterFail.balance).toBe(150);

    // Credit can succeed on retry: a re-approve recovers the held commission.
    await fund(clerkUser!.id, 0);
    const retry = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(retry.status).toBe(200);
    expect(retry.body.recovered).toBe(true);
    expect(retry.body.commissionPaid).toBe(50);

    // Venue is NOT debited a second time (reserve guard): stays at 150.
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(150);
    // Employee is now paid exactly once.
    const [cu] = await db.select().from(users).where(eq(users.id, clerkUser!.id));
    expect(cu.walletBalance).toBe(50);
    // Buyer is not re-charged on the recovery approve.
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(800);
  });

  it("reports 'already approved' when re-approving a fully-paid offer (no double commission)", async () => {
    await setEconomyMode("enabled");
    mockPatch.mockReset();
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const { offer, buyerUser, store, clerkUser } = await seedStoreOffer({ price: 100, qty: 2, commissionPct: 25 });
    await fund(buyerUser.id, 1000);

    const first = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(first.status).toBe(200);
    expect(first.body.commissionPaid).toBe(50);

    const second = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(second.status).toBe(409);

    // No second commission payout.
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(150);
    const [cu] = await db.select().from(users).where(eq(users.id, clerkUser!.id));
    expect(cu.walletBalance).toBe(50);
  });

  it("is idempotent: a second approve does not double-apply", async () => {
    await setEconomyMode("enabled");
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const { offer, buyerUser, store, stock } = await seedStoreOffer({ price: 100, qty: 1, stockQty: 5 });
    await fund(buyerUser.id, 1000);
    const first = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(first.status).toBe(200);
    const second = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    // second attempt: offer no longer pending => 409 already approved
    expect(second.status).toBe(409);

    // exactly one purchase applied
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(100);
    const [stk] = await db.select().from(storeStock).where(eq(storeStock.id, stock.id));
    expect(stk.quantity).toBe(4);
    const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, offer.buyerCharacterId));
    expect(inv).toHaveLength(1);
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(900);
  });

  it("409s and moves nothing when the offer has expired", async () => {
    await setEconomyMode("enabled");
    const { offer, buyerUser } = await seedStoreOffer({ price: 100, qty: 1 });
    await fund(buyerUser.id, 1000);
    await db.update(saleOffers).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(saleOffers.id, offer.id));
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(409);
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(fresh.status).toBe("expired");
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("admin may approve on the buyer's behalf", async () => {
    await setEconomyMode("enabled");
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const admin = await createAdmin();
    const { offer, buyerUser } = await seedStoreOffer({ price: 100, qty: 1 });
    await fund(buyerUser.id, 1000);
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", admin.id);
    expect(res.status).toBe(200);
  });
});

describe("POST /offers/:id/deny", () => {
  it("flips the offer to denied and moves no money or stock", async () => {
    const { offer, buyerUser, stock } = await seedStoreOffer({ price: 100, qty: 1, stockQty: 5 });
    const res = await request(app).post(`/api/offers/${offer.id}/deny`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("denied");
    const [stk] = await db.select().from(storeStock).where(eq(storeStock.id, stock.id));
    expect(stk.quantity).toBe(5);
    expect(await db.select().from(walletTransactions)).toHaveLength(0);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("403s when a stranger denies", async () => {
    const stranger = await createUser();
    const { offer } = await seedStoreOffer();
    const res = await request(app).post(`/api/offers/${offer.id}/deny`).set("x-test-user", stranger.id);
    expect(res.status).toBe(403);
  });

  it("409s when the offer is no longer pending", async () => {
    const { offer, buyerUser } = await seedStoreOffer();
    await db.update(saleOffers).set({ status: "denied" }).where(eq(saleOffers.id, offer.id));
    const res = await request(app).post(`/api/offers/${offer.id}/deny`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(409);
  });
});

describe("GET /offers/mine", () => {
  it("returns the caller's offers newest-first with venue + buyer names", async () => {
    const { offer, buyerUser } = await seedStoreOffer();
    const res = await request(app).get(`/api/offers/mine`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(offer.id);
    expect(res.body[0].venueName).toBe("Chrome Bazaar");
    expect(res.body[0].buyerName).toBeTruthy();
  });

  it("does not leak another user's offers", async () => {
    const other = await createUser();
    await seedStoreOffer();
    const res = await request(app).get(`/api/offers/mine`).set("x-test-user", other.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// player_sell: a player offers an inventory item TO a venue; the venue owner
// approves (venue account pays the player, item becomes stock).

async function seedPlayerSell(opts: { price?: number; qty?: number; itemQty?: number; venueBalance?: number; category?: string; notes?: string | null } = {}) {
  const owner = await createUser();
  const ownerChar = await createCharacter({ ownerId: owner.id });
  const seller = await createUser();
  const sellerChar = await createCharacter({ ownerId: seller.id });
  const [store] = await db
    .insert(stores)
    .values({ ownerId: owner.id, ownerCharacterId: ownerChar.id, name: "Chrome Bazaar", balance: opts.venueBalance ?? 1000 })
    .returning();
  const [item] = await db
    .insert(inventoryItems)
    .values({
      characterId: sellerChar.id,
      name: "Militech Pistol",
      category: opts.category ?? "Weapon",
      quantity: opts.itemQty ?? 2,
      notes: opts.notes ?? null,
    })
    .returning();
  return { owner, ownerChar, seller, sellerChar, store, item, price: opts.price ?? 100, qty: opts.qty ?? 1 };
}

describe("player_sell offers", () => {
  beforeEach(async () => {
    await setEconomyMode("enabled");
    mockGetBalance.mockResolvedValue({ cash: 100000, bank: 0, total: 100000, source: "unbelievaboat" });
  });

  it("creates a pending offer the venue owner can see, and rejects a second pending offer for the same item", async () => {
    const { seller, store, item } = await seedPlayerSell();
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 100, quantity: 1 });
    expect(res.status).toBe(201);
    expect(res.body.offerType).toBe("player_sell");
    expect(res.body.status).toBe("pending");

    const dup = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 50, quantity: 1 });
    expect(dup.status).toBe(409);
  });

  it("rejects selling an item the caller does not own", async () => {
    const { store, item } = await seedPlayerSell();
    const stranger = await createUser();
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", stranger.id)
      .send({ inventoryItemId: item.id, unitPrice: 100 });
    expect(res.status).toBe(404);
  });

  it("rejects selling INSTALLED cyberware", async () => {
    const { seller, store } = await seedPlayerSell();
    const [chrome] = await db
      .insert(inventoryItems)
      .values({
        characterId: (await db.select().from(characters).where(eq(characters.ownerId, seller.id)))[0].id,
        name: "Kiroshi Optics",
        category: "cyberware",
        quantity: 1,
        notes: "CWP 2 · Installed at Clinic · slot: eyes",
      })
      .returning();
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: chrome.id, unitPrice: 100 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/installed/i);
  });

  it("allows selling UNINSTALLED cyberware", async () => {
    const { seller, store } = await seedPlayerSell();
    const [chrome] = await db
      .insert(inventoryItems)
      .values({
        characterId: (await db.select().from(characters).where(eq(characters.ownerId, seller.id)))[0].id,
        name: "Spare Optics",
        category: "cyberware",
        quantity: 1,
        notes: "slot: eyes",
      })
      .returning();
    const res = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: chrome.id, unitPrice: 100 });
    expect(res.status).toBe(201);
  });

  it("owner approve: debits the venue, moves the item into stock, credits the seller", async () => {
    const { owner, seller, sellerChar, store, item } = await seedPlayerSell({ venueBalance: 500, itemQty: 2 });
    const created = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 150, quantity: 2, memo: "good condition" });
    expect(created.status).toBe(201);

    const res = await request(app).post(`/api/offers/${created.body.id}/approve`).set("x-test-user", owner.id);
    expect(res.status).toBe(200);

    // Venue account debited + ledger row written.
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(200);

    // Item left the seller's inventory entirely (sold both).
    const remaining = await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id));
    expect(remaining).toHaveLength(0);

    // Stock row created at the asking price.
    const stock = await db.select().from(storeStock).where(and(eq(storeStock.storeId, store.id), eq(storeStock.name, "Militech Pistol")));
    expect(stock).toHaveLength(1);
    expect(stock[0].quantity).toBe(2);
    expect(stock[0].price).toBe(150);

    // Seller credited exactly once (idempotency-keyed).
    const credits = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, `offer:${created.body.id}:player-sell-credit`));
    expect(credits).toHaveLength(1);
    expect(credits[0].amount).toBe(300);
    expect(credits[0].userId).toBe(seller.id);
    expect(credits[0].characterId).toBe(sellerChar.id);

    // Re-approve is an idempotent no-op (no double debit/credit).
    const again = await request(app).post(`/api/offers/${created.body.id}/approve`).set("x-test-user", owner.id);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    const [s2] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s2.balance).toBe(200);
    const credits2 = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, `offer:${created.body.id}:player-sell-credit`));
    expect(credits2).toHaveLength(1);
  });

  it("partial quantity sale decrements the seller's row", async () => {
    const { owner, seller, store, item } = await seedPlayerSell({ itemQty: 5 });
    const created = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 10, quantity: 2 });
    const res = await request(app).post(`/api/offers/${created.body.id}/approve`).set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    const [remaining] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id));
    expect(remaining.quantity).toBe(3);
  });

  it("approve fails without debiting when the venue cannot afford it", async () => {
    const { owner, seller, store, item } = await seedPlayerSell({ venueBalance: 50 });
    const created = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 100, quantity: 1 });
    const res = await request(app).post(`/api/offers/${created.body.id}/approve`).set("x-test-user", owner.id);
    expect(res.status).toBe(400);
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(50);
    // Offer stays pending (tx rolled back) and the item never moved.
    const [o] = await db.select().from(saleOffers).where(eq(saleOffers.id, created.body.id));
    expect(o.status).toBe("pending");
    const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id));
    expect(inv.quantity).toBe(2);
  });

  it("approve 409s (and rolls back) when the item has since left the seller's inventory", async () => {
    const { owner, seller, store, item } = await seedPlayerSell();
    const created = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 100, quantity: 1 });
    await db.delete(inventoryItems).where(eq(inventoryItems.id, item.id));
    const res = await request(app).post(`/api/offers/${created.body.id}/approve`).set("x-test-user", owner.id);
    expect(res.status).toBe(409);
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(1000);
    const [o] = await db.select().from(saleOffers).where(eq(saleOffers.id, created.body.id));
    expect(o.status).toBe("pending");
  });

  it("only the venue owner can approve — the seller and admins cannot", async () => {
    const { seller, store, item } = await seedPlayerSell();
    const admin = await createAdmin();
    const created = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 100 });
    const bySeller = await request(app).post(`/api/offers/${created.body.id}/approve`).set("x-test-user", seller.id);
    expect(bySeller.status).toBe(403);
    const byAdmin = await request(app).post(`/api/offers/${created.body.id}/approve`).set("x-test-user", admin.id);
    expect(byAdmin.status).toBe(403);
  });

  it("the seller can WITHDRAW (deny) their own pending offer; strangers cannot", async () => {
    const { seller, store, item } = await seedPlayerSell();
    const stranger = await createUser();
    const created = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 100 });
    const byStranger = await request(app).post(`/api/offers/${created.body.id}/deny`).set("x-test-user", stranger.id);
    expect(byStranger.status).toBe(403);
    const bySeller = await request(app).post(`/api/offers/${created.body.id}/deny`).set("x-test-user", seller.id);
    expect(bySeller.status).toBe(200);
    expect(bySeller.body.status).toBe("denied");
  });

  it("test mode approve is a dry run — nothing moves", async () => {
    const { owner, seller, store, item } = await seedPlayerSell();
    const created = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 100 });
    await setEconomyMode("test");
    const res = await request(app).post(`/api/offers/${created.body.id}/approve`).set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    const [o] = await db.select().from(saleOffers).where(eq(saleOffers.id, created.body.id));
    expect(o.status).toBe("pending");
    const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id));
    expect(inv.quantity).toBe(2);
  });

  it("GET /offers/outgoing returns only the caller's player_sell offers", async () => {
    const { seller, store, item } = await seedPlayerSell();
    await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 100 });
    const mine = await request(app).get("/api/offers/outgoing").set("x-test-user", seller.id);
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].offerType).toBe("player_sell");
    const other = await createUser();
    const theirs = await request(app).get("/api/offers/outgoing").set("x-test-user", other.id);
    expect(theirs.body).toHaveLength(0);
  });
});

describe("player_sell ownership-change races", () => {
  beforeEach(async () => {
    await setEconomyMode("enabled");
    mockGetBalance.mockResolvedValue({ cash: 100000, bank: 0, total: 100000, source: "unbelievaboat" });
  });

  it("a FORMER venue owner cannot approve after the venue changes hands", async () => {
    const { owner, seller, store, item } = await seedPlayerSell();
    const created = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 100 });
    const newOwner = await createUser();
    await db.update(stores).set({ ownerId: newOwner.id }).where(eq(stores.id, store.id));
    const res = await request(app).post(`/api/offers/${created.body.id}/approve`).set("x-test-user", owner.id);
    expect(res.status).toBe(403);
    // The CURRENT owner can approve.
    const ok = await request(app).post(`/api/offers/${created.body.id}/approve`).set("x-test-user", newOwner.id);
    expect(ok.status).toBe(200);
  });

  it("approve rolls back when the selling character changed hands since creation", async () => {
    const { owner, seller, sellerChar, store, item } = await seedPlayerSell();
    const created = await request(app)
      .post(`/api/stores/${store.id}/sell-item`)
      .set("x-test-user", seller.id)
      .send({ inventoryItemId: item.id, unitPrice: 100 });
    const newCharOwner = await createUser();
    await db.update(characters).set({ ownerId: newCharOwner.id }).where(eq(characters.id, sellerChar.id));
    const res = await request(app).post(`/api/offers/${created.body.id}/approve`).set("x-test-user", owner.id);
    expect(res.status).toBe(409);
    const [s] = await db.select().from(stores).where(eq(stores.id, store.id));
    expect(s.balance).toBe(1000);
    const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id));
    expect(inv.quantity).toBe(2);
  });
});
