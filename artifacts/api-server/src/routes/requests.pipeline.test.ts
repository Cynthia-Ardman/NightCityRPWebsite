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

import { db, customRequests, inventoryItems, reviewVotes, auditLog, housing, users } from "@workspace/db";
import { sendDirectMessage } from "../lib/discord";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockDm = vi.mocked(sendDirectMessage);

beforeEach(() => {
  mockDm.mockReset();
  mockDm.mockResolvedValue("dm-id");
});

// Test reviewers hold BOTH the fixer role (staff view access) and the
// cs-approver role (the approver pool that casts counted votes). Only
// CS_APPROVERs are eligible voters, so reviewers used to cast votes must carry
// it; the fixer role is kept so staff-view paths still resolve.
function createFixer() {
  return createUser({ roles: ["fixer", "cs approver"] });
}
function createCsApprover() {
  return createUser({ roles: ["cs approver"] });
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
  it("holds at pending after one approval, approves (no effect) on the second, materializes only on close", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const f3 = await createFixer(); // third reviewer makes the majority threshold 2
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
    // Staged lifecycle: approval no longer applies effects.
    expect(await db.select().from(inventoryItems)).toHaveLength(0);

    // Close commits the deferred effect and archives the ticket. The gun's
    // mechanical classification is fixer-decided and supplied here.
    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", f3.id)
      .send({ category: "Power", weaponType: "Pistol", fireMode: "Semi-Auto", powerLevel: "M" });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    expect(await db.select().from(inventoryItems)).toHaveLength(1);

    // Closing again is idempotent — no second materialization.
    const closeAgain = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", f3.id)
      .send({});
    expect(closeAgain.status).toBe(200);
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
    // Override approves but defers the effect to close, same as a vote majority.
    expect(await db.select().from(inventoryItems)).toHaveLength(0);

    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", admin.id)
      .send({ category: "Power", weaponType: "Pistol", fireMode: "Semi-Auto", powerLevel: "M" });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
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

describe("close/reopen authorization", () => {
  it("403s a non-reviewer closing a request and never materializes the effect", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const outsider = await createUser();
    const { reqId } = await submitGunRequest(owner.id);

    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    const decide = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });
    expect(decide.body.status).toBe("approved");

    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", outsider.id)
      .send({});
    expect(close.status).toBe(403);
    // The deferred effect must NOT have been committed by the unauthorized close.
    expect(await db.select().from(inventoryItems)).toHaveLength(0);
  });

  it("403s a non-reviewer reopening a request", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const outsider = await createUser();
    const { reqId } = await submitGunRequest(owner.id);

    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });

    const reopen = await request(app)
      .post(`/api/review/request/${reqId}/reopen`)
      .set("x-test-user", outsider.id)
      .send({});
    expect(reopen.status).toBe(403);
  });

  it("reopens a CLOSED request to a vote-less pending state, preserves appliedRef, and re-closing never double-applies", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const { reqId } = await submitGunRequest(owner.id);

    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });

    // Close commits the deferred effect (one inventory item) and archives it.
    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", f1.id)
      .send({ category: "Power", weaponType: "Pistol", fireMode: "Semi-Auto", powerLevel: "M" });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    expect(await db.select().from(inventoryItems)).toHaveLength(1);

    const [closedRow] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(closedRow.appliedRef).toBeTruthy();

    // Reopen the archived (closed) ticket back to pending.
    const reopen = await request(app)
      .post(`/api/review/request/${reqId}/reopen`)
      .set("x-test-user", f1.id)
      .send({});
    expect(reopen.status).toBe(200);
    expect(reopen.body.status).toBe("pending");

    // appliedRef is preserved (effect not orphaned); closed/decision fields wiped;
    // and the prior-round votes are CLEARED so reopen is a genuine fresh start —
    // not instantly re-finalized by finalize-on-read.
    const [reopened] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(reopened.appliedRef).toBe(closedRow.appliedRef);
    expect(reopened.closedAt).toBeNull();
    expect(reopened.closedBy).toBeNull();
    expect(reopened.reviewedAt).toBeNull();
    expect(await db.select().from(reviewVotes).where(eq(reviewVotes.subjectId, reqId))).toHaveLength(0);

    // With no carried-over votes, a staff-queue read (finalize-on-read) must
    // leave the reopened ticket pending — reopen actually reopens it.
    const queue = await request(app).get("/api/requests").set("x-test-user", f1.id);
    expect(queue.body.find((r: { id: number }) => r.id === reqId).status).toBe("pending");
    const [stillPending] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(stillPending.status).toBe("pending");

    // Re-vote to a fresh approval, then re-close. Because appliedRef is
    // preserved, the second close only archives — it never materializes a
    // second inventory item.
    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });
    const reClose = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", f1.id)
      .send({});
    expect(reClose.status).toBe(200);
    expect(reClose.body.status).toBe("closed");
    expect(await db.select().from(inventoryItems)).toHaveLength(1);
  });

  it("removing a vote on an APPROVED (staged) request reverts it to pending and clears the decision", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const { reqId } = await submitGunRequest(owner.id);

    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    const decide = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });
    expect(decide.body.status).toBe("approved");

    // Re-casting the same vote toggles it off; the tally now falls below the
    // majority so the staged approval is walked back to pending.
    const remove = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });
    expect(remove.status).toBe(200);
    expect(remove.body.status).toBe("pending");
    expect(remove.body.decided).toBeNull();

    const [reverted] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(reverted.status).toBe("pending");
    expect(reverted.reviewedAt).toBeNull();
    expect(reverted.reviewedById).toBeNull();
    expect(reverted.decisionParams).toBeNull();
    expect(reverted.overriddenBy).toBeNull();
    // No effect was ever materialized (effects are deferred to close).
    expect(await db.select().from(inventoryItems)).toHaveLength(0);
  });

  it("lets an admin override-approve a vote-rejected (staged) request", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const admin = await createAdmin();
    const { reqId } = await submitGunRequest(owner.id);

    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "reject" });
    const decide = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f2.id).send({ vote: "reject" });
    expect(decide.body.status).toBe("rejected");

    // Admin override flips the staged rejection to an approval without a reopen.
    const override = await request(app)
      .post(`/api/requests/${reqId}/override`)
      .set("x-test-user", admin.id)
      .send({ decision: "approve" });
    expect(override.status).toBe(200);

    const [flipped] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(flipped.status).toBe("approved");
    expect(flipped.overriddenBy).toBe(admin.id);
    // Still staged — the effect is only committed at close.
    expect(flipped.appliedRef).toBeNull();
    expect(await db.select().from(inventoryItems)).toHaveLength(0);
  });
});

// Park a request in the legacy `changes_requested` state directly. The
// request-changes endpoint that used to do this is retired (it now 410s and
// never blocks), but legacy rows still exist and must keep resubmitting.
async function parkChangesRequested(reqId: number, note = "needs work") {
  await db
    .update(customRequests)
    .set({ status: "changes_requested", reviewerNote: note })
    .where(eq(customRequests.id, reqId));
}

describe("custom request request-changes (retired) + resubmit", () => {
  it("request-changes is retired: returns 410 and never parks/blocks the request", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { reqId } = await submitGunRequest(owner.id);

    const rc = await request(app)
      .post(`/api/requests/${reqId}/request-changes`)
      .set("x-test-user", fixer.id)
      .send({ comment: "Pick a different model." });
    expect(rc.status).toBe(410);
    expect(mockDm).not.toHaveBeenCalled();

    // Untouched — still pending, and no request_changes audit was written.
    const [after] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(after.status).toBe("pending");
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "request_changes"));
    expect(audits).toHaveLength(0);
  });

  it("a legacy changes_requested request still resubmits back to pending", async () => {
    const owner = await createUser();
    const { reqId } = await submitGunRequest(owner.id);
    await parkChangesRequested(reqId, "Pick a different model.");

    const resub = await request(app)
      .post(`/api/requests/${reqId}/resubmit`)
      .set("x-test-user", owner.id)
      .send({});
    expect(resub.status).toBe(200);
    expect(resub.body.status).toBe("pending");
  });

  it("clears prior votes on resubmit so the next round starts fresh", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    await createFixer();
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

    // A legacy changes_requested park, then the owner resubmits.
    await parkChangesRequested(reqId, "Reconsider.");
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

// monthly_rent is an int4 column (max ~2.1B). A fat-fingered rent above that
// overflows on insert and used to surface as an opaque 500. The approve step
// now CLAMPS a too-large value down to the ceiling (so a typo is silently
// corrected, never staged out of range), while the close/apply step still
// fails a directly-corrupted (bypassed-normalize) over-cap value with a 400.
const MAX_MONEY = 2_000_000_000;
describe("property rent overflow guard", () => {
  const OVER_CAP = 100_000_000_000_000; // 100 trillion — well past int4 max

  async function submitPropertyRequest(ownerId: string) {
    const char = await createCharacter({ ownerId });
    const res = await request(app)
      .post("/api/requests")
      .set("x-test-user", ownerId)
      .send({ type: "property", characterId: char.id, title: "Afterlife Apartment", description: "Above the bar" });
    expect(res.status).toBe(201);
    return { char, reqId: res.body.id as number };
  }

  it("clamps an over-cap monthlyRent down to the ceiling at close time", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const { reqId } = await submitPropertyRequest(owner.id);

    // Override only STAGES the approval (no mechanical params); decisionParams
    // stays null until the closer supplies the rent at CLOSE & APPLY.
    const res = await request(app)
      .post(`/api/requests/${reqId}/override`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);
    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(row.status).toBe("approved");
    expect(row.decisionParams).toBeNull();

    // The over-cap rent supplied at close is clamped down to the ceiling.
    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", admin.id)
      .send({ monthlyRent: OVER_CAP, kind: "residential", district: "Watson", tier: "T2" });
    expect(close.status).toBe(200);
    const [lease] = await db.select().from(housing);
    expect(lease.monthlyRent).toBe(MAX_MONEY);
  });

  it("fails an already-staged over-cap request with a clean 400 on close, not a 500, and creates no lease", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const { reqId } = await submitPropertyRequest(owner.id);

    // Stage a valid approval, then corrupt the stored rent to simulate a row
    // approved before the guard existed.
    const ok = await request(app)
      .post(`/api/requests/${reqId}/override`)
      .set("x-test-user", admin.id)
      .send({ monthlyRent: 5000, kind: "residential" });
    expect(ok.status).toBe(200);
    await db
      .update(customRequests)
      .set({ decisionParams: { monthlyRent: OVER_CAP, kind: "residential" } as never })
      .where(eq(customRequests.id, reqId));

    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", admin.id)
      .send({});
    expect(close.status).toBe(400);
    expect(await db.select().from(housing)).toHaveLength(0);

    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(row.status).toBe("approved");
    expect(row.appliedRef).toBeNull();
  });

  it("lets an admin re-override an already-approved (not yet applied) request; params supplied at close", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const { reqId } = await submitPropertyRequest(owner.id);

    // First override stages the approval (no params).
    const first = await request(app)
      .post(`/api/requests/${reqId}/override`)
      .set("x-test-user", admin.id)
      .send({});
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("approved");

    // Re-override of an approved-but-unapplied ticket must be accepted, not 409'd.
    const second = await request(app)
      .post(`/api/requests/${reqId}/override`)
      .set("x-test-user", admin.id)
      .send({});
    expect(second.status).toBe(200);

    const [staged] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(staged.status).toBe("approved");
    expect(staged.decisionParams).toBeNull();

    // The closer supplies the mechanical params at CLOSE & APPLY.
    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", admin.id)
      .send({ monthlyRent: 2500, kind: "business", district: "Watson", tier: "T1" });
    expect(close.status).toBe(200);
    const [lease] = await db.select().from(housing);
    expect(lease.monthlyRent).toBe(2500);
  });

  it("409s a re-override once the request has been applied (closed)", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const { reqId } = await submitPropertyRequest(owner.id);

    const ok = await request(app)
      .post(`/api/requests/${reqId}/override`)
      .set("x-test-user", admin.id)
      .send({});
    expect(ok.status).toBe(200);
    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", admin.id)
      .send({ monthlyRent: 2500, kind: "residential", district: "Watson", tier: "T2" });
    expect(close.status).toBe(200);

    const after = await request(app)
      .post(`/api/requests/${reqId}/override`)
      .set("x-test-user", admin.id)
      .send({ monthlyRent: 3000, kind: "residential" });
    expect(after.status).toBe(409);
  });
});

// A ticket can collect enough approvals to pass majority only AFTER the
// eligible reviewer pool shrinks (a reviewer's role is revoked or they leave).
// The decision is otherwise only evaluated at vote-cast time, so the ticket is
// stranded `pending` with no Close & Apply. Reading the staff queue must
// re-evaluate and finalize it.
describe("auto-finalize on staff-queue read after reviewer pool shrinks", () => {
  it("flips a stranded pending request to approved when the shrunk pool drops the threshold", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const f3 = await createFixer();
    const f4 = await createFixer(); // pool of 4 → threshold 3
    const { reqId } = await submitGunRequest(owner.id);

    // Two approvals — not enough at threshold 3, so it stays pending.
    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    const second = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });
    expect(second.body.decided).toBeNull();
    expect(second.body.status).toBe("pending");
    expect(second.body.threshold).toBe(3);

    // Reading the queue now must NOT finalize — the tally is still short.
    const before = await request(app).get("/api/requests").set("x-test-user", f3.id);
    expect(before.body.find((r: { id: number }) => r.id === reqId).status).toBe("pending");

    // A non-voting reviewer loses their role: pool 4 → 3, threshold 3 → 2.
    await db.update(users).set({ roles: [] }).where(eq(users.id, f4.id));

    // The next staff-queue read self-heals the stranded ticket to approved.
    const after = await request(app).get("/api/requests").set("x-test-user", f3.id);
    const entry = after.body.find((r: { id: number }) => r.id === reqId);
    expect(entry.status).toBe("approved");

    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(row.status).toBe("approved");
    // Effect stays DEFERRED to close — nothing materialized yet.
    expect(row.appliedRef).toBeNull();
    expect(await db.select().from(inventoryItems)).toHaveLength(0);

    // An auto-finalize audit row is recorded for traceability.
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "request_auto_finalize_approve"));
    expect(audits).toHaveLength(1);

    // Close & Apply now works and materializes exactly one item.
    const close = await request(app)
      .post(`/api/review/request/${reqId}/close`)
      .set("x-test-user", f3.id)
      .send({ category: "Power", weaponType: "Pistol", fireMode: "Semi-Auto", powerLevel: "M" });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    expect(await db.select().from(inventoryItems)).toHaveLength(1);
  });

  it("flips a stranded pending request to rejected when the shrunk pool drops the threshold", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const f3 = await createFixer();
    const f4 = await createFixer(); // pool of 4 → threshold 3
    const { reqId } = await submitGunRequest(owner.id);

    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "reject" });
    const second = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f2.id).send({ vote: "reject" });
    expect(second.body.decided).toBeNull();
    expect(second.body.status).toBe("pending");

    await db.update(users).set({ roles: [] }).where(eq(users.id, f4.id));

    // The row is still pending in the DB, so it surfaces in the default (pending)
    // queue; the read finalizes it in place and the entry flips to rejected.
    const after = await request(app).get("/api/requests").set("x-test-user", f3.id);
    const entry = after.body.find((r: { id: number }) => r.id === reqId);
    expect(entry?.status).toBe("rejected");

    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(row.status).toBe("rejected");
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "request_auto_finalize_reject"));
    expect(audits).toHaveLength(1);
  });

  // CS_APPROVERs are eligible requests voters but were previously locked out of
  // the staff queue (fixer/admin-only), so they could never trigger the
  // finalize-on-read. The queue is now reviewer-gated; a CS_APPROVER opening it
  // must self-heal a stranded ticket just like a fixer.
  it("lets a CS_APPROVER trigger finalize-on-read after the pool shrinks", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const cs = await createCsApprover();
    const f4 = await createFixer(); // pool of 4 → threshold 3
    const { reqId } = await submitGunRequest(owner.id);

    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    const second = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });
    expect(second.body.status).toBe("pending");
    expect(second.body.threshold).toBe(3);

    // A non-voting reviewer loses their role: pool 4 → 3, threshold 3 → 2.
    await db.update(users).set({ roles: [] }).where(eq(users.id, f4.id));

    // The CS_APPROVER can now reach the queue AND self-heal the stranded ticket.
    const after = await request(app).get("/api/requests").set("x-test-user", cs.id);
    expect(after.status).toBe(200);
    const entry = after.body.find((r: { id: number }) => r.id === reqId);
    expect(entry?.status).toBe("approved");

    const [row] = await db.select().from(customRequests).where(eq(customRequests.id, reqId));
    expect(row.status).toBe("approved");
    expect(row.appliedRef).toBeNull();
  });
});

// Re-casting the SAME vote you already hold clears it (un-vote); switching to
// the other value updates in place. Single-click toggle for reviewers.
describe("custom request voting — toggle (un-vote)", () => {
  it("clears the vote on a repeat click and switches when the other value is chosen", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    await createFixer();
    await createFixer(); // pool 3 → threshold 2, so one vote never decides
    const { reqId } = await submitGunRequest(owner.id);
    const countVotes = async () =>
      (await db.select().from(reviewVotes).where(and(eq(reviewVotes.subjectType, "request"), eq(reviewVotes.subjectId, reqId)))).length;

    const v1 = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    expect(v1.body.approveCount).toBe(1);
    expect(await countVotes()).toBe(1);

    // Re-casting approve clears it.
    const v2 = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    expect(v2.status).toBe(200);
    expect(v2.body.approveCount).toBe(0);
    expect(v2.body.status).toBe("pending");
    expect(await countVotes()).toBe(0);

    // A fresh reject, then a repeat reject clears it again.
    expect((await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "reject" })).body.rejectCount).toBe(1);
    expect((await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "reject" })).body.rejectCount).toBe(0);
    expect(await countVotes()).toBe(0);

    // Switching approve → reject updates in place (no clear).
    await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    const v5 = await request(app).post(`/api/requests/${reqId}/vote`).set("x-test-user", f1.id).send({ vote: "reject" });
    expect(v5.body.approveCount).toBe(0);
    expect(v5.body.rejectCount).toBe(1);
    const rows = await db.select().from(reviewVotes).where(and(eq(reviewVotes.subjectType, "request"), eq(reviewVotes.subjectId, reqId)));
    expect(rows).toHaveLength(1);
    expect(rows[0].vote).toBe("reject");
  });
});
