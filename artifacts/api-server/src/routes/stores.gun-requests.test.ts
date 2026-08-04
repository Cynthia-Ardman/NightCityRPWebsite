import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { db, stores, storeEmployees, customRequests } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();

// ── helpers ──────────────────────────────────────────────────────────────────

async function makeGunStore(ownerId: string, name = "Dev Arms") {
  const [s] = await db
    .insert(stores)
    .values({ ownerId, name, kind: "guns" })
    .returning();
  return s;
}

async function makeGunRequest(
  storeId: number,
  characterId: number,
  requestedById: string,
  status: string,
  title = "Test Gun",
) {
  const [r] = await db
    .insert(customRequests)
    .values({
      type: "gun",
      characterId,
      requestedById,
      title,
      status,
      details: { storeId, storeName: "Dev Arms" } as never,
    })
    .returning();
  return r;
}

// ── authz tests ───────────────────────────────────────────────────────────────

describe("GET /stores/:id/gun-requests — authz", () => {
  it("401s when unauthenticated", async () => {
    const owner = await createUser();
    const store = await makeGunStore(owner.id);
    const res = await request(app).get(`/api/stores/${store.id}/gun-requests`);
    expect(res.status).toBe(401);
  });

  it("403s for a user with no relationship to the store", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const store = await makeGunStore(owner.id);
    const res = await request(app)
      .get(`/api/stores/${store.id}/gun-requests`)
      .set("x-test-user", stranger.id);
    expect(res.status).toBe(403);
  });

  it("200s for the store owner", async () => {
    const owner = await createUser();
    const store = await makeGunStore(owner.id);
    const res = await request(app)
      .get(`/api/stores/${store.id}/gun-requests`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("200s for a staff (fixer) user", async () => {
    const owner = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    const store = await makeGunStore(owner.id);
    const res = await request(app)
      .get(`/api/stores/${store.id}/gun-requests`)
      .set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("200s for an employee of the store", async () => {
    const owner = await createUser();
    const empUser = await createUser();
    const empChar = await createCharacter({ ownerId: empUser.id });
    const store = await makeGunStore(owner.id);
    await db
      .insert(storeEmployees)
      .values({ storeId: store.id, characterId: empChar.id, role: "clerk" });
    const res = await request(app)
      .get(`/api/stores/${store.id}/gun-requests`)
      .set("x-test-user", empUser.id);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("404s when the store does not exist", async () => {
    const user = await createUser();
    const res = await request(app)
      .get(`/api/stores/999999/gun-requests`)
      .set("x-test-user", user.id);
    expect(res.status).toBe(404);
  });
});

// ── terminal-status filtering ─────────────────────────────────────────────────

describe("GET /stores/:id/gun-requests — status filtering", () => {
  it("excludes terminal statuses (approved, rejected, closed, cancelled)", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const store = await makeGunStore(owner.id);

    for (const status of ["approved", "rejected", "closed", "cancelled"]) {
      await makeGunRequest(store.id, char.id, owner.id, status, `Terminal ${status}`);
    }

    const res = await request(app)
      .get(`/api/stores/${store.id}/gun-requests`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("includes pending and changes_requested", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const store = await makeGunStore(owner.id);

    await makeGunRequest(store.id, char.id, owner.id, "pending", "Pending Gun");
    await makeGunRequest(store.id, char.id, owner.id, "changes_requested", "Changes Requested Gun");

    const res = await request(app)
      .get(`/api/stores/${store.id}/gun-requests`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const statuses = res.body.map((r: { status: string }) => r.status);
    expect(statuses).toContain("pending");
    expect(statuses).toContain("changes_requested");
  });

  it("includes draft requests", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const store = await makeGunStore(owner.id);

    await makeGunRequest(store.id, char.id, owner.id, "draft", "Draft Gun");

    const res = await request(app)
      .get(`/api/stores/${store.id}/gun-requests`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe("draft");
  });

  it("returns only requests for THIS store, not others", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const storeA = await makeGunStore(owner.id, "Store A");
    const storeB = await makeGunStore(owner.id, "Store B");

    await makeGunRequest(storeA.id, char.id, owner.id, "pending", "Gun for A");
    await makeGunRequest(storeB.id, char.id, owner.id, "pending", "Gun for B");

    const res = await request(app)
      .get(`/api/stores/${storeA.id}/gun-requests`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe("Gun for A");
  });

  it("returns expected fields on each item", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const store = await makeGunStore(owner.id);

    await makeGunRequest(store.id, char.id, owner.id, "pending", "Militech Lexington");

    const res = await request(app)
      .get(`/api/stores/${store.id}/gun-requests`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const item = res.body[0];
    expect(typeof item.id).toBe("number");
    expect(item.title).toBe("Militech Lexington");
    expect(item.status).toBe("pending");
    expect(typeof item.createdAt).toBe("string");
    expect(item.requestedById).toBe(owner.id);
    // requestedByName is joined from users
    expect(typeof item.requestedByName).toBe("string");
  });
});
