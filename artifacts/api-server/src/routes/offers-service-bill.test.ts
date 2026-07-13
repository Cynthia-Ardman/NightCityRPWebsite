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

import { db, ripperdocs, inventoryItems, users, saleOffers, botConfig, characters } from "@workspace/db";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

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

async function seedClinic() {
  const owner = await createUser();
  const patientUser = await createUser();
  const [clinic] = await db.insert(ripperdocs).values({ ownerId: owner.id, name: "Viktor's Clinic", balance: 0 }).returning();
  const patient = await createCharacter({ ownerId: patientUser.id });
  return { owner, patientUser, clinic, patient };
}

describe("POST /ripperdocs/:id/bill", () => {
  it("creates a PENDING service offer with the note as item name (no auto-complete, no money moved)", async () => {
    const { owner, clinic, patient } = await seedClinic();
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/bill`)
      .set("x-test-user", owner.id)
      .send({ buyerCharacterId: patient.id, amount: 500, note: "Tooth repair" });
    expect(res.status).toBe(201);
    expect(res.body.offerType).toBe("service");
    expect(res.body.status).toBe("pending");
    expect(res.body.itemName).toBe("Tooth repair");
    expect(res.body.itemCategory).toBe("service");
    expect(res.body.unitPrice).toBe(500);
    expect(res.body.quantity).toBe(1);
    expect(res.body.totalPrice).toBe(500);
    expect(mockPatch).not.toHaveBeenCalled();
    const [c] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, clinic.id));
    expect(c.balance).toBe(0);
  });

  it("403s for a stranger who does not operate the clinic", async () => {
    const { clinic, patient } = await seedClinic();
    const stranger = await createUser();
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/bill`)
      .set("x-test-user", stranger.id)
      .send({ buyerCharacterId: patient.id, amount: 500, note: "Tooth repair" });
    expect(res.status).toBe(403);
  });

  it("400s when the note is missing or blank", async () => {
    const { owner, clinic, patient } = await seedClinic();
    const missing = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/bill`)
      .set("x-test-user", owner.id)
      .send({ buyerCharacterId: patient.id, amount: 500 });
    expect(missing.status).toBe(400);
    const blank = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/bill`)
      .set("x-test-user", owner.id)
      .send({ buyerCharacterId: patient.id, amount: 500, note: "   " });
    expect(blank.status).toBe(400);
  });

  it("400s on a note over 200 characters", async () => {
    const { owner, clinic, patient } = await seedClinic();
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/bill`)
      .set("x-test-user", owner.id)
      .send({ buyerCharacterId: patient.id, amount: 500, note: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("400s on a non-positive amount", async () => {
    const { owner, clinic, patient } = await seedClinic();
    const zero = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/bill`)
      .set("x-test-user", owner.id)
      .send({ buyerCharacterId: patient.id, amount: 0, note: "Tooth repair" });
    expect(zero.status).toBe(400);
    const negative = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/bill`)
      .set("x-test-user", owner.id)
      .send({ buyerCharacterId: patient.id, amount: -50, note: "Tooth repair" });
    expect(negative.status).toBe(400);
  });

  it("409s when the character is unclaimed", async () => {
    const { owner, clinic } = await seedClinic();
    const unclaimed = await createCharacter({});
    await db.update(characters).set({ ownerId: null }).where(eq(characters.id, unclaimed.id));
    const res = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/bill`)
      .set("x-test-user", owner.id)
      .send({ buyerCharacterId: unclaimed.id, amount: 500, note: "Tooth repair" });
    expect(res.status).toBe(409);
  });

  it("400s on malformed buyerCharacterId or amount (no NaN leaking into DB lookups)", async () => {
    const { owner, clinic, patient } = await seedClinic();
    const badChar = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/bill`)
      .set("x-test-user", owner.id)
      .send({ buyerCharacterId: "abc", amount: 500, note: "Tooth repair" });
    expect(badChar.status).toBe(400);
    const badAmount = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/bill`)
      .set("x-test-user", owner.id)
      .send({ buyerCharacterId: patient.id, amount: "lots", note: "Tooth repair" });
    expect(badAmount.status).toBe(400);
  });

  it("404s on a missing clinic or missing character", async () => {
    const { owner, clinic, patient } = await seedClinic();
    const noClinic = await request(app)
      .post(`/api/ripperdocs/999999/bill`)
      .set("x-test-user", owner.id)
      .send({ buyerCharacterId: patient.id, amount: 500, note: "Tooth repair" });
    expect(noClinic.status).toBe(404);
    const noChar = await request(app)
      .post(`/api/ripperdocs/${clinic.id}/bill`)
      .set("x-test-user", owner.id)
      .send({ buyerCharacterId: 999999, amount: 500, note: "Tooth repair" });
    expect(noChar.status).toBe(404);
  });
});

describe("service bill approval", () => {
  async function seedBill(amount = 500) {
    const seeded = await seedClinic();
    const res = await request(app)
      .post(`/api/ripperdocs/${seeded.clinic.id}/bill`)
      .set("x-test-user", seeded.owner.id)
      .send({ buyerCharacterId: seeded.patient.id, amount, note: "Tooth repair" });
    expect(res.status).toBe(201);
    return { ...seeded, offer: res.body as { id: number } };
  }

  it("approving pays the bill: debits the patient, credits the clinic, moves NO inventory", async () => {
    await setEconomyMode("enabled");
    const { offer, patientUser, clinic } = await seedBill(500);
    await fund(patientUser.id, 1000);
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", patientUser.id);
    expect(res.status).toBe(200);
    expect(res.body.offer.status).toBe("approved");
    const [c] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, clinic.id));
    expect(c.balance).toBe(500);
    const [pu] = await db.select().from(users).where(eq(users.id, patientUser.id));
    expect(pu.walletBalance).toBe(500);
    // Pure service: nothing lands in the character's inventory.
    expect(await db.select().from(inventoryItems)).toHaveLength(0);
  });

  it("400s when the patient cannot afford the bill (offer stays pending)", async () => {
    await setEconomyMode("enabled");
    const { offer, patientUser } = await seedBill(500);
    await fund(patientUser.id, 100);
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", patientUser.id);
    expect(res.status).toBe(400);
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(fresh.status).toBe("pending");
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("410s an expired bill on approve and flips it to expired (no money moved)", async () => {
    await setEconomyMode("enabled");
    const { offer, patientUser, clinic } = await seedBill(500);
    await fund(patientUser.id, 1000);
    await db
      .update(saleOffers)
      .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
      .where(eq(saleOffers.id, offer.id));
    const res = await request(app).post(`/api/offers/${offer.id}/approve`).set("x-test-user", patientUser.id);
    expect([409, 410]).toContain(res.status);
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(fresh.status).not.toBe("approved");
    const [c] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, clinic.id));
    expect(c.balance).toBe(0);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("lets the patient deny the bill (pure status flip, no money moved)", async () => {
    await setEconomyMode("enabled");
    const { offer, patientUser, clinic } = await seedBill(500);
    const res = await request(app).post(`/api/offers/${offer.id}/deny`).set("x-test-user", patientUser.id);
    expect(res.status).toBe(200);
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    expect(fresh.status).toBe("denied");
    const [c] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, clinic.id));
    expect(c.balance).toBe(0);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
