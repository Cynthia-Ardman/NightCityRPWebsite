import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, botConfig } from "@workspace/db";
import { buildTestApp } from "./app";
import { createUser, createAdmin } from "./testDb";
import { LOGIN_RESTRICTED_KEY } from "../lib/siteAccess";

const app = buildTestApp();

async function setRestricted(value: boolean): Promise<void> {
  await db
    .insert(botConfig)
    .values({ key: LOGIN_RESTRICTED_KEY, value: value as never })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: value as never } });
}

describe("staff-only login lockdown", () => {
  it("defaults to OFF: /auth/me reports loginRestricted false and players can use gated routes", async () => {
    const user = await createUser();
    const me = await request(app).get("/api/auth/me").set("x-test-user", user.id);
    expect(me.status).toBe(200);
    expect(me.body.loginRestricted).toBe(false);

    const chars = await request(app).get("/api/characters").set("x-test-user", user.id);
    expect(chars.status).toBe(200);
  });

  it("blocks a non-staff member from gated routes with 403 site_locked when restricted", async () => {
    await setRestricted(true);
    const user = await createUser();
    const res = await request(app).get("/api/characters").set("x-test-user", user.id);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("site_locked");
  });

  it("still lets staff (fixer) through gated routes while restricted", async () => {
    await setRestricted(true);
    const fixer = await createUser({ roles: ["fixer"] });
    const res = await request(app).get("/api/characters").set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
  });

  it("reports loginRestricted true on /auth/me when restricted", async () => {
    await setRestricted(true);
    const fixer = await createUser({ roles: ["fixer"] });
    const me = await request(app).get("/api/auth/me").set("x-test-user", fixer.id);
    expect(me.status).toBe(200);
    expect(me.body.loginRestricted).toBe(true);
  });

  it("leaves unauthenticated requests as 401 (not 403) while restricted", async () => {
    await setRestricted(true);
    const res = await request(app).get("/api/characters");
    expect(res.status).toBe(401);
  });

  it("admin GET /admin/site-access reflects the stored flag", async () => {
    const admin = await createAdmin();
    const before = await request(app).get("/api/admin/site-access").set("x-test-user", admin.id);
    expect(before.status).toBe(200);
    expect(before.body.loginRestricted).toBe(false);

    await setRestricted(true);
    const after = await request(app).get("/api/admin/site-access").set("x-test-user", admin.id);
    expect(after.status).toBe(200);
    expect(after.body.loginRestricted).toBe(true);
  });

  it("admin PUT /admin/site-access toggles the flag and is enforced", async () => {
    const admin = await createAdmin();
    const put = await request(app)
      .put("/api/admin/site-access")
      .set("x-test-user", admin.id)
      .send({ loginRestricted: true });
    expect(put.status).toBe(200);
    expect(put.body.loginRestricted).toBe(true);

    // A fresh non-staff member is now locked out.
    const player = await request(app).get("/api/characters").set("x-test-user", admin.id);
    // Admin is staff, so still allowed.
    expect(player.status).toBe(200);

    const user = await createUser();
    const blocked = await request(app).get("/api/characters").set("x-test-user", user.id);
    expect(blocked.status).toBe(403);
  });

  it("rejects a non-boolean body on PUT /admin/site-access with 400", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .put("/api/admin/site-access")
      .set("x-test-user", admin.id)
      .send({ loginRestricted: "yes" });
    expect(res.status).toBe(400);
  });

  it("forbids non-admins from the admin site-access endpoints (403)", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const get = await request(app).get("/api/admin/site-access").set("x-test-user", fixer.id);
    expect(get.status).toBe(403);
    const put = await request(app)
      .put("/api/admin/site-access")
      .set("x-test-user", fixer.id)
      .send({ loginRestricted: true });
    expect(put.status).toBe(403);
  });
});
