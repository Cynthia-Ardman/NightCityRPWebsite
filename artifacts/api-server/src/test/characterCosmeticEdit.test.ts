import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, characters, characterUpdates, pendingCharacterEdits } from "@workspace/db";
import { buildTestApp } from "./app";
import request from "supertest";
import { createUser, createCharacter } from "./testDb";

const app = buildTestApp();

async function ownedChar(ownerId: string, overrides: Partial<typeof characters.$inferInsert> = {}) {
  const c = await createCharacter({ ownerId, name: "Edit Target" });
  if (Object.keys(overrides).length > 0) {
    await db.update(characters).set(overrides).where(eq(characters.id, c.id));
  }
  return c;
}

async function patch(userId: string, id: number, body: Record<string, unknown>) {
  return request(app).patch(`/api/characters/${id}`).set("x-test-user", userId).send(body);
}

async function pendingCount(characterId: number) {
  const rows = await db
    .select()
    .from(pendingCharacterEdits)
    .where(eq(pendingCharacterEdits.characterId, characterId));
  return rows.length;
}

describe("cosmetic character edits auto-apply", () => {
  it("applies a portrait-only edit immediately (no review)", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id);

    const res = await patch(u.id, c.id, { portraitUrl: "/api/storage/objects/new-portrait" });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);
    expect(res.body.character.portraitUrl).toBe("/api/storage/objects/new-portrait");
    expect(await pendingCount(c.id)).toBe(0);
  });

  it("applies background + archetype + portraitUrls together without review", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id);

    const res = await patch(u.id, c.id, {
      background: "A new bio.",
      archetype: "Netrunner",
      portraitUrls: ["/api/storage/objects/a", "/api/storage/objects/b"],
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);

    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.background).toBe("A new bio.");
    expect(row.archetype).toBe("Netrunner");
    expect(row.portraitUrls).toEqual(["/api/storage/objects/a", "/api/storage/objects/b"]);
    expect(await pendingCount(c.id)).toBe(0);
  });

  it("applies a sheet preamble-only change without review", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id, {
      sheetData: { preamble: "old", sections: { Body: "5" } },
    });

    const res = await patch(u.id, c.id, {
      sheetData: { preamble: "new preamble", sections: { Body: "5" } },
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);
    expect(await pendingCount(c.id)).toBe(0);
  });

  it("auto-applies a cosmetic edit that carries an updateNote (note logged)", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id);

    const res = await patch(u.id, c.id, {
      background: "Fresh bio.",
      updateNote: "tidied up my backstory",
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);
    expect(await pendingCount(c.id)).toBe(0);

    const notes = await db
      .select()
      .from(characterUpdates)
      .where(eq(characterUpdates.characterId, c.id));
    expect(notes.length).toBe(1);
    expect(notes[0].note).toBe("tidied up my backstory");
  });

  it("queues a name change for review (202, pending edit created)", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id);

    const res = await patch(u.id, c.id, { name: "Renamed" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(await pendingCount(c.id)).toBe(1);

    // The live row is untouched until a reviewer approves.
    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.name).toBe("Edit Target");
  });

  it("queues a stat-section change (sheetData.sections) for review", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id, {
      sheetData: { preamble: "p", sections: { Body: "5" } },
    });

    const res = await patch(u.id, c.id, {
      sheetData: { preamble: "p", sections: { Body: "9" } },
    });
    expect(res.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);
  });

  it("queues a mixed cosmetic+meaningful edit for review (the meaningful field wins)", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id);

    const res = await patch(u.id, c.id, {
      portraitUrl: "/api/storage/objects/x",
      name: "Renamed",
    });
    expect(res.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);

    // Nothing applied yet — even the cosmetic portrait waits for the review.
    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.portraitUrl).toBeNull();
    expect(row.name).toBe("Edit Target");
  });
});
