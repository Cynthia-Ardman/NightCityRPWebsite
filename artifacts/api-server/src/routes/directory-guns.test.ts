import { describe, it, expect } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, catalogGuns, auditLog } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

const app = buildTestApp();

function createFixer(opts: { id?: string; username?: string } = {}) {
  return createUser({ ...opts, roles: ["fixer"] });
}

async function seedGun(overrides: Partial<typeof catalogGuns.$inferInsert> = {}) {
  const [g] = await db
    .insert(catalogGuns)
    .values({ name: "Test Gun", price: 1000, status: "live", ...overrides })
    .returning();
  return g;
}

describe("GET /catalog/guns (visibility + wholesale scrub)", () => {
  it("hides drafts and scrubs wholesalePrice for non-staff", async () => {
    const user = await createUser();
    const live = await seedGun({ name: "Live Iron", status: "live", wholesalePrice: 500 });
    const draft = await seedGun({ name: "Secret Proto", status: "draft", wholesalePrice: 99 });

    const res = await request(app).get("/api/catalog/guns").set("x-test-user", user.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((g: { id: number }) => g.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(draft.id);
    const liveRow = res.body.find((g: { id: number }) => g.id === live.id);
    expect(liveRow.wholesalePrice).toBeUndefined();
  });

  it("returns drafts and wholesalePrice to staff", async () => {
    const admin = await createAdmin();
    const draft = await seedGun({ name: "Proto", status: "draft", wholesalePrice: 77 });
    const res = await request(app).get("/api/catalog/guns").set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const row = res.body.find((g: { id: number }) => g.id === draft.id);
    expect(row).toBeTruthy();
    expect(row.wholesalePrice).toBe(77);
  });
});

describe("POST /catalog/guns (staff create)", () => {
  it("forbids non-staff callers with 403", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/catalog/guns")
      .set("x-test-user", user.id)
      .send({ name: "Hacker Gun" });
    expect(res.status).toBe(403);
  });

  it("rejects a blank name with 400", async () => {
    const fixer = await createFixer();
    const res = await request(app)
      .post("/api/catalog/guns")
      .set("x-test-user", fixer.id)
      .send({ name: "   " });
    expect(res.status).toBe(400);
  });

  it("creates a draft weapon by default and audit-logs it", async () => {
    const fixer = await createFixer();
    const res = await request(app)
      .post("/api/catalog/guns")
      .set("x-test-user", fixer.id)
      .send({ name: "Malorian 3516", manufacturer: "Malorian", price: 50000, weaponType: "pistol" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Malorian 3516");
    expect(res.body.status).toBe("draft");
    expect(res.body.price).toBe(50000);

    const [row] = await db.select().from(catalogGuns).where(eq(catalogGuns.id, res.body.id));
    expect(row.manufacturer).toBe("Malorian");

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "gun_create"));
    expect(audits.length).toBe(1);
    expect(audits[0].category).toBe("catalog");
    expect(audits[0].targetId).toBe(String(res.body.id));
    expect((audits[0].afterJson as Record<string, unknown>).name).toBe("Malorian 3516");
  });

  it("honors an explicit live status on create", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post("/api/catalog/guns")
      .set("x-test-user", admin.id)
      .send({ name: "Public Piece", status: "live" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("live");
  });
});

describe("PATCH /catalog/guns/:id (staff full-field edit)", () => {
  it("forbids non-staff callers with 403", async () => {
    const user = await createUser();
    const gun = await seedGun();
    const res = await request(app)
      .patch(`/api/catalog/guns/${gun.id}`)
      .set("x-test-user", user.id)
      .send({ name: "Nope" });
    expect(res.status).toBe(403);
  });

  it("404s for an unknown gun", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .patch("/api/catalog/guns/999999")
      .set("x-test-user", admin.id)
      .send({ name: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when nothing actually changes", async () => {
    const admin = await createAdmin();
    const gun = await seedGun({ name: "SameName", price: 1000 });
    const res = await request(app)
      .patch(`/api/catalog/guns/${gun.id}`)
      .set("x-test-user", admin.id)
      .send({ name: "SameName", price: 1000 });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown status with 400", async () => {
    const admin = await createAdmin();
    const gun = await seedGun();
    const res = await request(app)
      .patch(`/api/catalog/guns/${gun.id}`)
      .set("x-test-user", admin.id)
      .send({ status: "bogus" });
    expect(res.status).toBe(400);
  });

  it("applies a multi-field edit and audit-logs before/after", async () => {
    const admin = await createAdmin();
    const gun = await seedGun({
      name: "Before Iron",
      manufacturer: "Militech",
      price: 1000,
      status: "draft",
    });

    const res = await request(app)
      .patch(`/api/catalog/guns/${gun.id}`)
      .set("x-test-user", admin.id)
      .send({ name: "After Iron", price: 2500, status: "live" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("After Iron");
    expect(res.body.price).toBe(2500);
    expect(res.body.status).toBe("live");
    expect(res.body.changed.sort()).toEqual(["name", "price", "status"]);

    const [row] = await db.select().from(catalogGuns).where(eq(catalogGuns.id, gun.id));
    expect(row.name).toBe("After Iron");
    expect(row.price).toBe(2500);
    expect(row.status).toBe("live");

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "gun_edit"));
    expect(audits.length).toBe(1);
    expect(audits[0].category).toBe("catalog");
    expect(audits[0].targetId).toBe(String(gun.id));
    expect(audits[0].beforeJson).toMatchObject({ name: "Before Iron", price: 1000, status: "draft" });
    expect(audits[0].afterJson).toMatchObject({ name: "After Iron", price: 2500, status: "live" });
  });

  it("logs a status-only flip under the gun_status action", async () => {
    const admin = await createAdmin();
    const gun = await seedGun({ name: "Promote Me", status: "draft" });
    const res = await request(app)
      .patch(`/api/catalog/guns/${gun.id}`)
      .set("x-test-user", admin.id)
      .send({ status: "live" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("live");

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "gun_status"));
    expect(audits.length).toBe(1);
    expect((audits[0].afterJson as Record<string, unknown>).status).toBe("live");
  });

  it("clears a nullable field when an empty string is sent", async () => {
    const admin = await createAdmin();
    const gun = await seedGun({ name: "Has Notes", notes: "some notes" });
    const res = await request(app)
      .patch(`/api/catalog/guns/${gun.id}`)
      .set("x-test-user", admin.id)
      .send({ notes: "" });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(catalogGuns).where(eq(catalogGuns.id, gun.id));
    expect(row.notes).toBeNull();
  });
});
