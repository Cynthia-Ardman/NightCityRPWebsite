import { describe, it, expect } from "vitest";
import request from "supertest";
import { eq, and, desc } from "drizzle-orm";
import { db, characters, characterTagOptions, auditLog, customRequests } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();

function createFixer(opts: { id?: string; username?: string } = {}) {
  return createUser({ ...opts, roles: ["fixer"] });
}

async function seedTagOption(name: string) {
  await db
    .insert(characterTagOptions)
    .values({ name })
    .onConflictDoNothing();
}

describe("PATCH /characters/:id/tags", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(app)
      .patch("/api/characters/1/tags")
      .send({ tags: [] });
    expect(res.status).toBe(401);
  });

  it("404s for a non-owner non-staff caller", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/tags`)
      .set("x-test-user", stranger.id)
      .send({ tags: [] });
    expect(res.status).toBe(404);
  });

  it("lets the owner add registry tags (case-insensitive → canonical names) into manualTags", async () => {
    await seedTagOption("Solo");
    await seedTagOption("Netrunner");
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });

    const res = await request(app)
      .patch(`/api/characters/${char.id}/tags`)
      .set("x-test-user", owner.id)
      .send({ tags: ["solo", "NETRUNNER"] });
    expect(res.status).toBe(200);
    expect([...res.body.tags].sort()).toEqual(["Netrunner", "Solo"]);

    const [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect([...(row.manualTags ?? [])].sort()).toEqual(["Netrunner", "Solo"]);
    expect(row.appliedTags ?? []).toEqual([]);
  });

  it("rejects tags not in the registry with 400", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const res = await request(app)
      .patch(`/api/characters/${char.id}/tags`)
      .set("x-test-user", owner.id)
      .send({ tags: ["totally-made-up-tag-xyz"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("totally-made-up-tag-xyz");
  });

  it("removes tags omitted from the desired set, keeping Discord-applied tags the caller kept", async () => {
    await seedTagOption("Solo");
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await db
      .update(characters)
      .set({ appliedTags: ["edgerunner"], manualTags: ["Solo", "watchlist"] })
      .where(eq(characters.id, char.id));

    // Keep "edgerunner" (Discord-applied, not in registry — allowed because the
    // character already carries it) and "Solo"; drop "watchlist".
    const res = await request(app)
      .patch(`/api/characters/${char.id}/tags`)
      .set("x-test-user", owner.id)
      .send({ tags: ["edgerunner", "Solo"] });
    expect(res.status).toBe(200);
    expect([...res.body.tags].sort()).toEqual(["Solo", "edgerunner"]);

    const [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(row.appliedTags).toEqual(["edgerunner"]);
    expect(row.manualTags).toEqual(["Solo"]);
  });

  it("lets fixers and admins edit any character's tags and writes an audit row", async () => {
    await seedTagOption("VIP");
    const owner = await createUser();
    const fixer = await createFixer();
    const admin = await createAdmin();
    const char = await createCharacter({ ownerId: owner.id, name: "Audited Merc" });

    const fr = await request(app)
      .patch(`/api/characters/${char.id}/tags`)
      .set("x-test-user", fixer.id)
      .send({ tags: ["VIP"] });
    expect(fr.status).toBe(200);
    expect(fr.body.tags).toEqual(["VIP"]);

    const ar = await request(app)
      .patch(`/api/characters/${char.id}/tags`)
      .set("x-test-user", admin.id)
      .send({ tags: [] });
    expect(ar.status).toBe(200);
    expect(ar.body.tags).toEqual([]);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "tags_edit"), eq(auditLog.targetId, String(char.id))))
      .orderBy(desc(auditLog.createdAt));
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.actorId === fixer.id)).toBe(true);
    expect(rows.some((r) => r.actorId === admin.id)).toBe(true);
  });

  it("no-op saves skip the audit row", async () => {
    await seedTagOption("Solo");
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await db.update(characters).set({ manualTags: ["Solo"] }).where(eq(characters.id, char.id));

    const res = await request(app)
      .patch(`/api/characters/${char.id}/tags`)
      .set("x-test-user", owner.id)
      .send({ tags: ["Solo"] });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "tags_edit"), eq(auditLog.targetId, String(char.id))));
    expect(rows.length).toBe(0);
  });

  it("diverts approval-gated tags into a pending character_tag request for players", async () => {
    await db
      .insert(characterTagOptions)
      .values({ name: "Gated", requiresApproval: true })
      .onConflictDoNothing();
    await seedTagOption("Free");
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });

    const res = await request(app)
      .patch(`/api/characters/${char.id}/tags`)
      .set("x-test-user", owner.id)
      .send({ tags: ["Free", "gated"] });
    expect(res.status).toBe(200);
    // Non-gated tag applied instantly; gated one queued, not applied.
    expect(res.body.tags).toEqual(["Free"]);
    expect(res.body.queuedForApproval).toEqual(["Gated"]);

    const [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(row.manualTags).toEqual(["Free"]);

    const reqs = await db
      .select()
      .from(customRequests)
      .where(and(eq(customRequests.type, "character_tag"), eq(customRequests.characterId, char.id)));
    expect(reqs.length).toBe(1);
    expect(reqs[0].status).toBe("pending");
    expect((reqs[0].details as { tag?: string })?.tag).toBe("Gated");

    // Re-submitting the same desired set must NOT create a duplicate request.
    const again = await request(app)
      .patch(`/api/characters/${char.id}/tags`)
      .set("x-test-user", owner.id)
      .send({ tags: ["Free", "Gated"] });
    expect(again.status).toBe(200);
    expect(again.body.queuedForApproval).toEqual(["Gated"]);
    const reqs2 = await db
      .select()
      .from(customRequests)
      .where(and(eq(customRequests.type, "character_tag"), eq(customRequests.characterId, char.id)));
    expect(reqs2.length).toBe(1);
  });

  it("lets staff apply approval-gated tags instantly (bypass)", async () => {
    await db
      .insert(characterTagOptions)
      .values({ name: "StaffGated", requiresApproval: true })
      .onConflictDoNothing();
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });

    const res = await request(app)
      .patch(`/api/characters/${char.id}/tags`)
      .set("x-test-user", fixer.id)
      .send({ tags: ["StaffGated"] });
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(["StaffGated"]);
    expect(res.body.queuedForApproval ?? []).toEqual([]);
  });
});

describe("PATCH /directory/tag-options/:id (role link + approval flag)", () => {
  it("lets staff set discordRoleId and requiresApproval, rejects bad role IDs", async () => {
    const fixer = await createFixer();
    const [opt] = await db
      .insert(characterTagOptions)
      .values({ name: "RoleLinked" })
      .onConflictDoNothing()
      .returning();

    const bad = await request(app)
      .patch(`/api/directory/tag-options/${opt.id}`)
      .set("x-test-user", fixer.id)
      .send({ discordRoleId: "not-a-role" });
    expect(bad.status).toBe(400);

    const res = await request(app)
      .patch(`/api/directory/tag-options/${opt.id}`)
      .set("x-test-user", fixer.id)
      .send({ discordRoleId: "123456789012345678", requiresApproval: true });
    expect(res.status).toBe(200);
    expect(res.body.discordRoleId).toBe("123456789012345678");
    expect(res.body.requiresApproval).toBe(true);
    expect(res.body.name).toBe("RoleLinked");

    // Unlink with null; name untouched.
    const unlink = await request(app)
      .patch(`/api/directory/tag-options/${opt.id}`)
      .set("x-test-user", fixer.id)
      .send({ discordRoleId: null });
    expect(unlink.status).toBe(200);
    expect(unlink.body.discordRoleId).toBeNull();
    expect(unlink.body.requiresApproval).toBe(true);

    // GET list surfaces the new fields.
    const list = await request(app).get("/api/directory/tag-options").set("x-test-user", fixer.id);
    expect(list.status).toBe(200);
    const row = (list.body as Array<{ id: number; discordRoleId: string | null; requiresApproval: boolean }>).find(
      (r) => r.id === opt.id,
    );
    expect(row?.requiresApproval).toBe(true);
    expect(row?.discordRoleId).toBeNull();
  });

  it("approving a character_tag request applies the tag on close", async () => {
    await db
      .insert(characterTagOptions)
      .values({ name: "CloseGated", requiresApproval: true })
      .onConflictDoNothing();
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });

    const submit = await request(app)
      .patch(`/api/characters/${char.id}/tags`)
      .set("x-test-user", owner.id)
      .send({ tags: ["CloseGated"] });
    expect(submit.status).toBe(200);
    const [reqRow] = await db
      .select()
      .from(customRequests)
      .where(and(eq(customRequests.type, "character_tag"), eq(customRequests.characterId, char.id)));
    expect(reqRow).toBeTruthy();

    // Two approver votes decide it, then close materializes the tag.
    const f1 = await createUser({ roles: ["fixer", "cs approver"] });
    const f2 = await createUser({ roles: ["fixer", "cs approver"] });
    await request(app).post(`/api/requests/${reqRow.id}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    const decide = await request(app)
      .post(`/api/requests/${reqRow.id}/vote`)
      .set("x-test-user", f2.id)
      .send({ vote: "approve" });
    expect(decide.body.status).toBe("approved");

    const close = await request(app)
      .post(`/api/review/request/${reqRow.id}/close`)
      .set("x-test-user", f1.id)
      .send({});
    expect(close.status).toBe(200);

    const [row] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(row.manualTags ?? []).toContain("CloseGated");
  });

  it("GET /characters/:id returns the merged tags list", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await db
      .update(characters)
      .set({ appliedTags: ["solo"], manualTags: ["watchlist", "SOLO"] })
      .where(eq(characters.id, char.id));

    const res = await request(app)
      .get(`/api/characters/${char.id}`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    expect([...res.body.tags].sort()).toEqual(["solo", "watchlist"]);
  });
});
