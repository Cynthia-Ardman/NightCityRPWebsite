import { describe, it, expect } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, users } from "@workspace/db";
import { buildTestApp } from "./app";
import { createUser } from "./testDb";

const app = buildTestApp();

describe("account text-scale preference", () => {
  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/auth/text-scale")
      .send({ scale: "lg" });
    expect(res.status).toBe(401);
  });

  it("rejects invalid values", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/auth/text-scale")
      .set("x-test-user", user.id)
      .send({ scale: "huge" });
    expect(res.status).toBe(400);
  });

  it("persists the preference and surfaces it on /auth/me", async () => {
    const user = await createUser();
    const save = await request(app)
      .post("/api/auth/text-scale")
      .set("x-test-user", user.id)
      .send({ scale: "xl" });
    expect(save.status).toBe(200);
    expect(save.body).toMatchObject({ ok: true, textScale: "xl" });

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.textScale).toBe("xl");

    const me = await request(app).get("/api/auth/me").set("x-test-user", user.id);
    expect(me.status).toBe(200);
    expect(me.body.textScale).toBe("xl");
  });

  it('stores "default" literally so it can override a larger choice elsewhere', async () => {
    const user = await createUser();
    await request(app)
      .post("/api/auth/text-scale")
      .set("x-test-user", user.id)
      .send({ scale: "lg" });
    const res = await request(app)
      .post("/api/auth/text-scale")
      .set("x-test-user", user.id)
      .send({ scale: "default" });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.textScale).toBe("default");
  });

  it("returns null on /auth/me when never set", async () => {
    const user = await createUser();
    const me = await request(app).get("/api/auth/me").set("x-test-user", user.id);
    expect(me.status).toBe(200);
    expect(me.body.textScale).toBeNull();
  });
});
