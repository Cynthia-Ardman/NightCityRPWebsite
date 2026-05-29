import { describe, it, expect } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, characters, auditLog, characterUpdates } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();

function createFixer(opts: { id?: string; username?: string } = {}) {
  return createUser({ ...opts, roles: ["fixer"] });
}

describe("GET /directory/archive (staff-only roster)", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(app).get("/api/directory/archive");
    expect(res.status).toBe(401);
  });

  it("forbids non-staff callers with 403", async () => {
    const user = await createUser();
    const res = await request(app).get("/api/directory/archive").set("x-test-user", user.id);
    expect(res.status).toBe(403);
  });

  it("allows fixers and admins", async () => {
    const fixer = await createFixer();
    const admin = await createAdmin();
    const fr = await request(app).get("/api/directory/archive").set("x-test-user", fixer.id);
    const ar = await request(app).get("/api/directory/archive").set("x-test-user", admin.id);
    expect(fr.status).toBe(200);
    expect(ar.status).toBe(200);
  });

  it("returns merged tags (applied ∪ manual) and a derived CWP band", async () => {
    const admin = await createAdmin();
    const char = await createCharacter({ name: "Tagged Merc", cyberwareLevel: "high" });
    await db
      .update(characters)
      .set({ appliedTags: ["solo", "edgerunner"], manualTags: ["watchlist", "solo"] })
      .where(eq(characters.id, char.id));

    const res = await request(app).get("/api/directory/archive").set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const found = res.body.find((r: { id: number }) => r.id === char.id);
    expect(found).toBeTruthy();
    // merged + de-duplicated (solo appears once)
    expect([...found.tags].sort()).toEqual(["edgerunner", "solo", "watchlist"]);
    expect(found.cwpBand).toBe("high");
    // raw tag columns are not leaked
    expect(found.appliedTags).toBeUndefined();
    expect(found.manualTags).toBeUndefined();
  });

  it("filters on the union of applied and manual tags", async () => {
    const admin = await createAdmin();
    const a = await createCharacter({ name: "Has Manual Tag" });
    const b = await createCharacter({ name: "No Match" });
    await db.update(characters).set({ manualTags: ["vip"] }).where(eq(characters.id, a.id));

    const res = await request(app)
      .get("/api/directory/archive?tags=vip")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
});

describe("PATCH /directory/archive/:id (immediate-apply staff edit)", () => {
  it("forbids non-staff callers with 403", async () => {
    const user = await createUser();
    const char = await createCharacter();
    const res = await request(app)
      .patch(`/api/directory/archive/${char.id}`)
      .set("x-test-user", user.id)
      .send({ commitMessage: "x", name: "Nope" });
    expect(res.status).toBe(403);
  });

  it("rejects a blank commit message with 400 and applies nothing", async () => {
    const admin = await createAdmin();
    const char = await createCharacter({ name: "Original" });
    const res = await request(app)
      .patch(`/api/directory/archive/${char.id}`)
      .set("x-test-user", admin.id)
      .send({ commitMessage: "   ", name: "Renamed" });
    expect(res.status).toBe(400);
    const [still] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(still.name).toBe("Original");
  });

  it("returns 400 when nothing actually changes", async () => {
    const admin = await createAdmin();
    const char = await createCharacter({ name: "SameName" });
    const res = await request(app)
      .patch(`/api/directory/archive/${char.id}`)
      .set("x-test-user", admin.id)
      .send({ commitMessage: "noop", name: "SameName" });
    expect(res.status).toBe(400);
  });

  it("applies edits immediately and writes audit + changelog rows", async () => {
    const admin = await createAdmin();
    const char = await createCharacter({ name: "Before Name", kind: "pc" });

    const res = await request(app)
      .patch(`/api/directory/archive/${char.id}`)
      .set("x-test-user", admin.id)
      .send({ commitMessage: "rename and flip to npc", name: "After Name", kind: "npc" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("After Name");
    expect(res.body.kind).toBe("npc");
    expect(res.body.changed.sort()).toEqual(["kind", "name"]);

    const [updated] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(updated.name).toBe("After Name");
    expect(updated.kind).toBe("npc");

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "archive_edit"));
    expect(audits.length).toBe(1);
    expect(audits[0].message).toBe("rename and flip to npc");
    expect(audits[0].targetId).toBe(String(char.id));
    expect(audits[0].beforeJson).toMatchObject({ name: "Before Name", kind: "pc" });
    expect(audits[0].afterJson).toMatchObject({ name: "After Name", kind: "npc" });

    const updates = await db
      .select()
      .from(characterUpdates)
      .where(eq(characterUpdates.characterId, char.id));
    expect(updates.length).toBe(1);
    expect(updates[0].note).toBe("rename and flip to npc");
  });

  it("preserves manually-added tags in the manual column so re-import can't wipe them", async () => {
    const admin = await createAdmin();
    const char = await createCharacter({ name: "Tag Owner" });
    await db.update(characters).set({ appliedTags: ["solo"] }).where(eq(characters.id, char.id));

    // staff sends the full desired merged set: keep "solo" (applied) + add "watchlist"
    const res = await request(app)
      .patch(`/api/directory/archive/${char.id}`)
      .set("x-test-user", admin.id)
      .send({ commitMessage: "add watchlist", tags: ["solo", "watchlist"] });
    expect(res.status).toBe(200);

    const [updated] = await db.select().from(characters).where(eq(characters.id, char.id));
    // "solo" stays in applied (Discord-synced); "watchlist" is stored separately
    expect(updated.appliedTags).toContain("solo");
    expect(updated.manualTags).toContain("watchlist");
    expect(updated.manualTags).not.toContain("solo");
  });

  it("reassigns owner and marks claimed; clearing owner marks unclaimed", async () => {
    const admin = await createAdmin();
    const owner = await createUser({ username: "newowner" });
    const char = await createCharacter({ name: "Unclaimed One", ownerId: null });
    await db.update(characters).set({ claimed: false }).where(eq(characters.id, char.id));

    const assign = await request(app)
      .patch(`/api/directory/archive/${char.id}`)
      .set("x-test-user", admin.id)
      .send({ commitMessage: "assign owner", ownerId: owner.id });
    expect(assign.status).toBe(200);
    let [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(row.ownerId).toBe(owner.id);
    expect(row.claimed).toBe(true);

    const clear = await request(app)
      .patch(`/api/directory/archive/${char.id}`)
      .set("x-test-user", admin.id)
      .send({ commitMessage: "unclaim", ownerId: null });
    expect(clear.status).toBe(200);
    [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(row.ownerId).toBeNull();
    expect(row.claimed).toBe(false);
  });

  it("404s when assigning a non-existent user", async () => {
    const admin = await createAdmin();
    const char = await createCharacter();
    const res = await request(app)
      .patch(`/api/directory/archive/${char.id}`)
      .set("x-test-user", admin.id)
      .send({ commitMessage: "bad owner", ownerId: "no-such-user" });
    expect(res.status).toBe(404);
  });

  it("overrides the CWP band via the staff editor", async () => {
    const admin = await createAdmin();
    const char = await createCharacter({ name: "Band Test", cyberwareLevel: "none" });
    const res = await request(app)
      .patch(`/api/directory/archive/${char.id}`)
      .set("x-test-user", admin.id)
      .send({ commitMessage: "bump band", cwpBand: "extreme" });
    expect(res.status).toBe(200);
    expect(res.body.cwpBand).toBe("extreme");
    const [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(row.cyberwareLevel).toBe("extreme");
    expect(row.isOrganic).toBe(false);
  });
});
