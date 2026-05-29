import { describe, it, expect } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, characters, users, characterUpdates, auditLog } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();

describe("DELETE /characters/:id (admin-only permanent deletion)", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const char = await createCharacter();
    const res = await request(app).delete(`/api/characters/${char.id}`);
    expect(res.status).toBe(401);
  });

  it("forbids non-admin callers with 403", async () => {
    const user = await createUser();
    const char = await createCharacter({ ownerId: user.id });
    const res = await request(app).delete(`/api/characters/${char.id}`).set("x-test-user", user.id);
    expect(res.status).toBe(403);
    // character still exists
    const [still] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(still).toBeTruthy();
  });

  it("returns 400 for a non-numeric id", async () => {
    const admin = await createAdmin();
    const res = await request(app).delete("/api/characters/not-a-number").set("x-test-user", admin.id);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the character does not exist", async () => {
    const admin = await createAdmin();
    const res = await request(app).delete("/api/characters/999999").set("x-test-user", admin.id);
    expect(res.status).toBe(404);
  });

  it("deletes the character, cascades related rows, clears active pointers, and audits", async () => {
    const admin = await createAdmin();
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, name: "Doomed Merc" });
    // a related row that should cascade-delete
    await db.insert(characterUpdates).values({ characterId: char.id, authorId: owner.id, note: "log" });
    // a user actively pointing at this character (plain column, must be nulled)
    await db.update(users).set({ activeCharacterId: char.id }).where(eq(users.id, owner.id));

    const res = await request(app).delete(`/api/characters/${char.id}`).set("x-test-user", admin.id);
    expect(res.status).toBe(204);

    const [gone] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(gone).toBeUndefined();

    const updates = await db.select().from(characterUpdates).where(eq(characterUpdates.characterId, char.id));
    expect(updates).toHaveLength(0);

    const [refreshedOwner] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(refreshedOwner.activeCharacterId).toBeNull();

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "deleted"));
    expect(audits.length).toBe(1);
    expect(audits[0].category).toBe("character");
    expect(audits[0].targetId).toBe(String(char.id));
  });
});
