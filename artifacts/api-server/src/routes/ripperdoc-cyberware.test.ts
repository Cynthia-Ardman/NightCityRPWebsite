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
  it("installs stock cyberware instantly: adds chrome, debits the buyer, credits the clinic", async () => {
    await setEconomyMode("enabled");
    const { owner, clinic, stock, buyer, buyerUser, cwp } = await seedClinic({ price: 300, cwp: 6, stockQty: 3 });
    await fund(buyerUser.id, 1000);
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/install`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    expect(res.status).toBe(200);
    expect(res.body.offer.offerType).toBe("install");
    expect(res.body.offer.cwp).toBe(cwp);
    expect(res.body.offer.totalPrice).toBe(300);
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
    await setEconomyMode("enabled");
    const { owner, clinic, stock, buyer, buyerUser } = await seedClinic({ cwp: 9, buyerKind: "npc" });
    await fund(buyerUser.id, 1000);
    await installChrome(buyer.id, buyerUser.id, "Sandevistan", 12);
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/install`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    expect(res.status).toBe(200);
    expect(res.body.offer.status).toBe("approved");
  });

  it("409s without moving money when the economy is disabled", async () => {
    await setEconomyMode("disabled");
    const { owner, clinic, stock, buyer, buyerUser } = await seedClinic({ price: 300 });
    await fund(buyerUser.id, 1000);
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/install`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    expect(res.status).toBe(409);
    // No dangling pending offer is left behind, and nothing moved.
    expect(await db.select().from(saleOffers)).toHaveLength(0);
    expect(await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, buyer.id))).toHaveLength(0);
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(1000);
  });

  it("serializes concurrent installs so the PC cap can't be raced past", async () => {
    await setEconomyMode("enabled");
    // 6 CWP already installed; two concurrent 5-CWP installs each pass the
    // up-front check (6+5=11), but only one can commit before the other
    // overflows (11+5=16>15).
    const { owner, clinic, stock, buyer, buyerUser } = await seedClinic({ price: 50, cwp: 5, stockQty: 2 });
    await installChrome(buyer.id, buyerUser.id, "Reflex Tuner", 6);
    await fund(buyerUser.id, 1000);
    const mk = () =>
      request(app)
        .post(`/api/ripperdocs/${clinic.id}/install`)
        .set("x-test-user", owner.id)
        .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    const [r1, r2] = await Promise.all([mk(), mk()]);
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
  it("gives a stock item for free instantly and moves no money", async () => {
    await setEconomyMode("enabled");
    const { owner, clinic, stock, buyer, buyerUser } = await seedClinic({ price: 500 });
    await fund(buyerUser.id, 1000);
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/give`)
      .set("x-test-user", owner.id)
      .send({ stockId: stock.id, buyerCharacterId: buyer.id });
    expect(res.status).toBe(200);
    expect(res.body.offer.offerType).toBe("give");
    expect(res.body.offer.totalPrice).toBe(0);
    expect(res.body.offer.status).toBe("approved");
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
    expect(give.status).toBe(200);

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

  it("removes the chrome instantly and charges the optional fee", async () => {
    await setEconomyMode("enabled");
    const { owner, clinic, buyer, buyerUser } = await seedClinic();
    await fund(buyerUser.id, 1000);
    const chrome = await installChrome(buyer.id, buyerUser.id, "Mantis Blades", 8);
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/remove`)
      .set("x-test-user", owner.id)
      .send({ removedItemId: chrome.id, buyerCharacterId: buyer.id, fee: 150 });
    expect(res.status).toBe(200);
    expect(res.body.offer.offerType).toBe("remove");
    expect(res.body.offer.removedItemId).toBe(chrome.id);
    expect(res.body.offer.cwp).toBe(8);
    expect(res.body.offer.status).toBe("approved");

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
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/remove`)
      .set("x-test-user", owner.id)
      .send({ removedItemId: chrome.id, buyerCharacterId: buyer.id });
    expect(res.status).toBe(200);
    expect(mockPatch).not.toHaveBeenCalled();
    const [bu] = await db.select().from(users).where(eq(users.id, buyerUser.id));
    expect(bu.walletBalance).toBe(1000);
  });

  it("destination 'clinic' moves the part out of the patient's inventory into clinic stock", async () => {
    await setEconomyMode("enabled");
    const { owner, clinic, buyer, buyerUser } = await seedClinic();
    await fund(buyerUser.id, 1000);
    const chrome = await installChrome(buyer.id, buyerUser.id, "Gorilla Arms", 6);
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/remove`)
      .set("x-test-user", owner.id)
      .send({ removedItemId: chrome.id, buyerCharacterId: buyer.id, destination: "clinic" });
    expect(res.status).toBe(200);
    expect(res.body.offer.status).toBe("approved");

    // Item is gone from the patient entirely.
    const gone = await db.select().from(inventoryItems).where(eq(inventoryItems.id, chrome.id));
    expect(gone).toHaveLength(0);

    // ...and landed in the clinic's stock with the CWP tag preserved.
    const stock = await db
      .select()
      .from(ripperdocStock)
      .where(and(eq(ripperdocStock.ripperdocId, clinic.id), eq(ripperdocStock.name, "Gorilla Arms")));
    expect(stock).toHaveLength(1);
    expect(stock[0].category).toBe("cyberware");
    expect(stock[0].quantity).toBe(1);
    expect(stock[0].price).toBe(0);
    expect(parseCwp(stock[0].notes)).toBe(6);
    expect(stock[0].notes).toContain("Removed from");
  });

  it("400s on an invalid destination", async () => {
    const { owner, clinic, buyer, buyerUser } = await seedClinic();
    const chrome = await installChrome(buyer.id, buyerUser.id, "Optics MK2", 2);
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/remove`)
      .set("x-test-user", owner.id)
      .send({ removedItemId: chrome.id, buyerCharacterId: buyer.id, destination: "landfill" });
    expect(res.status).toBe(400);
  });

  it("leaves the chrome installed and moves nothing when the economy is disabled", async () => {
    await setEconomyMode("disabled");
    const { owner, clinic, buyer, buyerUser } = await seedClinic();
    const chrome = await installChrome(buyer.id, buyerUser.id, "Optics", 2);
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/remove`)
      .set("x-test-user", owner.id)
      .send({ removedItemId: chrome.id, buyerCharacterId: buyer.id, fee: 100 });
    expect(res.status).toBe(409);
    const [it] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, chrome.id));
    expect(it.category).toBe("cyberware");
    expect(await db.select().from(saleOffers)).toHaveLength(0);
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
