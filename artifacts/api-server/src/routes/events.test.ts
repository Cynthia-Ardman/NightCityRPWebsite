import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

const app = buildTestApp();

const future = (hoursFromNow: number) =>
  new Date(Date.now() + hoursFromNow * 3600_000).toISOString();

async function createValidEvent(actorId: string, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/events")
    .set("x-test-user", actorId)
    .send({ title: "Heist Night", startAt: future(24), endAt: future(26), ...overrides });
}

describe("GET /events", () => {
  it("401s when unauthenticated", async () => {
    const res = await request(app).get("/api/events");
    expect(res.status).toBe(401);
  });

  it("returns a list for any signed-in user", async () => {
    const player = await createUser();
    const res = await request(app).get("/api/events").set("x-test-user", player.id);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("POST /events", () => {
  it("forbids a non-manager", async () => {
    const player = await createUser();
    const res = await createValidEvent(player.id);
    expect(res.status).toBe(403);
  });

  it("validates title and the start/end window", async () => {
    const admin = await createAdmin();

    const noTitle = await request(app)
      .post("/api/events")
      .set("x-test-user", admin.id)
      .send({ startAt: future(24), endAt: future(26) });
    expect(noTitle.status).toBe(400);

    const badDates = await request(app)
      .post("/api/events")
      .set("x-test-user", admin.id)
      .send({ title: "X", startAt: "not-a-date", endAt: future(26) });
    expect(badDates.status).toBe(400);

    const endBeforeStart = await createValidEvent(admin.id, { startAt: future(26), endAt: future(24) });
    expect(endBeforeStart.status).toBe(400);
  });

  it("creates an event for a manager", async () => {
    const admin = await createAdmin();
    const res = await createValidEvent(admin.id);
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Heist Night");
    expect(res.body.id).toBeTruthy();
  });
});

describe("PATCH/DELETE /events/:id", () => {
  it("forbids a non-manager from editing or cancelling", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    const created = await createValidEvent(admin.id);
    const id = created.body.id;

    const patch = await request(app)
      .patch(`/api/events/${id}`)
      .set("x-test-user", player.id)
      .send({ title: "Hacked" });
    expect(patch.status).toBe(403);

    const del = await request(app).delete(`/api/events/${id}`).set("x-test-user", player.id);
    expect(del.status).toBe(403);
  });

  it("lets a manager rename and then cancel an event", async () => {
    const admin = await createAdmin();
    const created = await createValidEvent(admin.id);
    const id = created.body.id;

    const patch = await request(app)
      .patch(`/api/events/${id}`)
      .set("x-test-user", admin.id)
      .send({ title: "Renamed Night" });
    expect(patch.status).toBe(200);
    expect(patch.body.title).toBe("Renamed Night");

    const del = await request(app).delete(`/api/events/${id}`).set("x-test-user", admin.id);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
  });

  it("404s a manager editing an unknown event", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .patch(`/api/events/999999`)
      .set("x-test-user", admin.id)
      .send({ title: "Ghost" });
    expect(res.status).toBe(404);
  });
});

describe("GET /events/conflicts", () => {
  it("forbids a non-manager and validates the window", async () => {
    const player = await createUser();
    const admin = await createAdmin();

    const denied = await request(app)
      .get(`/api/events/conflicts?startAt=${future(24)}&endAt=${future(26)}`)
      .set("x-test-user", player.id);
    expect(denied.status).toBe(403);

    const badParams = await request(app)
      .get(`/api/events/conflicts`)
      .set("x-test-user", admin.id);
    expect(badParams.status).toBe(400);

    const ok = await request(app)
      .get(`/api/events/conflicts?startAt=${encodeURIComponent(future(24))}&endAt=${encodeURIComponent(future(26))}`)
      .set("x-test-user", admin.id);
    expect(ok.status).toBe(200);
  });
});
