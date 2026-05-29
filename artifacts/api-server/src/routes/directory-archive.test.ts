import { describe, it, expect } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, characters, auditLog, characterUpdates, inventoryItems } from "@workspace/db";
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

  it("filters by a single life status", async () => {
    const admin = await createAdmin();
    const dead = await createCharacter({ name: "Dead One", lifeStatus: "dead" });
    const active = await createCharacter({ name: "Active One", lifeStatus: "active" });

    const res = await request(app)
      .get("/api/directory/archive?status=dead")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(dead.id);
    expect(ids).not.toContain(active.id);
  });

  it("filters by multiple life statuses (matches ANY)", async () => {
    const admin = await createAdmin();
    const loa = await createCharacter({ name: "On LOA", lifeStatus: "loa" });
    const missing = await createCharacter({ name: "Gone Missing", lifeStatus: "missing" });
    const active = await createCharacter({ name: "Still Here", lifeStatus: "active" });

    const res = await request(app)
      .get("/api/directory/archive?status=loa,missing")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(loa.id);
    expect(ids).toContain(missing.id);
    expect(ids).not.toContain(active.id);
  });

  it("ignores unknown status values instead of erroring", async () => {
    const admin = await createAdmin();
    await createCharacter({ name: "Anyone" });
    const res = await request(app)
      .get("/api/directory/archive?status=bogus")
      .set("x-test-user", admin.id);
    // unknown value drops out → no status filter → full roster returns
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("filters by CWP band (medium/high/extreme)", async () => {
    const admin = await createAdmin();
    const high = await createCharacter({ name: "Chromed Up", cyberwareLevel: "high" });
    const none = await createCharacter({ name: "Bare Metal", cyberwareLevel: "none" });

    const res = await request(app)
      .get("/api/directory/archive?bands=high")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(high.id);
    expect(ids).not.toContain(none.id);
  });

  it("filters by multiple CWP bands (matches ANY)", async () => {
    const admin = await createAdmin();
    const high = await createCharacter({ name: "High Chrome", cyberwareLevel: "high" });
    const extreme = await createCharacter({ name: "Extreme Chrome", cyberwareLevel: "extreme" });
    const none = await createCharacter({ name: "No Chrome", cyberwareLevel: "none" });

    const res = await request(app)
      .get("/api/directory/archive?bands=high,extreme")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(high.id);
    expect(ids).toContain(extreme.id);
    expect(ids).not.toContain(none.id);
  });

  it("derives the band from real installed chrome, not the (empty) column", async () => {
    const admin = await createAdmin();
    // No cyberwareLevel override — band must come from the cyberware inventory.
    const char = await createCharacter({ name: "Real Chrome" });
    await db.insert(inventoryItems).values([
      { characterId: char.id, name: "Mantis Blades", notes: "CWP 6", quantity: 1, category: "cyberware" },
      { characterId: char.id, name: "Smart Eyes", notes: "CWP 4", quantity: 1, category: "cyberware" },
    ]);

    const res = await request(app).get("/api/directory/archive").set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const found = res.body.find((r: { id: number }) => r.id === char.id);
    // 6 + 4 = 10 CWP → "high" band (10-12), even though the column says "none".
    expect(found.cwpBand).toBe("high");
  });

  it("filters by a band derived from real installed chrome", async () => {
    const admin = await createAdmin();
    const extreme = await createCharacter({ name: "Loaded Up" });
    await db.insert(inventoryItems).values({
      characterId: extreme.id,
      name: "Full Borg",
      notes: "CWP 15",
      quantity: 1,
      category: "cyberware",
    });
    const bare = await createCharacter({ name: "Nothing Installed" });

    const res = await request(app)
      .get("/api/directory/archive?bands=extreme")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(extreme.id); // 15 CWP → extreme (13+)
    expect(ids).not.toContain(bare.id); // 0 CWP → none
  });

  it("an explicit medium/high/extreme override wins over real chrome", async () => {
    const admin = await createAdmin();
    // Column override says "medium" but installed chrome (15) would derive "extreme".
    const char = await createCharacter({ name: "Overridden", cyberwareLevel: "medium" });
    await db.insert(inventoryItems).values({
      characterId: char.id,
      name: "Full Borg",
      notes: "CWP 15",
      quantity: 1,
      category: "cyberware",
    });

    const res = await request(app).get("/api/directory/archive").set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const found = res.body.find((r: { id: number }) => r.id === char.id);
    expect(found.cwpBand).toBe("medium");
  });

  it("filters by the organic band (isOrganic wins over level)", async () => {
    const admin = await createAdmin();
    const organic = await createCharacter({ name: "All Meat", cyberwareLevel: "none" });
    await db.update(characters).set({ isOrganic: true }).where(eq(characters.id, organic.id));
    const chromed = await createCharacter({ name: "Has Chrome", cyberwareLevel: "medium" });

    const res = await request(app)
      .get("/api/directory/archive?bands=organic")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(organic.id);
    expect(ids).not.toContain(chromed.id);
  });

  it("the 'none' band excludes organic and chromed characters", async () => {
    const admin = await createAdmin();
    const none = await createCharacter({ name: "Plain None", cyberwareLevel: "none" });
    const organic = await createCharacter({ name: "Meat Bag", cyberwareLevel: "none" });
    await db.update(characters).set({ isOrganic: true }).where(eq(characters.id, organic.id));
    const high = await createCharacter({ name: "Loaded", cyberwareLevel: "high" });

    const res = await request(app)
      .get("/api/directory/archive?bands=none")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(none.id);
    expect(ids).not.toContain(organic.id);
    expect(ids).not.toContain(high.id);
  });

  it("combines status and band filters (AND across facets)", async () => {
    const admin = await createAdmin();
    const match = await createCharacter({ name: "Dead And Chromed", lifeStatus: "dead", cyberwareLevel: "extreme" });
    const wrongStatus = await createCharacter({ name: "Active Chromed", lifeStatus: "active", cyberwareLevel: "extreme" });
    const wrongBand = await createCharacter({ name: "Dead Clean", lifeStatus: "dead", cyberwareLevel: "none" });

    const res = await request(app)
      .get("/api/directory/archive?status=dead&bands=extreme")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(match.id);
    expect(ids).not.toContain(wrongStatus.id);
    expect(ids).not.toContain(wrongBand.id);
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

  it("sets the life status and records it in the audit before/after", async () => {
    const admin = await createAdmin();
    const char = await createCharacter({ name: "Status Test", lifeStatus: "active" });
    const res = await request(app)
      .patch(`/api/directory/archive/${char.id}`)
      .set("x-test-user", admin.id)
      .send({ commitMessage: "char died on stream", lifeStatus: "dead" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toContain("lifeStatus");

    const [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(row.lifeStatus).toBe("dead");

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, String(char.id)));
    expect((audit.beforeJson as Record<string, unknown>).lifeStatus).toBe("active");
    expect((audit.afterJson as Record<string, unknown>).lifeStatus).toBe("dead");
  });

  it("rejects an unknown life status with 400", async () => {
    const admin = await createAdmin();
    const char = await createCharacter({ name: "Bad Status" });
    const res = await request(app)
      .patch(`/api/directory/archive/${char.id}`)
      .set("x-test-user", admin.id)
      .send({ commitMessage: "nope", lifeStatus: "zombie" });
    expect(res.status).toBe(400);
  });
});

describe("GET /directory/archive/:id (staff-only editable detail)", () => {
  it("forbids non-staff callers with 403", async () => {
    const user = await createUser();
    const char = await createCharacter({ name: "Locked Detail" });
    const res = await request(app)
      .get(`/api/directory/archive/${char.id}`)
      .set("x-test-user", user.id);
    expect(res.status).toBe(403);
  });

  it("returns the editable detail (with cwpBand + merged tags) to staff", async () => {
    const admin = await createAdmin();
    const char = await createCharacter({ name: "Open Detail" });
    const res = await request(app)
      .get(`/api/directory/archive/${char.id}`)
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(char.id);
    expect(res.body.cwpBand).toBe("none");
    expect(Array.isArray(res.body.tags)).toBe(true);
  });
});
