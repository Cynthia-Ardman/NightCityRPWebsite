import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, customRequests, missions } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

// Reviewer comments best-effort DM the submitter; stub it out.
vi.mock("../lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/discord")>();
  return { ...actual, sendDirectMessage: vi.fn().mockResolvedValue(undefined) };
});

const app = buildTestApp();

// Build a pending custom request owned by `ownerId`. custom_requests.characterId
// is NOT NULL, so a backing character is created first.
async function makeRequest(ownerId: string) {
  const char = await createCharacter({ ownerId, name: "Req Char" });
  const [r] = await db
    .insert(customRequests)
    .values({
      type: "gun",
      characterId: char.id,
      requestedById: ownerId,
      title: "A shiny pistol",
      status: "pending",
    })
    .returning();
  return r;
}

describe("review comment thread", () => {
  it("400s a malformed subject type", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const res = await request(app).get("/api/review/bogus/1/comments").set("x-test-user", fixer.id);
    expect(res.status).toBe(400);
  });

  it("404s an unknown subject", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const res = await request(app)
      .get("/api/review/request/999999/comments")
      .set("x-test-user", fixer.id);
    expect(res.status).toBe(404);
  });

  it("forbids an unrelated non-reviewer from reading the thread", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const req = await makeRequest(owner.id);
    const res = await request(app)
      .get(`/api/review/request/${req.id}/comments`)
      .set("x-test-user", stranger.id);
    expect(res.status).toBe(403);
  });

  it("lets the submitter and a reviewer post and read, flagging reviewer authorship", async () => {
    const owner = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    const req = await makeRequest(owner.id);

    const ownerPost = await request(app)
      .post(`/api/review/request/${req.id}/comments`)
      .set("x-test-user", owner.id)
      .send({ body: "Any update?" });
    expect(ownerPost.status).toBe(201);
    expect(ownerPost.body.isReviewer).toBe(false);

    const fixerPost = await request(app)
      .post(`/api/review/request/${req.id}/comments`)
      .set("x-test-user", fixer.id)
      .send({ body: "Looking now." });
    expect(fixerPost.status).toBe(201);
    expect(fixerPost.body.isReviewer).toBe(true);

    const thread = await request(app)
      .get(`/api/review/request/${req.id}/comments`)
      .set("x-test-user", owner.id);
    expect(thread.status).toBe(200);
    expect(thread.body).toHaveLength(2);
    expect(thread.body[0].body).toBe("Any update?");
  });

  it("rejects an empty comment body", async () => {
    const owner = await createUser();
    const req = await makeRequest(owner.id);
    const res = await request(app)
      .post(`/api/review/request/${req.id}/comments`)
      .set("x-test-user", owner.id)
      .send({ body: "   " });
    expect(res.status).toBe(400);
  });
});

describe("GET /review/unseen-counts", () => {
  it("returns all-zero for a plain player (no reviewer roles)", async () => {
    const player = await createUser();
    await makeRequest(await createUser().then((u) => u.id));
    const res = await request(app).get("/api/review/unseen-counts").set("x-test-user", player.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ edits: 0, requests: 0, sheets: 0, lore: 0, total: 0 });
  });

  it("counts a pending request for a fixer, excluding the fixer's own", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const someoneElse = await createUser();
    await makeRequest(someoneElse.id);
    await makeRequest(fixer.id); // own request must not count

    const res = await request(app).get("/api/review/unseen-counts").set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    expect(res.body.requests).toBe(1);
  });

  it("drops an item from the count once the reviewer marks it seen", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const req = await makeRequest(owner.id);

    const before = await request(app).get("/api/review/unseen-counts").set("x-test-user", fixer.id);
    expect(before.body.requests).toBe(1);

    const seen = await request(app)
      .post(`/api/review/request/${req.id}/seen`)
      .set("x-test-user", fixer.id);
    expect(seen.status).toBe(200);

    const after = await request(app).get("/api/review/unseen-counts").set("x-test-user", fixer.id);
    expect(after.body.requests).toBe(0);
  });
});

describe("GET /review/my-unseen", () => {
  it("is not role-gated and returns empty totals for a user with no submissions", async () => {
    const player = await createUser();
    const res = await request(app).get("/api/review/my-unseen").set("x-test-user", player.id);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});

describe("review close/reopen authz", () => {
  it("forbids a non-reviewer from closing a ticket", async () => {
    const owner = await createUser();
    const req = await makeRequest(owner.id);
    const res = await request(app)
      .post(`/api/review/request/${req.id}/close`)
      .set("x-test-user", owner.id)
      .send({});
    expect(res.status).toBe(403);
  });
});

describe("GET /review/:type/:id/discord-thread", () => {
  it("forbids a non-reviewer (the submitter included) — the cs-approver channel is internal", async () => {
    const owner = await createUser();
    const req = await makeRequest(owner.id);
    const res = await request(app)
      .get(`/api/review/request/${req.id}/discord-thread`)
      .set("x-test-user", owner.id);
    expect(res.status).toBe(403);
  });

  it("reports linked:false with no messages when the ticket has no thread", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const req = await makeRequest(owner.id);
    const res = await request(app)
      .get(`/api/review/request/${req.id}/discord-thread`)
      .set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(false);
    expect(res.body.threadId).toBeNull();
    expect(res.body.messages).toEqual([]);
  });

  it("reports linked:true and a web url once a thread id is stored", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const req = await makeRequest(owner.id);
    await db
      .update(customRequests)
      .set({ discordThreadId: "123456789012345678" })
      .where(eq(customRequests.id, req.id));
    const res = await request(app)
      .get(`/api/review/request/${req.id}/discord-thread`)
      .set("x-test-user", fixer.id);
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    expect(res.body.threadId).toBe("123456789012345678");
    // No bot token in tests -> listThreadMessages returns []; the linkage state
    // is what matters here.
    expect(res.body.messages).toEqual([]);
  });

  it("404s an unknown subject and 400s a bad type", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const notFound = await request(app)
      .get(`/api/review/request/999999/discord-thread`)
      .set("x-test-user", fixer.id);
    expect(notFound.status).toBe(404);
    const badType = await request(app)
      .get(`/api/review/bogus/1/discord-thread`)
      .set("x-test-user", fixer.id);
    expect(badType.status).toBe(400);
  });

  it("serves a mission's thread (linked:false until a thread id is stored, then linked:true)", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const [m] = await db
      .insert(missions)
      .values({ title: "Smoke a corpo", fixerId: fixer.id })
      .returning();

    const unlinked = await request(app)
      .get(`/api/review/mission/${m.id}/discord-thread`)
      .set("x-test-user", fixer.id);
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.linked).toBe(false);
    expect(unlinked.body.threadId).toBeNull();
    expect(unlinked.body.messages).toEqual([]);

    await db.update(missions).set({ discordThreadId: "987654321098765432" }).where(eq(missions.id, m.id));
    const linked = await request(app)
      .get(`/api/review/mission/${m.id}/discord-thread`)
      .set("x-test-user", fixer.id);
    expect(linked.status).toBe(200);
    expect(linked.body.linked).toBe(true);
    expect(linked.body.threadId).toBe("987654321098765432");
  });

  it("forbids a non-reviewer on a mission thread, and 404s an unknown mission", async () => {
    const player = await createUser();
    const fixer = await createUser({ roles: ["fixer"] });
    const [m] = await db
      .insert(missions)
      .values({ title: "Heist", fixerId: fixer.id })
      .returning();
    const forbidden = await request(app)
      .get(`/api/review/mission/${m.id}/discord-thread`)
      .set("x-test-user", player.id);
    expect(forbidden.status).toBe(403);
    const notFound = await request(app)
      .get(`/api/review/mission/999999/discord-thread`)
      .set("x-test-user", fixer.id);
    expect(notFound.status).toBe(404);
  });
});
