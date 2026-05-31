import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";

vi.mock("../lib/unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));
vi.mock("../lib/discord", async (orig) => {
  const actual = await orig<typeof import("../lib/discord")>();
  return { ...actual, sendDirectMessage: vi.fn().mockResolvedValue(undefined) };
});

import {
  db, ripperdocs, ripperdocStock, ripperdocEmployees,
  inventoryItems, walletTransactions, characters, users, saleOffers, botConfig,
} from "@workspace/db";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";
import { parseCwp } from "../lib/cyberware";

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

// A clinic owned by `owner`, a claimed buyer, and one stock cyberware row.
async function seedClinic(opts: { price?: number; cwp?: number; stockQty?: number; buyerKind?: string } = {}) {
  const owner = await createUser();
  const buyerUser = await createUser();
  const [clinic] = await db
    .insert(ripperdocs)
    .values({ ownerId: owner.id, name: "Vik's Clinic", balance: 0 })
    .returning();
  const cwp = opts.cwp ?? 5;
  const [stock] = await db
    .insert(ripperdocStock)
    .values({
      ripperdocId: clinic.id,
      name: "Kerenzikov",
      category: "cyberware",
      price: opts.price ?? 100,
      quantity: opts.stockQty ?? 5,
      notes: `CWP ${cwp}`,
    })
    .returning();
  const buyer = await createCharacter({ ownerId: buyerUser.id, kind: opts.buyerKind ?? "pc" });
  return { owner, buyerUser, clinic, stock, buyer, cwp };
}

// An installed cyberware row on a character (counts toward CWP via its notes).
async function installChrome(characterId: number, ownerId: string, name: string, cwp: number) {
  const [item] = await db
    .insert(inventoryItems)
    .values({
      characterId,
      ownerId,
      name,
      category: "cyberware",
      quantity: 1,
      notes: `CWP ${cwp} · Installed`,
      pricePaid: 0,
      acquiredAt: new Date(),
    })
    .returning();
  return item;
}

describe("POST /ripperdocs/:id/install", () => {
  it("creates a pending install offer with the resolved CWP", async () => {
    const { owner, clinic, stock, buyer, cwp } = await seedClinic({ price: 250, cwp: 4 });
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/install`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    expect(res.status).toBe(201);
    expect(res.body.offerType).toBe("install");
    expect(res.body.cwp).toBe(cwp);
    expect(res.body.totalPrice).toBe(250);
    expect(res.body.status).toBe("pending");
  });

  it("409s when the install would exceed a PC's 15 CWP cap", async () => {
    const { owner, clinic, stock, buyer, buyerUser } = await seedClinic({ cwp: 5 });
    // Buyer already carries 12 CWP; +5 would be 17 > 15.
    await installChrome(buyer.id, buyerUser.id, "Gorilla Arms", 12);
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/install`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    expect(res.status).toBe(409);
    expect(await db.select().from(saleOffers)).toHaveLength(0);
  });

  it("allows an NPC to exceed the PC cap (unlimited chrome)", async () => {
    const { owner, clinic, stock, buyer, buyerUser } = await seedClinic({ cwp: 9, buyerKind: "npc" });
    await installChrome(buyer.id, buyerUser.id, "Sandevistan", 12);
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/install`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    expect(res.status).toBe(201);
  });

  it("approving an install adds installed cyberware, debits the buyer, credits the clinic", async () => {
    await setEconomyMode("enabled");
    const { owner, clinic, stock, buyer, buyerUser, cwp } = await seedClinic({ price: 300, cwp: 6, stockQty: 3 });
    await fund(buyerUser.id, 1000);
    const create = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/install`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    expect(create.status).toBe(201);
    const offerId = create.body.id;

    const res = await request(app).post(`/api/offers/${offerId}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    expect(res.body.offer.status).toBe("approved");

    const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, buyer.id));
    expect(inv).toHaveLength(1);
    expect(inv[0].category).toBe("cyberware");
    expect(inv[0].notes).toContain(`CWP ${cwp}`);

    const [stk] = await db.select().from(ripperdocStock).where(eq(ripperdocStock.id, stock.id));
    expect(stk.quantity).toBe(2);
    const [c] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, clinic.id));
    expect(c.balance).toBe(300);
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(700);
  });

  it("re-validates the cap at approval (other chrome landed after the offer)", async () => {
    await setEconomyMode("enabled");
    const { owner, clinic, stock, buyer, buyerUser } = await seedClinic({ price: 100, cwp: 5 });
    await fund(buyerUser.id, 1000);
    const create = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/install`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    expect(create.status).toBe(201);
    // After the offer, buyer maxes out at 15 from other installs; +5 now overflows.
    await installChrome(buyer.id, buyerUser.id, "Subdermal Armor", 15);
    const res = await request(app).post(`/api/offers/${create.body.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(409);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("serializes concurrent install approvals so the PC cap can't be raced past", async () => {
    await setEconomyMode("enabled");
    // 6 CWP already installed; two 5-CWP offers each pass the up-front check
    // (6+5=11), but only one can commit before the other overflows (11+5=16>15).
    const { owner, clinic, stock, buyer, buyerUser } = await seedClinic({ price: 50, cwp: 5, stockQty: 2 });
    await installChrome(buyer.id, buyerUser.id, "Reflex Tuner", 6);
    await fund(buyerUser.id, 1000);
    const mk = async () => {
      const c = await request(app)
        .post(`/api/ripperdocs/${clinic.id}/install`)
        .set("x-test-user", owner.id)
        .send({ stockId: stock.id, buyerCharacterId: buyer.id });
      expect(c.status).toBe(201);
      return c.body.id as number;
    };
    const [o1, o2] = [await mk(), await mk()];
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/offers/${o1}/approve`).set("x-test-user", buyerUser.id),
      request(app).post(`/api/offers/${o2}/approve`).set("x-test-user", buyerUser.id),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const rows = await db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.characterId, buyer.id), eq(inventoryItems.category, "cyberware")));
    const totalCwp = rows.reduce((s, r) => s + (parseCwp(r.notes) ?? 0) * (r.quantity ?? 1), 0);
    expect(totalCwp).toBeLessThanOrEqual(15);
    expect(totalCwp).toBe(11);
  });
});

describe("POST /ripperdocs/:id/give", () => {
  it("creates a free (price 0) offer and moves no money when approved", async () => {
    await setEconomyMode("enabled");
    const { owner, clinic, stock, buyer, buyerUser } = await seedClinic({ price: 500 });
    await fund(buyerUser.id, 1000);
    const create = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/give`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    expect(create.status).toBe(201);
    expect(create.body.offerType).toBe("give");
    expect(create.body.totalPrice).toBe(0);

    const res = await request(app).post(`/api/offers/${create.body.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    expect(mockPatch).not.toHaveBeenCalled();
    const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, buyer.id));
    expect(inv).toHaveLength(1);
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(1000);
    const [c] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, clinic.id));
    expect(c.balance).toBe(0);
  });

  it("a sold/given item lands uninstalled — not in the installed list, not removable", async () => {
    await setEconomyMode("enabled");
    const { owner, clinic, stock, buyer, buyerUser } = await seedClinic({ price: 500 });
    await fund(buyerUser.id, 1000);
    const give = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/give`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    expect(give.status).toBe(201);
    const approve = await request(app).post(`/api/offers/${give.body.id}/approve`).set("x-test-user", buyerUser.id);
    expect(approve.status).toBe(200);

    const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, buyer.id));
    // Not surfaced as installed (no CWP install tag).
    const status = await request(app)
      .get(`/api/ripperdocs/${clinic.id}/characters/${buyer.id}/cyberware`)
      .set("x-test-user", owner.id);
    expect(status.status).toBe(200);
    expect(status.body.used).toBe(0);
    expect(status.body.installed).toHaveLength(0);
    // Cannot be targeted by a removal offer.
    const remove = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/remove`)
      .set("x-test-user", owner.id)
      .send({ removedItemId: item.id, buyerCharacterId: buyer.id });
    expect(remove.status).toBe(400);
  });
});

describe("POST /ripperdocs/:id/remove", () => {
  it("400s when the targeted item is not installed cyberware", async () => {
    const { owner, clinic, buyer, buyerUser } = await seedClinic();
    const [junk] = await db
      .insert(inventoryItems)
      .values({ characterId: buyer.id, ownerId: buyerUser.id, name: "Burrito", category: "food", quantity: 1, acquiredAt: new Date() })
      .returning();
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/remove`)
      .set("x-test-user", owner.id)
      .send({ removedItemId: junk.id, buyerCharacterId: buyer.id });
    expect(res.status).toBe(400);
  });

  it("approving a remove un-installs the chrome and charges the optional fee", async () => {
    await setEconomyMode("enabled");
    const { owner, clinic, buyer, buyerUser } = await seedClinic();
    await fund(buyerUser.id, 1000);
    const chrome = await installChrome(buyer.id, buyerUser.id, "Mantis Blades", 8);
    const create = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/remove`)
      .set("x-test-user", owner.id)
      .send({ removedItemId: chrome.id, buyerCharacterId: buyer.id, fee: 150 });
    expect(create.status).toBe(201);
    expect(create.body.offerType).toBe("remove");
    expect(create.body.removedItemId).toBe(chrome.id);
    expect(create.body.cwp).toBe(8);

    const res = await request(app).post(`/api/offers/${create.body.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);

    const [it] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, chrome.id));
    expect(it.category).toBe("cyberware (removed)");
    expect(it.notes).toContain("Removed at");
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(850);
    const [c] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, clinic.id));
    expect(c.balance).toBe(150);
  });

  it("a free removal moves no money", async () => {
    await setEconomyMode("enabled");
    const { owner, clinic, buyer, buyerUser } = await seedClinic();
    await fund(buyerUser.id, 1000);
    const chrome = await installChrome(buyer.id, buyerUser.id, "Cyberdeck", 3);
    const create = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/remove`)
      .set("x-test-user", owner.id)
      .send({ removedItemId: chrome.id, buyerCharacterId: buyer.id });
    expect(create.status).toBe(201);
    const res = await request(app).post(`/api/offers/${create.body.id}/approve`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    expect(mockPatch).not.toHaveBeenCalled();
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(1000);
  });

  it("denying a remove leaves the chrome installed", async () => {
    const { owner, clinic, buyer, buyerUser } = await seedClinic();
    const chrome = await installChrome(buyer.id, buyerUser.id, "Optics", 2);
    const create = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/remove`)
      .set("x-test-user", owner.id)
      .send({ removedItemId: chrome.id, buyerCharacterId: buyer.id, fee: 100 });
    const res = await request(app).post(`/api/offers/${create.body.id}/deny`).set("x-test-user", buyerUser.id);
    expect(res.status).toBe(200);
    const [it] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, chrome.id));
    expect(it.category).toBe("cyberware");
    expect(await db.select().from(walletTransactions)).toHaveLength(0);
  });
});

describe("GET /ripperdocs/:id/characters/:characterId/cyberware", () => {
  it("reports CWP capacity and installed list for a PC", async () => {
    const { owner, clinic, buyer, buyerUser } = await seedClinic();
    await installChrome(buyer.id, buyerUser.id, "Reflex Tuner", 4);
    await installChrome(buyer.id, buyerUser.id, "Pain Editor", 3);
    const res = await request(app)
      .get(`/api/ripperdocs/${clinic.id}/characters/${buyer.id}/cyberware`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("pc");
    expect(res.body.used).toBe(7);
    expect(res.body.max).toBe(15);
    expect(res.body.available).toBe(8);
    expect(res.body.installed).toHaveLength(2);
  });

  it("reports unlimited capacity (null) for an NPC", async () => {
    const { owner, clinic, buyer, buyerUser } = await seedClinic({ buyerKind: "npc" });
    await installChrome(buyer.id, buyerUser.id, "Militech Core", 20);
    const res = await request(app)
      .get(`/api/ripperdocs/${clinic.id}/characters/${buyer.id}/cyberware`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("npc");
    expect(res.body.used).toBe(20);
    expect(res.body.max).toBeNull();
    expect(res.body.available).toBeNull();
  });

  it("403s for a non-operator", async () => {
    const stranger = await createUser();
    const { clinic, buyer } = await seedClinic();
    const res = await request(app)
      .get(`/api/ripperdocs/${clinic.id}/characters/${buyer.id}/cyberware`)
      .set("x-test-user", stranger.id);
    expect(res.status).toBe(403);
  });
});
