import { describe, it, expect } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, catalogCyberware, catalogRent, auditLog } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

// Locks the staff catalog authoring endpoints (cyberware + property listings):
// every create/edit must be gated to ADMIN/FIXER, validate its payload, and
// leave a `catalog` audit trail. These shipped without coverage.
const app = buildTestApp();

function createFixer(opts: { id?: string; username?: string } = {}) {
  return createUser({ ...opts, roles: ["fixer"] });
}

describe("POST /catalog/cyberware (staff create)", () => {
  it("forbids non-staff callers with 403", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/catalog/cyberware")
      .set("x-test-user", user.id)
      .send({ name: "Kerenzikov", slot: "nervous system" });
    expect(res.status).toBe(403);
  });

  it("rejects a payload missing the required slot with 400", async () => {
    const fixer = await createFixer();
    const res = await request(app)
      .post("/api/catalog/cyberware")
      .set("x-test-user", fixer.id)
      .send({ name: "No Slot" });
    expect(res.status).toBe(400);
  });

  it("creates cyberware with defaults and audit-logs it", async () => {
    const fixer = await createFixer();
    const res = await request(app)
      .post("/api/catalog/cyberware")
      .set("x-test-user", fixer.id)
      .send({ name: "Sandevistan", slot: "operating system", price: 45000 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Sandevistan");
    expect(res.body.slot).toBe("operating system");
    expect(res.body.price).toBe(45000);

    const [row] = await db
      .select()
      .from(catalogCyberware)
      .where(eq(catalogCyberware.id, res.body.id));
    expect(row.name).toBe("Sandevistan");

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "cyberware_create"));
    expect(audits.length).toBe(1);
    expect(audits[0].category).toBe("catalog");
    expect(audits[0].targetId).toBe(String(res.body.id));
    expect((audits[0].afterJson as Record<string, unknown>).name).toBe("Sandevistan");
  });
});

describe("PATCH /catalog/cyberware/:id (staff edit)", () => {
  async function seedCyber() {
    const [c] = await db
      .insert(catalogCyberware)
      .values({ name: "Before Chrome", slot: "arms", price: 1000 })
      .returning();
    return c;
  }

  it("forbids non-staff callers with 403", async () => {
    const user = await createUser();
    const c = await seedCyber();
    const res = await request(app)
      .patch(`/api/catalog/cyberware/${c.id}`)
      .set("x-test-user", user.id)
      .send({ name: "Nope" });
    expect(res.status).toBe(403);
  });

  it("404s for an unknown row", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .patch("/api/catalog/cyberware/999999")
      .set("x-test-user", admin.id)
      .send({ name: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("returns 400 on a no-op edit", async () => {
    const admin = await createAdmin();
    const c = await seedCyber();
    const res = await request(app)
      .patch(`/api/catalog/cyberware/${c.id}`)
      .set("x-test-user", admin.id)
      .send({ name: "Before Chrome", price: 1000 });
    expect(res.status).toBe(400);
  });

  it("applies a multi-field edit and audit-logs before/after", async () => {
    const admin = await createAdmin();
    const c = await seedCyber();
    const res = await request(app)
      .patch(`/api/catalog/cyberware/${c.id}`)
      .set("x-test-user", admin.id)
      .send({ name: "After Chrome", price: 2500 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("After Chrome");
    expect(res.body.price).toBe(2500);
    expect(res.body.changed.sort()).toEqual(["name", "price"]);

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "cyberware_edit"));
    expect(audits.length).toBe(1);
    expect(audits[0].category).toBe("catalog");
    expect(audits[0].beforeJson).toMatchObject({ name: "Before Chrome", price: 1000 });
    expect(audits[0].afterJson).toMatchObject({ name: "After Chrome", price: 2500 });
  });
});

describe("POST /catalog/rent (staff create)", () => {
  it("forbids non-staff callers with 403", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/catalog/rent")
      .set("x-test-user", user.id)
      .send({ name: "Megabuilding H8 #1" });
    expect(res.status).toBe(403);
  });

  it("rejects a blank name with 400", async () => {
    const fixer = await createFixer();
    const res = await request(app)
      .post("/api/catalog/rent")
      .set("x-test-user", fixer.id)
      .send({ name: "   " });
    expect(res.status).toBe(400);
  });

  it("creates a residential listing by default, returns occupied:false, and audit-logs it", async () => {
    const fixer = await createFixer();
    const res = await request(app)
      .post("/api/catalog/rent")
      .set("x-test-user", fixer.id)
      .send({ name: "Megabuilding H8 #1", district: "Watson", monthlyRent: 1200 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Megabuilding H8 #1");
    expect(res.body.kind).toBe("residential");
    expect(res.body.occupied).toBe(false);

    const [row] = await db.select().from(catalogRent).where(eq(catalogRent.id, res.body.id));
    expect(row.district).toBe("Watson");

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "rent_create"));
    expect(audits.length).toBe(1);
    expect(audits[0].category).toBe("catalog");
    expect(audits[0].targetId).toBe(String(res.body.id));
  });

  it("honors an explicit business kind", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post("/api/catalog/rent")
      .set("x-test-user", admin.id)
      .send({ name: "Afterlife Bar", kind: "business" });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("business");
  });
});

describe("PATCH /catalog/rent/:id (staff edit)", () => {
  async function seedListing() {
    const [l] = await db
      .insert(catalogRent)
      .values({ name: "Before Tower", district: "Heywood", monthlyRent: 900, kind: "residential" })
      .returning();
    return l;
  }

  it("forbids non-staff callers with 403", async () => {
    const user = await createUser();
    const l = await seedListing();
    const res = await request(app)
      .patch(`/api/catalog/rent/${l.id}`)
      .set("x-test-user", user.id)
      .send({ name: "Nope" });
    expect(res.status).toBe(403);
  });

  it("404s for an unknown listing", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .patch("/api/catalog/rent/999999")
      .set("x-test-user", admin.id)
      .send({ name: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("returns 400 on a no-op edit", async () => {
    const admin = await createAdmin();
    const l = await seedListing();
    const res = await request(app)
      .patch(`/api/catalog/rent/${l.id}`)
      .set("x-test-user", admin.id)
      .send({ name: "Before Tower", monthlyRent: 900 });
    expect(res.status).toBe(400);
  });

  it("applies an edit, returns the occupied flag, and audit-logs before/after", async () => {
    const admin = await createAdmin();
    const l = await seedListing();
    const res = await request(app)
      .patch(`/api/catalog/rent/${l.id}`)
      .set("x-test-user", admin.id)
      .send({ name: "After Tower", monthlyRent: 1500 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("After Tower");
    expect(res.body.monthlyRent).toBe(1500);
    // Vacant listing → occupied:false, matching the GET /catalog/rent shape.
    expect(res.body.occupied).toBe(false);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "rent_edit"));
    expect(audits.length).toBe(1);
    expect(audits[0].beforeJson).toMatchObject({ name: "Before Tower", monthlyRent: 900 });
    expect(audits[0].afterJson).toMatchObject({ name: "After Tower", monthlyRent: 1500 });
  });
});
