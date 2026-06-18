import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";

vi.mock("../lib/discord", async (importActual) => {
  const actual = await importActual<typeof import("../lib/discord")>();
  return {
    ...actual,
    sendDirectMessage: vi.fn(async () => "dm-id"),
    postToChannel: vi.fn(async () => null),
  };
});

import { db, characters, pendingCharacterEdits, pendingEditApprovals, activityEvents, users } from "@workspace/db";
import { sendDirectMessage } from "../lib/discord";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin, createCharacter } from "../test/testDb";

const app = buildTestApp();
const mockDm = vi.mocked(sendDirectMessage);

beforeEach(() => {
  mockDm.mockReset();
  mockDm.mockResolvedValue("dm-id");
});

// Test reviewers hold the cs-approver role (the approver pool that casts counted
// votes — only CS_APPROVERs are eligible) plus the fixer role for staff-view
// paths.
function createFixer() {
  return createUser({ roles: ["fixer", "cs approver"] });
}

// Seed a pending edit directly: a character plus a proposed background change.
async function seedPendingEdit(opts: { submitterId: string; ownerId?: string | null }) {
  const created = await createCharacter({ ownerId: opts.ownerId ?? opts.submitterId, name: "Edit Target" });
  const [char] = await db
    .update(characters)
    .set({ background: "old story" })
    .where(eq(characters.id, created.id))
    .returning();
  const [edit] = await db
    .insert(pendingCharacterEdits)
    .values({
      characterId: char.id,
      submittedBy: opts.submitterId,
      proposedDiff: { background: "new story" },
      beforeSnapshot: { background: "old story" },
      status: "pending",
    })
    .returning();
  return { char, edit };
}

describe("pending edit voting — majority threshold", () => {
  it("holds at pending after one approval, approves (no apply) on the second, applies the diff only on close", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const f3 = await createFixer(); // third reviewer makes the majority threshold 2
    const { char, edit } = await seedPendingEdit({ submitterId: owner.id });

    const first = await request(app)
      .post(`/api/pending-edits/${edit.id}/vote`)
      .set("x-test-user", f1.id)
      .send({ vote: "approve" });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("pending");
    expect(first.body.approveCount).toBe(1);
    expect(first.body.threshold).toBe(2);

    const [midChar] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(midChar.background).toBe("old story");

    const second = await request(app)
      .post(`/api/pending-edits/${edit.id}/vote`)
      .set("x-test-user", f2.id)
      .send({ vote: "approve" });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("approved");

    const [afterEdit] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(afterEdit.status).toBe("approved");
    // Staged lifecycle: the diff is NOT applied at approval time.
    const [stillOldChar] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(stillOldChar.background).toBe("old story");

    // Close commits the diff and archives the edit.
    const close = await request(app)
      .post(`/api/review/edit/${edit.id}/close`)
      .set("x-test-user", f3.id)
      .send({});
    expect(close.status).toBe(200);
    const [closedEdit] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(closedEdit.status).toBe("closed");
    const [afterChar] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(afterChar.background).toBe("new story");
  });

  it("403s a reviewer voting on an edit they submitted", async () => {
    const fixerOwner = await createFixer();
    const { edit } = await seedPendingEdit({ submitterId: fixerOwner.id });
    const res = await request(app)
      .post(`/api/pending-edits/${edit.id}/vote`)
      .set("x-test-user", fixerOwner.id)
      .send({ vote: "approve" });
    expect(res.status).toBe(403);
  });
});

describe("pending edit override", () => {
  it("lets an admin approve immediately and records overriddenBy", async () => {
    const owner = await createUser();
    await createFixer();
    await createFixer(); // votes would otherwise be needed; override bypasses them
    const admin = await createAdmin();
    const { char, edit } = await seedPendingEdit({ submitterId: owner.id });

    const res = await request(app)
      .post(`/api/pending-edits/${edit.id}/override`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    const [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(row.overriddenBy).toBe(admin.id);
    // Override approves but defers the diff to close.
    const [beforeClose] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(beforeClose.background).toBe("old story");

    const close = await request(app)
      .post(`/api/review/edit/${edit.id}/close`)
      .set("x-test-user", admin.id)
      .send({});
    expect(close.status).toBe(200);
    const [afterChar] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(afterChar.background).toBe("new story");
  });

  it("403s a non-admin reviewer attempting an override", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { edit } = await seedPendingEdit({ submitterId: owner.id });
    const res = await request(app)
      .post(`/api/pending-edits/${edit.id}/override`)
      .set("x-test-user", fixer.id)
      .send({});
    expect(res.status).toBe(403);

    const [after] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(after.status).toBe("pending");
  });
});

// Park a pending edit in the legacy `changes_requested` state directly. The
// request-changes endpoint that used to do this is retired (it now 410s and
// never blocks), but legacy rows still exist and must keep working.
async function parkChangesRequested(editId: number, comment = "needs work") {
  await db
    .update(pendingCharacterEdits)
    .set({ status: "changes_requested", reviewComment: comment, decidedAt: null })
    .where(eq(pendingCharacterEdits.id, editId));
}

describe("pending edit request-changes (retired) + resubmit", () => {
  it("request-changes is retired: returns 410 and never parks/blocks the edit", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { edit } = await seedPendingEdit({ submitterId: owner.id });

    const rc = await request(app)
      .post(`/api/pending-edits/${edit.id}/request-changes`)
      .set("x-test-user", fixer.id)
      .send({ comment: "Tighten the backstory." });
    expect(rc.status).toBe(410);
    expect(mockDm).not.toHaveBeenCalled();

    // The edit is untouched — still pending, no blocking state introduced.
    const [after] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(after.status).toBe("pending");
  });

  it("a legacy changes_requested edit still resubmits back to pending", async () => {
    const owner = await createUser();
    const { edit } = await seedPendingEdit({ submitterId: owner.id });
    await parkChangesRequested(edit.id, "Tighten the backstory.");

    const resub = await request(app)
      .post(`/api/pending-edits/${edit.id}/resubmit`)
      .set("x-test-user", owner.id)
      .send({});
    expect(resub.status).toBe(200);

    const [back] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(back.status).toBe("pending");
  });

  it("editing a character with an in-flight review UPDATES the same review instead of creating a new one", async () => {
    const owner = await createUser();
    const { char, edit } = await seedPendingEdit({ submitterId: owner.id });

    // A legacy changes_requested row exists for this character.
    await parkChangesRequested(edit.id, "Needs more detail.");

    // Owner re-edits the character. This must amend the EXISTING review, not
    // spawn a second one.
    // NOTE: must edit a NON-cosmetic field. `background` is now a COSMETIC_FIELD
    // (auto-applies with a 200), so it no longer routes through the review queue.
    // `name` is review-required, which is what this pipeline test exercises.
    const patch = await request(app)
      .patch(`/api/characters/${char.id}`)
      .set("x-test-user", owner.id)
      .send({ name: "Renamed Edit Target" });
    expect(patch.status).toBe(202);
    expect(patch.body.pendingEditId).toBe(edit.id);

    // Exactly one edit row for this character, reused and back to pending with
    // the new content and the prior decision/comment cleared.
    const rows = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.characterId, char.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(edit.id);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].reviewComment).toBeNull();
    expect((rows[0].proposedDiff as { name?: string }).name).toBe("Renamed Edit Target");
  });

  it("clears prior votes when an edit is updated-and-resubmitted via a character PATCH", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    await createFixer();
    await createFixer(); // threshold 2
    const { char, edit } = await seedPendingEdit({ submitterId: owner.id });

    await request(app)
      .post(`/api/pending-edits/${edit.id}/vote`)
      .set("x-test-user", f1.id)
      .send({ vote: "approve" });
    await parkChangesRequested(edit.id, "Redo it.");

    // Non-cosmetic edit (`name`) so the PATCH routes through review, not the
    // cosmetic auto-apply path.
    const patch = await request(app)
      .patch(`/api/characters/${char.id}`)
      .set("x-test-user", owner.id)
      .send({ name: "Rewritten Name" });
    expect(patch.status).toBe(202);
    expect(patch.body.pendingEditId).toBe(edit.id);

    expect(await db.select().from(pendingEditApprovals).where(eq(pendingEditApprovals.editId, edit.id))).toHaveLength(0);
  });

  it("never reverts a decided edit: a later PATCH leaves the approved row alone and opens a fresh edit", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const { char, edit } = await seedPendingEdit({ submitterId: owner.id });

    // A legacy changes_requested row that an admin then overrides to approved
    // before the owner gets around to re-editing.
    await parkChangesRequested(edit.id, "Fix it.");
    const override = await request(app)
      .post(`/api/pending-edits/${edit.id}/override`)
      .set("x-test-user", admin.id)
      .send({});
    expect(override.status).toBe(200);
    expect(override.body.status).toBe("approved");

    // A later edit must NOT reopen the decided row; it opens a new review.
    // Non-cosmetic field (`name`) so the PATCH routes through review.
    const patch = await request(app)
      .patch(`/api/characters/${char.id}`)
      .set("x-test-user", owner.id)
      .send({ name: "Even Newer Name" });
    expect(patch.status).toBe(202);
    expect(patch.body.pendingEditId).not.toBe(edit.id);

    // Original stays approved; exactly one new pending row exists.
    const [original] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(original.status).toBe("approved");
    const pendingRows = await db
      .select()
      .from(pendingCharacterEdits)
      .where(and(eq(pendingCharacterEdits.characterId, char.id), eq(pendingCharacterEdits.status, "pending")));
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0].id).not.toBe(edit.id);
  });

  it("clears prior approvals on resubmit so the next round starts fresh", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    await createFixer();
    await createFixer(); // threshold 2 so one approve does not decide
    const { edit } = await seedPendingEdit({ submitterId: owner.id });

    // One approve vote lands while still pending.
    const vote = await request(app)
      .post(`/api/pending-edits/${edit.id}/vote`)
      .set("x-test-user", f1.id)
      .send({ vote: "approve" });
    expect(vote.body.status).toBe("pending");
    expect(await db.select().from(pendingEditApprovals).where(eq(pendingEditApprovals.editId, edit.id))).toHaveLength(1);

    // A legacy changes_requested park, then the owner resubmits.
    await parkChangesRequested(edit.id, "Reconsider.");
    const resub = await request(app)
      .post(`/api/pending-edits/${edit.id}/resubmit`)
      .set("x-test-user", owner.id)
      .send({});
    expect(resub.status).toBe(200);

    // Approvals wiped — the fresh round starts from zero.
    expect(await db.select().from(pendingEditApprovals).where(eq(pendingEditApprovals.editId, edit.id))).toHaveLength(0);
  });

  it("preserves prior approvals when an approved edit is reopened so reviewers needn't re-vote", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer(); // pool 3 → threshold 2
    const { edit } = await seedPendingEdit({ submitterId: owner.id });

    await request(app).post(`/api/pending-edits/${edit.id}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    await request(app).post(`/api/pending-edits/${edit.id}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });
    const [approved] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(approved.status).toBe("approved");

    const reopen = await request(app)
      .post(`/api/review/edit/${edit.id}/reopen`)
      .set("x-test-user", f1.id)
      .send({});
    expect(reopen.status).toBe(200);

    // Approvals survive the reopen.
    expect(
      await db.select().from(pendingEditApprovals).where(eq(pendingEditApprovals.editId, edit.id)),
    ).toHaveLength(2);

    // No re-vote needed: a reviewer detail read re-evaluates the carried-over
    // approvals (finalize-on-read) and auto-finalizes the edit back to approved.
    const detail = await request(app).get(`/api/pending-edits/${edit.id}`).set("x-test-user", f1.id);
    expect(detail.body.status).toBe("approved");
    const [refinalized] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(refinalized.status).toBe("approved");
  });
});

// An edit can pass majority only AFTER the eligible reviewer pool shrinks (a
// reviewer's role is revoked or they leave). The decision is otherwise only
// evaluated at vote-cast time, stranding the edit `pending` with no Close &
// Apply. The reviewer detail read must re-evaluate and finalize it.
describe("pending edit auto-finalize on reviewer read after pool shrinks", () => {
  it("flips a stranded pending edit to approved when the shrunk pool drops the threshold", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const f3 = await createFixer();
    const f4 = await createFixer(); // pool of 4 → threshold 3
    const { char, edit } = await seedPendingEdit({ submitterId: owner.id });

    await request(app).post(`/api/pending-edits/${edit.id}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    const second = await request(app).post(`/api/pending-edits/${edit.id}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });
    expect(second.body.status).toBe("pending");
    expect(second.body.threshold).toBe(3);

    // Reading the detail now must NOT finalize — the tally is still short.
    const before = await request(app).get(`/api/pending-edits/${edit.id}`).set("x-test-user", f3.id);
    expect(before.body.status).toBe("pending");

    // A non-voting reviewer loses their role: pool 4 → 3, threshold 3 → 2.
    await db.update(users).set({ roles: [] }).where(eq(users.id, f4.id));

    // The next reviewer detail read self-heals the stranded edit to approved.
    const after = await request(app).get(`/api/pending-edits/${edit.id}`).set("x-test-user", f3.id);
    expect(after.body.status).toBe("approved");

    const [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(row.status).toBe("approved");
    // The diff stays DEFERRED to close — character not yet changed.
    const [stillOld] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(stillOld.background).toBe("old story");

    // Close & Apply now works and commits the diff.
    const close = await request(app).post(`/api/review/edit/${edit.id}/close`).set("x-test-user", f3.id).send({});
    expect(close.status).toBe(200);
    const [afterChar] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(afterChar.background).toBe("new story");
  });

  it("flips a stranded pending edit to rejected and logs an activity event", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const f3 = await createFixer();
    const f4 = await createFixer(); // pool of 4 → threshold 3
    const { char, edit } = await seedPendingEdit({ submitterId: owner.id });

    await request(app).post(`/api/pending-edits/${edit.id}/vote`).set("x-test-user", f1.id).send({ vote: "reject" });
    await request(app).post(`/api/pending-edits/${edit.id}/vote`).set("x-test-user", f2.id).send({ vote: "reject" });

    await db.update(users).set({ roles: [] }).where(eq(users.id, f4.id));

    const after = await request(app).get(`/api/pending-edits/${edit.id}`).set("x-test-user", f3.id);
    expect(after.body.status).toBe("rejected");

    const [row] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(row.status).toBe("rejected");
    // Diff never applied on a rejection.
    const [unchanged] = await db.select().from(characters).where(eq(characters.id, char.id));
    expect(unchanged.background).toBe("old story");
    const events = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.kind, "character_edit_rejected"));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});

// Re-casting the SAME vote clears the approval row (un-vote); switching updates.
describe("pending edit voting — toggle (un-vote)", () => {
  it("clears the approval on a repeat click and switches when the other value is chosen", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    await createFixer();
    await createFixer(); // pool 3 → threshold 2
    const { edit } = await seedPendingEdit({ submitterId: owner.id });
    const countVotes = async () =>
      (await db.select().from(pendingEditApprovals).where(eq(pendingEditApprovals.editId, edit.id))).length;

    const v1 = await request(app).post(`/api/pending-edits/${edit.id}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    expect(v1.body.approveCount).toBe(1);
    expect(v1.body.cleared).toBe(false);
    expect(await countVotes()).toBe(1);

    const v2 = await request(app).post(`/api/pending-edits/${edit.id}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    expect(v2.status).toBe(200);
    expect(v2.body.cleared).toBe(true);
    expect(v2.body.approveCount).toBe(0);
    expect(v2.body.status).toBe("pending");
    expect(await countVotes()).toBe(0);

    // Switching approve → reject updates in place.
    await request(app).post(`/api/pending-edits/${edit.id}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    const v3 = await request(app).post(`/api/pending-edits/${edit.id}/vote`).set("x-test-user", f1.id).send({ vote: "reject" });
    expect(v3.body.cleared).toBe(false);
    expect(v3.body.approveCount).toBe(0);
    expect(v3.body.rejectCount).toBe(1);
    const rows = await db.select().from(pendingEditApprovals).where(eq(pendingEditApprovals.editId, edit.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].vote).toBe("reject");
  });
});
