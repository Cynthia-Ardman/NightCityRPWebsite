import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";

import { db, inventoryItems, inventoryEvents, ripperdocs, ripperdocStock } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();

async function createClinic(name = "Rook's Ripper") {
  const docOwner = await createUser();
  const [row] = await db.insert(ripperdocs).values({ name, ownerId: docOwner.id }).returning();
  return row;
}

async function addItem(characterId: number, ownerId: string, over: Partial<typeof inventoryItems.$inferInsert> = {}) {
  const [row] = await db
    .insert(inventoryItems)
    .values({
      characterId,
      ownerId,
      name: "Neurofilter",
      category: "cyberware (removed)",
      quantity: 1,
      notes: "CWP 2 · Installed at Rook's on 2026-01-01 · Removed at Rook's on 2026-08-03",
      ...over,
    })
    .returning();
  return row;
}

describe("POST /characters/:cid/inventory/:itemId/give-to-clinic", () => {
  it("moves a removed piece into clinic stock with a CWP note and custody event", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const clinic = await createClinic();
    const item = await addItem(char.id, owner.id);
    const res = await request(app)
      .post(`/api/characters/${char.id}/inventory/${item.id}/give-to-clinic`)
      .set("x-test-user", owner.id)
      .send({ ripperdocId: clinic.id, memo: "donation" });
    expect(res.status).toBe(204);
    const remaining = await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id));
    expect(remaining).toHaveLength(0);
    const stock = await db.select().from(ripperdocStock).where(eq(ripperdocStock.ripperdocId, clinic.id));
    expect(stock).toHaveLength(1);
    expect(stock[0].name).toBe("Neurofilter");
    expect(stock[0].category).toBe("cyberware");
    expect(stock[0].price).toBe(0);
    expect(stock[0].notes).toContain("CWP 2");
    const events = await db
      .select()
      .from(inventoryEvents)
      .where(eq(inventoryEvents.instanceUuid, item.instanceUuid));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("transferred");
    expect(events[0].reason).toContain(clinic.name);
    expect(events[0].reason).toContain("donation");
  });

  it("splits a partial quantity, leaving the rest in inventory", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const clinic = await createClinic();
    const item = await addItem(char.id, owner.id, { quantity: 3 });
    const res = await request(app)
      .post(`/api/characters/${char.id}/inventory/${item.id}/give-to-clinic`)
      .set("x-test-user", owner.id)
      .send({ ripperdocId: clinic.id, quantity: 2 });
    expect(res.status).toBe(204);
    const [remaining] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, item.id));
    expect(remaining.quantity).toBe(1);
    const [stock] = await db.select().from(ripperdocStock).where(eq(ripperdocStock.ripperdocId, clinic.id));
    expect(stock.quantity).toBe(2);
    // Partial gives must be recorded as a split, not a whole-instance transfer.
    const events = await db
      .select()
      .from(inventoryEvents)
      .where(eq(inventoryEvents.instanceUuid, item.instanceUuid));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("split");
    expect(events[0].reason).toContain("2 of 3");
  });

  it("400 for installed cyberware (category cyberware with a CWP tag)", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const clinic = await createClinic();
    const item = await addItem(char.id, owner.id, {
      category: "cyberware",
      notes: "CWP 3 · Installed at Rook's on 2026-01-01",
    });
    const res = await request(app)
      .post(`/api/characters/${char.id}/inventory/${item.id}/give-to-clinic`)
      .set("x-test-user", owner.id)
      .send({ ripperdocId: clinic.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/installed/i);
    const stock = await db.select().from(ripperdocStock).where(eq(ripperdocStock.ripperdocId, clinic.id));
    expect(stock).toHaveLength(0);
  });

  it("allows loose (uninstalled) cyberware-category items with no CWP tag", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const clinic = await createClinic();
    const item = await addItem(char.id, owner.id, { category: "cyberware", notes: null });
    const res = await request(app)
      .post(`/api/characters/${char.id}/inventory/${item.id}/give-to-clinic`)
      .set("x-test-user", owner.id)
      .send({ ripperdocId: clinic.id });
    expect(res.status).toBe(204);
    const [stock] = await db.select().from(ripperdocStock).where(eq(ripperdocStock.ripperdocId, clinic.id));
    expect(stock.notes).toContain("CWP 0");
  });

  it("400 for a non-cyberware item", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const clinic = await createClinic();
    const item = await addItem(char.id, owner.id, { category: "gear", notes: null });
    const res = await request(app)
      .post(`/api/characters/${char.id}/inventory/${item.id}/give-to-clinic`)
      .set("x-test-user", owner.id)
      .send({ ripperdocId: clinic.id });
    expect(res.status).toBe(400);
  });

  it("404 when the caller does not own the character", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const clinic = await createClinic();
    const item = await addItem(char.id, owner.id);
    const res = await request(app)
      .post(`/api/characters/${char.id}/inventory/${item.id}/give-to-clinic`)
      .set("x-test-user", stranger.id)
      .send({ ripperdocId: clinic.id });
    expect(res.status).toBe(404);
  });

  it("404 for an unknown clinic", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const item = await addItem(char.id, owner.id);
    const res = await request(app)
      .post(`/api/characters/${char.id}/inventory/${item.id}/give-to-clinic`)
      .set("x-test-user", owner.id)
      .send({ ripperdocId: 999999 });
    expect(res.status).toBe(404);
  });

  it("400 when quantity exceeds the stack", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const clinic = await createClinic();
    const item = await addItem(char.id, owner.id, { quantity: 1 });
    const res = await request(app)
      .post(`/api/characters/${char.id}/inventory/${item.id}/give-to-clinic`)
      .set("x-test-user", owner.id)
      .send({ ripperdocId: clinic.id, quantity: 5 });
    expect(res.status).toBe(400);
  });
});
