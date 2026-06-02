import { describe, it, expect } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, housing, auditLog } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

// Admins can edit a live lease's kind / notes / monthlyRent. monthlyRent feeds
// the autobill cron, so the edit must be admin-gated and leave an audit trail.
const app = buildTestApp();

function createFixer() {
  return createUser({ roles: ["fixer"] });
}

async function makeLease(opts: { monthlyRent?: number; kind?: string } = {}) {
  const owner = await createUser();
  const char = await createCharacter({ ownerId: owner.id });
  const [lease] = await db
    .insert(housing)
    .values({
      characterId: char.id,
      address: "Megabuilding H10 #42",
      monthlyRent: opts.monthlyRent ?? 900,
      kind: opts.kind ?? "residential",
    })
    .returning();
  return lease;
}

describe("PATCH /housing/:id (admin lease edit)", () => {
  it("forbids non-admin callers (player and fixer) with 403", async () => {
    const player = await createUser();
    const fixer = await createFixer();
    const lease = await makeLease();

    const pr = await request(app)
      .patch(`/api/housing/${lease.id}`)
      .set("x-test-user", player.id)
      .send({ monthlyRent: 1 });
    expect(pr.status).toBe(403);

    const fr = await request(app)
      .patch(`/api/housing/${lease.id}`)
      .set("x-test-user", fixer.id)
      .send({ monthlyRent: 1 });
    expect(fr.status).toBe(403);
  });

  it("404s for an unknown lease", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .patch("/api/housing/999999")
      .set("x-test-user", admin.id)
      .send({ monthlyRent: 1000 });
    expect(res.status).toBe(404);
  });

  it("400s when no changes are supplied", async () => {
    const admin = await createAdmin();
    const lease = await makeLease();
    const res = await request(app)
      .patch(`/api/housing/${lease.id}`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(400);
  });

  it("rejects an invalid kind with 400", async () => {
    const admin = await createAdmin();
    const lease = await makeLease();
    const res = await request(app)
      .patch(`/api/housing/${lease.id}`)
      .set("x-test-user", admin.id)
      .send({ kind: "bogus" });
    expect(res.status).toBe(400);
  });

  it("applies a rent edit and writes a lease_edit audit row with before/after", async () => {
    const admin = await createAdmin();
    const lease = await makeLease({ monthlyRent: 900 });
    const res = await request(app)
      .patch(`/api/housing/${lease.id}`)
      .set("x-test-user", admin.id)
      .send({ monthlyRent: 1500 });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(housing).where(eq(housing.id, lease.id));
    expect(row.monthlyRent).toBe(1500);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "lease_edit"));
    expect(audits.length).toBe(1);
    expect(audits[0].category).toBe("housing");
    expect(audits[0].targetId).toBe(String(lease.id));
    expect((audits[0].beforeJson as Record<string, unknown>).monthlyRent).toBe(900);
    expect((audits[0].afterJson as Record<string, unknown>).monthlyRent).toBe(1500);
  });
});
