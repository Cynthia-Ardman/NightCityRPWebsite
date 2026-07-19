import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, auditLog } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

const app = buildTestApp();

async function seedEntry(overrides: Partial<typeof auditLog.$inferInsert> = {}) {
  const [row] = await db
    .insert(auditLog)
    .values({
      category: "wallet",
      action: "adjust",
      actorId: "actor-1",
      actorName: "Admin One",
      targetType: "character",
      targetId: "42",
      message: "Adjusted wallet by 500",
      ...overrides,
    })
    .returning();
  return row;
}

describe("GET /admin/audit-log (explorer filters)", () => {
  it("forbids non-admin callers", async () => {
    const user = await createUser();
    const res = await request(app).get("/api/admin/audit-log").set("x-test-user", user.id);
    expect(res.status).toBe(403);
  });

  it("filters by target character", async () => {
    const admin = await createAdmin();
    const hit = await seedEntry({ targetType: "character", targetId: "9001" });
    const miss = await seedEntry({ targetType: "character", targetId: "9002" });
    const res = await request(app)
      .get("/api/admin/audit-log?targetType=character&targetId=9001")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(hit.id);
    expect(ids).not.toContain(miss.id);
  });

  it("free-text q matches message and JSON change details", async () => {
    const admin = await createAdmin();
    const byMessage = await seedEntry({ message: "Unique zebra payout note" });
    const byJson = await seedEntry({
      message: "boring",
      afterJson: { note: "quagga-token-xyz" } as never,
    });
    const miss = await seedEntry({ message: "irrelevant" });

    const res1 = await request(app)
      .get("/api/admin/audit-log?q=zebra%20payout")
      .set("x-test-user", admin.id);
    expect(res1.body.map((r: { id: number }) => r.id)).toEqual([byMessage.id]);

    const res2 = await request(app)
      .get("/api/admin/audit-log?q=quagga-token")
      .set("x-test-user", admin.id);
    const ids2 = res2.body.map((r: { id: number }) => r.id);
    expect(ids2).toContain(byJson.id);
    expect(ids2).not.toContain(miss.id);
  });

  it("applies a since/until date range", async () => {
    const admin = await createAdmin();
    const old = await seedEntry({ createdAt: new Date("2026-01-01T00:00:00Z") });
    const mid = await seedEntry({ createdAt: new Date("2026-03-01T00:00:00Z") });
    const recent = await seedEntry({ createdAt: new Date("2026-06-01T00:00:00Z") });
    const res = await request(app)
      .get("/api/admin/audit-log?since=2026-02-01T00:00:00Z&until=2026-04-01T00:00:00Z")
      .set("x-test-user", admin.id);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(mid.id);
    expect(ids).not.toContain(old.id);
    expect(ids).not.toContain(recent.id);
  });

  it("paginates with beforeId keyset cursor in id-desc order", async () => {
    const admin = await createAdmin();
    const a = await seedEntry({ message: "page-a" });
    const b = await seedEntry({ message: "page-b" });
    const c = await seedEntry({ message: "page-c" });
    const page1 = await request(app)
      .get("/api/admin/audit-log?q=page-&limit=2")
      .set("x-test-user", admin.id);
    expect(page1.body.map((r: { id: number }) => r.id)).toEqual([c.id, b.id]);
    const page2 = await request(app)
      .get(`/api/admin/audit-log?q=page-&limit=2&beforeId=${b.id}`)
      .set("x-test-user", admin.id);
    expect(page2.body.map((r: { id: number }) => r.id)).toEqual([a.id]);
  });

  it("stacks category, actor, and target filters", async () => {
    const admin = await createAdmin();
    const hit = await seedEntry({ category: "mission", actorName: "Vinny", targetId: "777" });
    await seedEntry({ category: "mission", actorName: "Other", targetId: "777" });
    await seedEntry({ category: "wallet", actorName: "Vinny", targetId: "777" });
    const res = await request(app)
      .get("/api/admin/audit-log?category=mission&actorId=vinny&targetType=character&targetId=777")
      .set("x-test-user", admin.id);
    expect(res.body.map((r: { id: number }) => r.id)).toEqual([hit.id]);
  });
});
