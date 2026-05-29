import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildTestApp } from "./app";
import { createUser, createAdmin } from "./testDb";

const app = buildTestApp();

describe("test harness", () => {
  it("serves the health endpoint", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
  });

  it("treats requests with no x-test-user as unauthenticated (401)", async () => {
    const res = await request(app).get("/api/characters");
    expect(res.status).toBe(401);
  });

  it("authenticates a seeded user via the x-test-user header", async () => {
    const user = await createUser();
    const res = await request(app).get("/api/characters").set("x-test-user", user.id);
    expect(res.status).toBe(200);
  });

  it("enforces role gating: non-admin is forbidden from admin routes (403)", async () => {
    const user = await createUser();
    const res = await request(app).get("/api/admin/users").set("x-test-user", user.id);
    expect(res.status).toBe(403);
  });

  it("allows an admin through admin routes (200)", async () => {
    const admin = await createAdmin();
    const res = await request(app).get("/api/admin/users").set("x-test-user", admin.id);
    expect(res.status).toBe(200);
  });

  it("starts each test from a clean database", async () => {
    const admin = await createAdmin();
    const res = await request(app).get("/api/admin/users").set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    // Only the admin we just created should exist (previous tests truncated).
    const body = res.body as { users?: unknown[] } | unknown[];
    const count = Array.isArray(body) ? body.length : (body.users?.length ?? 0);
    expect(count).toBe(1);
  });
});
