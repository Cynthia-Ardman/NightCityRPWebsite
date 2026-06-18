import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

vi.mock("../lib/discord", async (importActual) => {
  const actual = await importActual<typeof import("../lib/discord")>();
  return {
    ...actual,
    postToChannel: vi.fn(async () => "msg-id"),
    sendDirectMessage: vi.fn(async () => "dm-id"),
  };
});

import { db, customRequests } from "@workspace/db";
import { postToChannel } from "../lib/discord";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockPost = vi.mocked(postToChannel);

// Reviewers carry the cs-approver role (the eligible voter pool) plus fixer for
// staff-view access — mirrors requests.pipeline.test.ts.
function createFixer() {
  return createUser({ roles: ["fixer", "cs approver"] });
}

beforeEach(() => {
  mockPost.mockReset();
  mockPost.mockResolvedValue("msg-id");
});

describe("custom request drafts", () => {
  it("creates a draft that is not announced and is hidden from the staff queue", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const char = await createCharacter({ ownerId: owner.id });

    const created = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "gun", characterId: char.id, title: "Overture", description: "A revolver", asDraft: true });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("draft");
    // Drafts stay private — never announced to the cs-approver channel.
    expect(mockPost).not.toHaveBeenCalled();

    // Owner sees the draft in /requests/mine ...
    const mine = await request(app).get("/api/requests/mine").set("x-test-user", owner.id);
    expect(mine.status).toBe(200);
    expect((mine.body as Array<{ id: number }>).some((r) => r.id === created.body.id)).toBe(true);

    // ... but it never appears in the staff queue (defaults to pending).
    const queue = await request(app).get("/api/requests").set("x-test-user", fixer.id);
    expect(queue.status).toBe(200);
    expect((queue.body as Array<{ id: number }>).some((r) => r.id === created.body.id)).toBe(false);
  });

  it("submits a draft to pending and announces it", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const created = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "gun", characterId: char.id, title: "Overture", asDraft: true });
    expect(created.status).toBe(201);
    const id = created.body.id as number;

    const submitted = await request(app).post(`/api/requests/${id}/submit`).set("x-test-user", owner.id).send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe("pending");
    expect(mockPost).toHaveBeenCalledTimes(1);

    // Re-submitting a now-pending row is a 409 (no longer a draft).
    const again = await request(app).post(`/api/requests/${id}/submit`).set("x-test-user", owner.id).send({});
    expect(again.status).toBe(409);
  });

  it("rejects submitting an incomplete venue draft until required fields are present", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    // off_map store draft with no purpose/location yet.
    const created = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "store", characterId: char.id, title: "Afterlife", asDraft: true });
    expect(created.status).toBe(201);
    const id = created.body.id as number;

    const tooEarly = await request(app).post(`/api/requests/${id}/submit`).set("x-test-user", owner.id).send({});
    expect(tooEarly.status).toBe(400);

    // Fill in the required venue fields via PATCH, then submit succeeds.
    const patched = await request(app)
      .patch(`/api/requests/${id}`)
      .set("x-test-user", owner.id)
      .send({ description: "A club", purpose: "Nightclub", location: "Watson" });
    expect(patched.status).toBe(200);

    const ok = await request(app).post(`/api/requests/${id}/submit`).set("x-test-user", owner.id).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("pending");
  });

  it("lets the owner delete their own draft but not a submitted request", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const created = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "gun", characterId: char.id, title: "Overture", asDraft: true });
    const id = created.body.id as number;

    // A different player can't delete it.
    const forbidden = await request(app).delete(`/api/requests/${id}`).set("x-test-user", stranger.id);
    expect(forbidden.status).toBe(403);

    // Owner deletes the draft.
    const del = await request(app).delete(`/api/requests/${id}`).set("x-test-user", owner.id);
    expect(del.status).toBe(204);
    expect(await db.select().from(customRequests).where(eq(customRequests.id, id))).toHaveLength(0);
  });

  it("refuses to delete a submitted (non-draft) request", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    const created = await request(app)
      .post("/api/requests")
      .set("x-test-user", owner.id)
      .send({ type: "gun", characterId: char.id, title: "Overture", description: "A revolver" });
    expect(created.body.status).toBe("pending");
    const del = await request(app).delete(`/api/requests/${created.body.id}`).set("x-test-user", owner.id);
    expect(del.status).toBe(409);
  });
});
