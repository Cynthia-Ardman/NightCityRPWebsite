import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, characters } from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildTestApp } from "./app";
import { createUser, createAdmin } from "./testDb";

const app = buildTestApp();

describe("POST /admin/characters (manual character creation)", () => {
  it("creates an unclaimed, approved character with just a name", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post("/api/admin/characters")
      .set("x-test-user", admin.id)
      .send({ name: "  V  " });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("V");
    expect(res.body.kind).toBe("pc");
    expect(res.body.approved).toBe(true);
    expect(res.body.claimed).toBe(false);
    expect(res.body.ownerId).toBeNull();
    expect(res.body.lifeStatus).toBe("active");

    const [row] = await db.select().from(characters).where(eq(characters.id, res.body.id));
    expect(row.name).toBe("V");
    expect(row.approved).toBe(true);
  });

  it("assigns an owner and marks the character claimed, syncing portraitUrl", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const res = await request(app)
      .post("/api/admin/characters")
      .set("x-test-user", admin.id)
      .send({
        name: "Jackie",
        kind: "npc",
        ownerId: player.id,
        archetype: "Solo",
        background: "Heart of gold.",
        lifeStatus: "dead",
        portraitUrls: ["/api/storage/objects/abc", "", "/api/storage/objects/def"],
      });
    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(player.id);
    expect(res.body.claimed).toBe(true);
    expect(res.body.kind).toBe("npc");
    expect(res.body.lifeStatus).toBe("dead");
    expect(res.body.archetype).toBe("Solo");
    // Empty strings are filtered out; first surviving image backfills portraitUrl.
    expect(res.body.portraitUrls).toEqual(["/api/storage/objects/abc", "/api/storage/objects/def"]);
    expect(res.body.portraitUrl).toBe("/api/storage/objects/abc");
  });

  it("rejects a missing/blank name with 400", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post("/api/admin/characters")
      .set("x-test-user", admin.id)
      .send({ name: "   " });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid kind and lifeStatus with 400", async () => {
    const admin = await createAdmin();
    const badKind = await request(app)
      .post("/api/admin/characters")
      .set("x-test-user", admin.id)
      .send({ name: "X", kind: "boss" });
    expect(badKind.status).toBe(400);

    const badLife = await request(app)
      .post("/api/admin/characters")
      .set("x-test-user", admin.id)
      .send({ name: "X", lifeStatus: "zombie" });
    expect(badLife.status).toBe(400);
  });

  it("returns 404 when the supplied owner does not exist", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post("/api/admin/characters")
      .set("x-test-user", admin.id)
      .send({ name: "Ghost", ownerId: "nonexistent-user-id" });
    expect(res.status).toBe(404);
  });

  it("forbids a fixer (admin-only endpoint, 403)", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const res = await request(app)
      .post("/api/admin/characters")
      .set("x-test-user", fixer.id)
      .send({ name: "Fixer Made" });
    expect(res.status).toBe(403);
  });

  it("forbids a plain player (403) and unauthenticated (401)", async () => {
    const player = await createUser();
    const forbidden = await request(app)
      .post("/api/admin/characters")
      .set("x-test-user", player.id)
      .send({ name: "Nope" });
    expect(forbidden.status).toBe(403);

    const unauth = await request(app).post("/api/admin/characters").send({ name: "Nope" });
    expect(unauth.status).toBe(401);
  });
});
