import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";

vi.mock("../lib/discord", async (importActual) => {
  const actual = await importActual<typeof import("../lib/discord")>();
  return {
    ...actual,
    sendDirectMessage: vi.fn(async () => "dm-id"),
  };
});

import { db, customRequests, inventoryItems, reviewVotes, auditLog } from "@workspace/db";
import { sendDirectMessage } from "../lib/discord";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockDm = vi.mocked(sendDirectMessage);

beforeEach(() => {
  mockDm.mockReset();
  mockDm.mockResolvedValue("dm-id");
});

function createFixer() {
  return createUser({ roles: ["fixer"] });
}

// A gun request needs no mechanical approval params, so it's the simplest
// subject for exercising the generic voting pipeline.
async function submitGunRequest(ownerId: string) {
  const char = await createCharacter({ ownerId });
  const res = await request(app)
    .post("/api/requests")
    .set("x-test-user", ownerId)
    .send({ type: "gun", characterId: char.id, title: "Overture", description: "A revolver" });
  expect(res.status).toBe(201);
  return { char, reqId: res.body.id as number };
}

describe("custom request voting — majority threshold", () => {
  it("holds at pending after one of two required approvals, then materializes on the second", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer(); // third reviewer makes the majority threshold 2
    const { reqId } = await submitGunRequest(owner.id);

    const first = await request(app)
      .post(`/api/requests/${reqId}/vote`)
      .set("x-test-user", f1.id)
      .send({ vote: "approve" });
    expect(first.status).toBe(200);
    expect(first.body.decided).toBeNull();
    expect(first.body.status).toBe("pending");
    expect(first.body.approveCount).toBe(1);
    expect(first.body.threshold).toBe(2);
    expect(await db.select().from(inventoryItems)).toHaveLength(0);

    const second = await request(app)
      .post(`/api/requests/${reqId}/vote`)
      .set("x-test-user", f2.id)
      .send({ vote: "approve" });
    expect(second.status).toBe(200);
    expect(second.body.decided).toBe("approved");
    expect(second.body.status).toBe("approved");
    expect(await db.select().from(inventoryItems)).toHaveLength(1);
  });

  it("403s a reviewer voting on their own submitted request", async () => {
    const fixerOwner = await createFixer();
    const { reqId } = await submitGunRequest(fixerOwner.id);
    const res = await request(app)
      .post(`/api/requests/${reqId}/vote`)
      .set("x-test-user", fixerOwner.id)
      .send({ vote: "approve" });
    expect(res.status).toBe(403);
  });
});

describe("custom request override", () => {
  it("lets an admin approve immediately and records overriddenBy", async () => {
    const owner = await createUser();
    await createFixer();
    await createFixer(); // votes would otherwise be needed; override bypasses them
    const admin = await createAdmin();
    const { reqId } = await submitGunRequest(owner.id);

    const res = await request(app)
      .post(`/api/requests/${reqId}/override`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(row.overriddenBy).toBe(admin.id);
    expect(await db.select().from(inventoryItems)).toHaveLength(1);
  });

  it("403s a non-admin reviewer attempting an override", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { reqId } = await submitGunRequest(owner.id);
    const res = await request(app)
      .post(`/api/requests/${reqId}/override`)
      .set("x-test-user", fixer.id)
      .send({});
    expect(res.status).toBe(403);
  });
});

describe("custom request request-changes + resubmit", () => {
  it("parks the request in changes_requested, DMs the player, then resubmit returns it to pending", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { reqId } = await submitGunRequest(owner.id);

    const rc = await request(app)
      .post(`/api/requests/${reqId}/request-changes`)
      .set("x-test-user", fixer.id)
      .send({ comment: "Pick a different model." });
    expect(rc.status).toBe(200);
    expect(rc.body.status).toBe("changes_requested");
    expect(rc.body.reviewerNote).toBe("Pick a different model.");
    expect(mockDm).toHaveBeenCalledTimes(1);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "request_changes"));
    expect(audits).toHaveLength(1);

    const resub = await request(app)
      .post(`/api/requests/${reqId}/resubmit`)
      .set("x-test-user", owner.id)
      .send({});
    expect(resub.status).toBe(200);
    expect(resub.body.status).toBe("pending");
  });

  it("400s request-changes without a comment", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { reqId } = await submitGunRequest(owner.id);
    const res = await request(app)
      .post(`/api/requests/${reqId}/request-changes`)
      .set("x-test-user", fixer.id)
      .send({});
    expect(res.status).toBe(400);
  });

  it("clears prior votes on resubmit so the next round starts fresh", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer(); // threshold 2 so one approve does not decide
    const { reqId } = await submitGunRequest(owner.id);

    // One approve vote lands while still pending.
    const vote = await request(app)
      .post(`/api/requests/${reqId}/vote`)
      .set("x-test-user", f1.id)
      .send({ vote: "approve" });
    expect(vote.body.decided).toBeNull();
    expect(
      await db
        .select()
        .from(reviewVotes)
        .where(and(eq(reviewVotes.subjectType, "request"), eq(reviewVotes.subjectId, reqId))),
    ).toHaveLength(1);

    // A second reviewer sends it back for changes, then the owner resubmits.
    const rc = await request(app)
      .post(`/api/requests/${reqId}/request-changes`)
      .set("x-test-user", f2.id)
      .send({ comment: "Reconsider." });
    expect(rc.status).toBe(200);

    const resub = await request(app)
      .post(`/api/requests/${reqId}/resubmit`)
      .set("x-test-user", owner.id)
      .send({});
    expect(resub.status).toBe(200);
    expect(resub.body.status).toBe("pending");

    // Votes wiped — the fresh round starts from zero.
    expect(
      await db
        .select()
        .from(reviewVotes)
        .where(and(eq(reviewVotes.subjectType, "request"), eq(reviewVotes.subjectId, reqId))),
    ).toHaveLength(0);
  });
});
