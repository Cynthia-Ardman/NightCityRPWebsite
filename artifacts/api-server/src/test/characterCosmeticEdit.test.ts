import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, characters, characterUpdates, pendingCharacterEdits } from "@workspace/db";
import { buildTestApp } from "./app";
import request from "supertest";
import { createUser, createAdmin, createCharacter } from "./testDb";

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

  it("auto-applies a merged sheetData blob and preserves non-story keys (gear/identity)", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id, {
      sheetData: {
        preamble: "old",
        sections: {},
        physicalDescription: "tall",
        gear: ["knife"],
        identity: { handle: "Ghost" },
      },
    });

    // The edit dialog sends the whole merged blob: edited story fields plus the
    // untouched gear/identity it spread off the existing sheetData.
    const res = await patch(u.id, c.id, {
      sheetData: {
        preamble: "old",
        sections: {},
        physicalDescription: "taller now",
        appearance: "neon jacket",
        psychProfile: "",
        hooks: "",
        skills: "",
        gear: ["knife"],
        identity: { handle: "Ghost" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);
    expect(await pendingCount(c.id)).toBe(0);

    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    const sheet = row.sheetData as Record<string, unknown>;
    // Edited story fields landed...
    expect(sheet.physicalDescription).toBe("taller now");
    expect(sheet.appearance).toBe("neon jacket");
    // ...and the non-story keys survived the round-trip (passthrough).
    expect(sheet.gear).toEqual(["knife"]);
    expect(sheet.identity).toEqual({ handle: "Ghost" });
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

describe("admin character edits auto-apply (no review queue)", () => {
  it("applies a stats-image change immediately for an admin (no review)", async () => {
    const admin = await createAdmin();
    const owner = await createUser();
    const c = await ownedChar(owner.id);

    const res = await patch(admin.id, c.id, {
      statsImageUrls: ["/api/storage/objects/stats-1", "/api/storage/objects/stats-2"],
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);
    expect(await pendingCount(c.id)).toBe(0);

    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.statsImageUrls).toEqual([
      "/api/storage/objects/stats-1",
      "/api/storage/objects/stats-2",
    ]);
  });

  it("applies a mixed name + stat-section + image edit immediately for an admin", async () => {
    const admin = await createAdmin();
    const owner = await createUser();
    const c = await ownedChar(owner.id, {
      sheetData: { preamble: "p", sections: { Body: "5" } },
    });

    const res = await patch(admin.id, c.id, {
      name: "Renamed By Admin",
      sheetData: { preamble: "p", sections: { Body: "9" } },
      portraitUrls: ["/api/storage/objects/p"],
      statsImageUrls: ["/api/storage/objects/s"],
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);
    expect(await pendingCount(c.id)).toBe(0);

    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.name).toBe("Renamed By Admin");
    expect((row.sheetData as { sections?: Record<string, string> } | null)?.sections).toEqual({
      Body: "9",
    });
    expect(row.portraitUrls).toEqual(["/api/storage/objects/p"]);
    expect(row.statsImageUrls).toEqual(["/api/storage/objects/s"]);
  });

  it("logs an updateNote when an admin edit carries one", async () => {
    const admin = await createAdmin();
    const owner = await createUser();
    const c = await ownedChar(owner.id);

    const res = await patch(admin.id, c.id, {
      name: "Admin Rename",
      updateNote: "fixed their stat screenshot",
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);

    const notes = await db
      .select()
      .from(characterUpdates)
      .where(eq(characterUpdates.characterId, c.id));
    expect(notes.length).toBe(1);
    expect(notes[0].note).toBe("fixed their stat screenshot");
  });

  it("still queues a non-admin's stats-image change for review", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id);

    const res = await patch(u.id, c.id, {
      statsImageUrls: ["/api/storage/objects/stats-1"],
    });
    expect(res.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);

    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.statsImageUrls ?? []).toEqual([]);
  });

  it("supersedes an in-flight pending edit so it can't later clobber the admin change", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const c = await ownedChar(owner.id);

    // Owner queues a stats-image edit (parked for review).
    const queued = await patch(owner.id, c.id, {
      statsImageUrls: ["/api/storage/objects/stale"],
    });
    expect(queued.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);

    // Admin directly applies a different stats image.
    const applied = await patch(admin.id, c.id, {
      statsImageUrls: ["/api/storage/objects/admin"],
    });
    expect(applied.status).toBe(200);
    expect(applied.body.autoApplied).toBe(true);

    // The previously-pending edit is now cancelled (superseded), not pending.
    const [pending] = await db
      .select()
      .from(pendingCharacterEdits)
      .where(eq(pendingCharacterEdits.characterId, c.id));
    expect(pending.status).toBe("cancelled");

    // The admin's change is the live state.
    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.statsImageUrls).toEqual(["/api/storage/objects/admin"]);
  });

  it("lets a fixer edit a non-owned character but still queues it for review", async () => {
    const owner = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    const c = await ownedChar(owner.id);

    const res = await patch(fixer.id, c.id, {
      statsImageUrls: ["/api/storage/objects/fixer"],
    });
    expect(res.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);

    // Not applied — fixers go through review, they do not bypass it.
    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.statsImageUrls ?? []).toEqual([]);
  });
});
