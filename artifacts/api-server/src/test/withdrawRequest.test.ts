import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, customRequests } from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildTestApp } from "./app";
import { createUser, createAdmin, createCharacter } from "./testDb";

const app = buildTestApp();

async function makeRequestRow(opts: {
  requestedById: string;
  characterId: number;
  status?: string;
  type?: string;
  appliedRef?: string | null;
}) {
  const [row] = await db
    .insert(customRequests)
    .values({
      requestedById: opts.requestedById,
      characterId: opts.characterId,
      type: opts.type ?? "gun",
      title: "Test Gun",
      description: "A test gun",
      status: opts.status ?? "pending",
      appliedRef: opts.appliedRef ?? null,
    })
    .returning();
  return row;
}

describe("POST /requests/:id/withdraw", () => {
  it("owner withdraws their own pending request → cancelled", async () => {
    const player = await createUser();
    const c = await createCharacter({ ownerId: player.id, approved: true });
    const row = await makeRequestRow({ requestedById: player.id, characterId: c.id });

    const res = await request(app)
      .post(`/api/requests/${row.id}/withdraw`)
      .set("x-test-user", player.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");

    const [db1] = await db.select().from(customRequests).where(eq(customRequests.id, row.id));
    expect(db1.status).toBe("cancelled");
    expect(db1.reviewedAt).toBeNull();
  });

  it("changes_requested is also withdrawable", async () => {
    const player = await createUser();
    const c = await createCharacter({ ownerId: player.id, approved: true });
    const row = await makeRequestRow({ requestedById: player.id, characterId: c.id, status: "changes_requested" });

    const res = await request(app)
      .post(`/api/requests/${row.id}/withdraw`)
      .set("x-test-user", player.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("another player cannot withdraw someone else's request", async () => {
    const player = await createUser();
    const other = await createUser();
    const c = await createCharacter({ ownerId: player.id, approved: true });
    const row = await makeRequestRow({ requestedById: player.id, characterId: c.id });

    const res = await request(app)
      .post(`/api/requests/${row.id}/withdraw`)
      .set("x-test-user", other.id);
    expect(res.status).toBe(403);

    const [db1] = await db.select().from(customRequests).where(eq(customRequests.id, row.id));
    expect(db1.status).toBe("pending");
  });

  it("decided (approved) requests cannot be withdrawn", async () => {
    const player = await createUser();
    const c = await createCharacter({ ownerId: player.id, approved: true });
    const row = await makeRequestRow({ requestedById: player.id, characterId: c.id, status: "approved" });

    const res = await request(app)
      .post(`/api/requests/${row.id}/withdraw`)
      .set("x-test-user", player.id);
    expect(res.status).toBe(409);
  });

  it("closed requests cannot be withdrawn", async () => {
    const player = await createUser();
    const c = await createCharacter({ ownerId: player.id, approved: true });
    const row = await makeRequestRow({ requestedById: player.id, characterId: c.id, status: "closed" });

    const res = await request(app)
      .post(`/api/requests/${row.id}/withdraw`)
      .set("x-test-user", player.id);
    expect(res.status).toBe(409);
  });

  it("drafts cannot be withdrawn (delete them instead)", async () => {
    const player = await createUser();
    const c = await createCharacter({ ownerId: player.id, approved: true });
    const row = await makeRequestRow({ requestedById: player.id, characterId: c.id, status: "draft" });

    const res = await request(app)
      .post(`/api/requests/${row.id}/withdraw`)
      .set("x-test-user", player.id);
    expect(res.status).toBe(409);
  });

  it("player-decided types (employee_invite) cannot be withdrawn here", async () => {
    const player = await createUser();
    const c = await createCharacter({ ownerId: player.id, approved: true });
    const row = await makeRequestRow({ requestedById: player.id, characterId: c.id, type: "employee_invite" });

    const res = await request(app)
      .post(`/api/requests/${row.id}/withdraw`)
      .set("x-test-user", player.id);
    expect(res.status).toBe(400);
  });

  it("withdrawn rows drop out of the reviewer unseen counts", async () => {
    const player = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    const c = await createCharacter({ ownerId: player.id, approved: true });
    const row = await makeRequestRow({ requestedById: player.id, characterId: c.id });

    const before = await request(app).get("/api/review/unseen-counts").set("x-test-user", fixer.id);
    expect(before.status).toBe(200);
    expect(before.body.requests).toBe(1);

    await request(app).post(`/api/requests/${row.id}/withdraw`).set("x-test-user", player.id);

    const after = await request(app).get("/api/review/unseen-counts").set("x-test-user", fixer.id);
    expect(after.status).toBe(200);
    expect(after.body.requests).toBe(0);
  });

  it("even an admin cannot withdraw on the requester's behalf (owner-only)", async () => {
    const player = await createUser();
    const admin = await createAdmin();
    const c = await createCharacter({ ownerId: player.id, approved: true });
    const row = await makeRequestRow({ requestedById: player.id, characterId: c.id });

    const res = await request(app)
      .post(`/api/requests/${row.id}/withdraw`)
      .set("x-test-user", admin.id);
    expect(res.status).toBe(403);

    const [db1] = await db.select().from(customRequests).where(eq(customRequests.id, row.id));
    expect(db1.status).toBe("pending");
  });
});
