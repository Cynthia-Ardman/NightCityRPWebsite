import { describe, it, expect } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, lifestyleTiers } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

const app = buildTestApp();

async function makeTier(name: string, monthlyCost: number, archived = false) {
  const [t] = await db
    .insert(lifestyleTiers)
    .values({ name, monthlyCost, archived })
    .returning();
  return t;
}

describe("GET /catalog/lifestyle", () => {
  it("401s when unauthenticated", async () => {
    const res = await request(app).get("/api/catalog/lifestyle");
    expect(res.status).toBe(401);
  });

  it("returns active tiers ordered by monthlyCost and hides archived by default", async () => {
    const user = await createUser();
    await makeTier("Lux", 5000);
    await makeTier("Slum", 100);
    await makeTier("Gone", 200, true);

    const res = await request(app).get("/api/catalog/lifestyle").set("x-test-user", user.id);
    expect(res.status).toBe(200);
    const names = res.body.map((r: { name: string }) => r.name);
    expect(names).toEqual(["Slum", "Lux"]);
  });

  it("includes archived tiers when ?all=true", async () => {
    const user = await createUser();
    await makeTier("Slum", 100);
    await makeTier("Gone", 200, true);

    const res = await request(app)
      .get("/api/catalog/lifestyle?all=true")
      .set("x-test-user", user.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe("admin lifestyle-tier CRUD", () => {
  it("gates list/create/patch/delete behind the ADMIN role", async () => {
    const player = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    for (const u of [player, fixer]) {
      const list = await request(app).get("/api/admin/lifestyle-tiers").set("x-test-user", u.id);
      expect(list.status).toBe(403);
      const create = await request(app)
        .post("/api/admin/lifestyle-tiers")
        .set("x-test-user", u.id)
        .send({ name: "X", monthlyCost: 1 });
      expect(create.status).toBe(403);
    }
  });

  it("creates a tier, clamps a negative cost to 0, and rejects a blank name", async () => {
    const admin = await createAdmin();

    const blank = await request(app)
      .post("/api/admin/lifestyle-tiers")
      .set("x-test-user", admin.id)
      .send({ monthlyCost: 100 });
    expect(blank.status).toBe(400);

    const res = await request(app)
      .post("/api/admin/lifestyle-tiers")
      .set("x-test-user", admin.id)
      .send({ name: "Penthouse", monthlyCost: -50 });
    expect(res.status).toBe(201);
    expect(res.body.monthlyCost).toBe(0);
  });

  it("patches a tier and 404s for an unknown id", async () => {
    const admin = await createAdmin();
    const tier = await makeTier("Mid", 1000);

    const res = await request(app)
      .patch(`/api/admin/lifestyle-tiers/${tier.id}`)
      .set("x-test-user", admin.id)
      .send({ monthlyCost: 1500, name: "Mid Plus" });
    expect(res.status).toBe(200);
    expect(res.body.monthlyCost).toBe(1500);
    expect(res.body.name).toBe("Mid Plus");

    const missing = await request(app)
      .patch(`/api/admin/lifestyle-tiers/999999`)
      .set("x-test-user", admin.id)
      .send({ monthlyCost: 1 });
    expect(missing.status).toBe(404);
  });

  it("delete soft-archives the tier rather than removing the row", async () => {
    const admin = await createAdmin();
    const tier = await makeTier("Doomed", 300);

    const res = await request(app)
      .delete(`/api/admin/lifestyle-tiers/${tier.id}`)
      .set("x-test-user", admin.id);
    expect(res.status).toBe(204);

    const [row] = await db.select().from(lifestyleTiers).where(eq(lifestyleTiers.id, tier.id));
    expect(row).toBeTruthy();
    expect(row.archived).toBe(true);
  });
});
