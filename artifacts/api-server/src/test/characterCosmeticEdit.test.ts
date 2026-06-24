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

  it("applies a portraitUrls gallery change without review", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id);

    const res = await patch(u.id, c.id, {
      portraitUrls: ["/api/storage/objects/a", "/api/storage/objects/b"],
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);

    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.portraitUrls).toEqual(["/api/storage/objects/a", "/api/storage/objects/b"]);
    expect(await pendingCount(c.id)).toBe(0);
  });

  it("queues a background CONTENT change for review", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id, { background: "Born in Heywood." });

    const res = await patch(u.id, c.id, { background: "Born in Watson, not Heywood." });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(await pendingCount(c.id)).toBe(1);

    // Live row untouched until a reviewer approves.
    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.background).toBe("Born in Heywood.");
  });

  it("auto-applies a background reformat that keeps the same words", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id, { background: "Born in Heywood. Raised by nomads." });

    // Same words, only markdown / whitespace / line-break formatting differs.
    const reformatted = "**Born** in Heywood.\n\nRaised   by nomads.";
    const res = await patch(u.id, c.id, { background: reformatted });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);
    expect(await pendingCount(c.id)).toBe(0);

    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.background).toBe(reformatted);
  });

  it("queues an archetype change for review", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id, { archetype: "Solo" });

    const res = await patch(u.id, c.id, { archetype: "Netrunner" });
    expect(res.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);

    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.archetype).toBe("Solo");
  });

  it("queues a sheet preamble CONTENT change for review", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id, {
      sheetData: { preamble: "A quiet merc.", sections: { Body: "5" } },
    });

    const res = await patch(u.id, c.id, {
      sheetData: { preamble: "A loud, reckless merc.", sections: { Body: "5" } },
    });
    expect(res.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);
  });

  it("auto-applies a sheet reformat that keeps the same words", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id, {
      sheetData: { preamble: "A quiet merc from Heywood", sections: { Body: "5" } },
    });

    // Same words, only formatting / whitespace differs.
    const res = await patch(u.id, c.id, {
      sheetData: { preamble: "A *quiet* merc\nfrom Heywood", sections: { Body: "5" } },
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);
    expect(await pendingCount(c.id)).toBe(0);
  });

  it("auto-applies re-sectioning that moves prose around without changing words", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id, {
      sheetData: {
        preamble: "",
        sections: { History: "Born in Heywood raised by nomads" },
      },
    });

    // Player splits one section into two newly-named sections, redistributing the
    // exact same words. Section titles are structure, so this stays cosmetic.
    const res = await patch(u.id, c.id, {
      sheetData: {
        preamble: "",
        sections: { Origins: "Born in Heywood", Family: "raised by nomads" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);
    expect(await pendingCount(c.id)).toBe(0);
  });

  it("queues a discrete story-field edit for review (preserving non-story keys in the diff)", async () => {
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
    // untouched gear/identity it spread off the existing sheetData. A change to a
    // discrete story field (physicalDescription/appearance/…) is MEANINGFUL — it
    // must go through review, NOT auto-apply. (Regression: it previously slipped
    // through as "cosmetic" because only `sections` was compared, so a player's
    // edit silently applied with no review request.)
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
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(await pendingCount(c.id)).toBe(1);

    // The live row is untouched until a reviewer approves.
    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect((row.sheetData as Record<string, unknown>).physicalDescription).toBe("tall");

    // The proposed diff carries the full merged blob, including the non-story
    // keys spread off the original sheetData (passthrough survives the parse).
    const [edit] = await db
      .select()
      .from(pendingCharacterEdits)
      .where(eq(pendingCharacterEdits.characterId, c.id));
    const proposed = (edit.proposedDiff as { sheetData?: Record<string, unknown> }).sheetData ?? {};
    expect(proposed.physicalDescription).toBe("taller now");
    expect(proposed.appearance).toBe("neon jacket");
    expect(proposed.gear).toEqual(["knife"]);
    expect(proposed.identity).toEqual({ handle: "Ghost" });
  });

  it("auto-applies a preamble reformat (same words) even when discrete story fields exist", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id, {
      sheetData: {
        preamble: "a quiet framing",
        sections: {},
        physicalDescription: "tall",
        appearance: "neon jacket",
      },
    });

    // The preamble is only reformatted (same words) and every other field is
    // unchanged, so this stays cosmetic and applies on the spot.
    const res = await patch(u.id, c.id, {
      sheetData: {
        preamble: "**a** *quiet*\nframing",
        sections: {},
        physicalDescription: "tall",
        appearance: "neon jacket",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);
    expect(await pendingCount(c.id)).toBe(0);
  });

  it("queues a preamble CONTENT change for review when discrete story fields exist", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id, {
      sheetData: {
        preamble: "a quiet framing",
        sections: {},
        physicalDescription: "tall",
        appearance: "neon jacket",
      },
    });

    // The preamble gains new words — that is content, so it goes to review even
    // though nothing else changed.
    const res = await patch(u.id, c.id, {
      sheetData: {
        preamble: "a quiet framing with a dark secret",
        sections: {},
        physicalDescription: "tall",
        appearance: "neon jacket",
      },
    });
    expect(res.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);
  });

  it("auto-applies a cosmetic edit that carries an updateNote (note logged)", async () => {
    const u = await createUser();
    const c = await ownedChar(u.id);

    const res = await patch(u.id, c.id, {
      portraitUrl: "/api/storage/objects/fresh-portrait",
      updateNote: "swapped my portrait",
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApplied).toBe(true);
    expect(await pendingCount(c.id)).toBe(0);

    const notes = await db
      .select()
      .from(characterUpdates)
      .where(eq(characterUpdates.characterId, c.id));
    expect(notes.length).toBe(1);
    expect(notes[0].note).toBe("swapped my portrait");
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

describe("staff (admin/fixer) character edits still go through review", () => {
  it("queues an admin's stats-image change for review (no instant-apply)", async () => {
    const admin = await createAdmin();
    const owner = await createUser();
    const c = await ownedChar(owner.id);

    const res = await patch(admin.id, c.id, {
      statsImageUrls: ["/api/storage/objects/stats-1", "/api/storage/objects/stats-2"],
    });
    // There is deliberately no admin instant-apply path: a meaningful edit by
    // an admin is queued for fixer review like anyone else's.
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(await pendingCount(c.id)).toBe(1);

    // Live row untouched until a reviewer approves.
    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.statsImageUrls ?? []).toEqual([]);
  });

  it("queues an admin's mixed name + stat-section + image edit for review", async () => {
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
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(await pendingCount(c.id)).toBe(1);

    // Nothing applied — the live row keeps its original values.
    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.name).toBe("Edit Target");
    expect((row.sheetData as { sections?: Record<string, string> } | null)?.sections).toEqual({
      Body: "5",
    });
  });

  it("stores an updateNote on the queued edit when an admin edit carries one", async () => {
    const admin = await createAdmin();
    const owner = await createUser();
    const c = await ownedChar(owner.id);

    const res = await patch(admin.id, c.id, {
      name: "Admin Rename",
      updateNote: "fixed their stat screenshot",
    });
    expect(res.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);

    // The note rides on the pending edit row; it lands in the characterUpdates
    // changelog only when a reviewer approves, not on submission.
    const [edit] = await db
      .select()
      .from(pendingCharacterEdits)
      .where(eq(pendingCharacterEdits.characterId, c.id));
    expect(edit.updateNote).toBe("fixed their stat screenshot");
    const notes = await db
      .select()
      .from(characterUpdates)
      .where(eq(characterUpdates.characterId, c.id));
    expect(notes.length).toBe(0);
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

  it("refuses a second non-admin user's edit while another's edit is still pending (409)", async () => {
    const owner = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    const c = await ownedChar(owner.id);

    // Owner queues a stats-image edit (parked for review).
    const queued = await patch(owner.id, c.id, {
      statsImageUrls: ["/api/storage/objects/stale"],
    });
    expect(queued.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);

    // A fixer's meaningful edit no longer instant-applies. Since a DIFFERENT
    // user already holds the in-flight edit for this character, the fixer's
    // edit is refused rather than spawning a duplicate or clobbering it.
    // (Only an ADMIN may amend another user's in-flight edit in place.)
    const blocked = await patch(fixer.id, c.id, {
      statsImageUrls: ["/api/storage/objects/admin"],
    });
    expect(blocked.status).toBe(409);

    // The original pending edit is untouched (still pending, original diff —
    // the fixer's value never overwrote the owner's queued payload).
    const [pending] = await db
      .select()
      .from(pendingCharacterEdits)
      .where(eq(pendingCharacterEdits.characterId, c.id));
    expect(pending.status).toBe("pending");
    expect((pending.proposedDiff as { statsImageUrls?: string[] }).statsImageUrls).toEqual([
      "/api/storage/objects/stale",
    ]);
    expect(await pendingCount(c.id)).toBe(1);

    // The live row was never modified.
    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.statsImageUrls ?? []).toEqual([]);
  });

  it("lets an admin amend another user's in-flight edit in place (202, single row)", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const c = await ownedChar(owner.id);

    // Owner queues a stats-image edit (parked for review).
    const queued = await patch(owner.id, c.id, {
      statsImageUrls: ["/api/storage/objects/stale"],
    });
    expect(queued.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);

    // Unlike a fixer, an ADMIN may amend the in-flight edit in place: the same
    // row is reused (no duplicate), its proposed content is swapped to the
    // admin's value, and it stays pending for review.
    const amended = await patch(admin.id, c.id, {
      statsImageUrls: ["/api/storage/objects/admin"],
    });
    expect(amended.status).toBe(202);
    expect(await pendingCount(c.id)).toBe(1);

    const [pending] = await db
      .select()
      .from(pendingCharacterEdits)
      .where(eq(pendingCharacterEdits.characterId, c.id));
    expect(pending.status).toBe("pending");
    expect((pending.proposedDiff as { statsImageUrls?: string[] }).statsImageUrls).toEqual([
      "/api/storage/objects/admin",
    ]);

    // The live row is still untouched — the amend only updates the pending edit.
    const [row] = await db.select().from(characters).where(eq(characters.id, c.id));
    expect(row.statsImageUrls ?? []).toEqual([]);
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
