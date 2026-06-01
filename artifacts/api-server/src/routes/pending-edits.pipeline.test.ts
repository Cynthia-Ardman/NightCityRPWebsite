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

import { db, characters, pendingCharacterEdits, pendingEditApprovals, activityEvents } from "@workspace/db";
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
  it("holds at pending after one of two required approvals, then applies on the second", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer(); // third reviewer makes the majority threshold 2
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

describe("pending edit request-changes + resubmit", () => {
  it("parks the edit in changes_requested, DMs the submitter, then resubmit returns it to pending", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { edit } = await seedPendingEdit({ submitterId: owner.id });

    const rc = await request(app)
      .post(`/api/pending-edits/${edit.id}/request-changes`)
      .set("x-test-user", fixer.id)
      .send({ comment: "Tighten the backstory." });
    expect(rc.status).toBe(200);
    expect(mockDm).toHaveBeenCalledTimes(1);

    const [parked] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(parked.status).toBe("changes_requested");
    expect(parked.reviewComment).toBe("Tighten the backstory.");

    const events = await db.select().from(activityEvents).where(eq(activityEvents.kind, "character_edit_changes_requested"));
    expect(events.length).toBeGreaterThanOrEqual(1);

    const resub = await request(app)
      .post(`/api/pending-edits/${edit.id}/resubmit`)
      .set("x-test-user", owner.id)
      .send({});
    expect(resub.status).toBe(200);

    const [back] = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, edit.id));
    expect(back.status).toBe("pending");
  });

  it("editing a character in changes_requested UPDATES the same review instead of creating a new one", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { char, edit } = await seedPendingEdit({ submitterId: owner.id });

    // Fixer sends it back for changes.
    const rc = await request(app)
      .post(`/api/pending-edits/${edit.id}/request-changes`)
      .set("x-test-user", fixer.id)
      .send({ comment: "Needs more detail." });
    expect(rc.status).toBe(200);

    // Owner re-edits the character (the response to the request). This must
    // amend the EXISTING review, not spawn a second one.
    const patch = await request(app)
      .patch(`/api/characters/${char.id}`)
      .set("x-test-user", owner.id)
      .send({ background: "a much richer story" });
    expect(patch.status).toBe(202);
    expect(patch.body.pendingEditId).toBe(edit.id);

    // Exactly one edit row for this character, reused and back to pending with
    // the new content and the prior decision/comment cleared.
    const rows = await db.select().from(pendingCharacterEdits).where(eq(pendingCharacterEdits.characterId, char.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(edit.id);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].reviewComment).toBeNull();
    expect((rows[0].proposedDiff as { background?: string }).background).toBe("a much richer story");
  });

  it("clears prior votes when an edit is updated-and-resubmitted via a character PATCH", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer(); // threshold 2
    const { char, edit } = await seedPendingEdit({ submitterId: owner.id });

    await request(app)
      .post(`/api/pending-edits/${edit.id}/vote`)
      .set("x-test-user", f1.id)
      .send({ vote: "approve" });
    await request(app)
      .post(`/api/pending-edits/${edit.id}/request-changes`)
      .set("x-test-user", f2.id)
      .send({ comment: "Redo it." });

    const patch = await request(app)
      .patch(`/api/characters/${char.id}`)
      .set("x-test-user", owner.id)
      .send({ background: "rewritten" });
    expect(patch.status).toBe(202);
    expect(patch.body.pendingEditId).toBe(edit.id);

    expect(await db.select().from(pendingEditApprovals).where(eq(pendingEditApprovals.editId, edit.id))).toHaveLength(0);
  });

  it("never reverts a decided edit: a later PATCH leaves the approved row alone and opens a fresh edit", async () => {
    const owner = await createUser();
    const admin = await createAdmin();
    const fixer = await createFixer();
    const { char, edit } = await seedPendingEdit({ submitterId: owner.id });

    // Fixer requests changes, then an admin overrides it to approved before the
    // owner gets around to re-editing.
    await request(app)
      .post(`/api/pending-edits/${edit.id}/request-changes`)
      .set("x-test-user", fixer.id)
      .send({ comment: "Fix it." });
    const override = await request(app)
      .post(`/api/pending-edits/${edit.id}/override`)
      .set("x-test-user", admin.id)
      .send({});
    expect(override.status).toBe(200);
    expect(override.body.status).toBe("approved");

    // A later edit must NOT reopen the decided row; it opens a new review.
    const patch = await request(app)
      .patch(`/api/characters/${char.id}`)
      .set("x-test-user", owner.id)
      .send({ background: "an even newer story" });
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

  it("400s request-changes without a comment", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const { edit } = await seedPendingEdit({ submitterId: owner.id });
    const res = await request(app)
      .post(`/api/pending-edits/${edit.id}/request-changes`)
      .set("x-test-user", fixer.id)
      .send({});
    expect(res.status).toBe(400);
  });

  it("clears prior approvals on resubmit so the next round starts fresh", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer(); // threshold 2 so one approve does not decide
    const { edit } = await seedPendingEdit({ submitterId: owner.id });

    // One approve vote lands while still pending.
    const vote = await request(app)
      .post(`/api/pending-edits/${edit.id}/vote`)
      .set("x-test-user", f1.id)
      .send({ vote: "approve" });
    expect(vote.body.status).toBe("pending");
    expect(await db.select().from(pendingEditApprovals).where(eq(pendingEditApprovals.editId, edit.id))).toHaveLength(1);

    // A second reviewer sends it back for changes, then the owner resubmits.
    const rc = await request(app)
      .post(`/api/pending-edits/${edit.id}/request-changes`)
      .set("x-test-user", f2.id)
      .send({ comment: "Reconsider." });
    expect(rc.status).toBe(200);

    const resub = await request(app)
      .post(`/api/pending-edits/${edit.id}/resubmit`)
      .set("x-test-user", owner.id)
      .send({});
    expect(resub.status).toBe(200);

    // Approvals wiped — the fresh round starts from zero.
    expect(await db.select().from(pendingEditApprovals).where(eq(pendingEditApprovals.editId, edit.id))).toHaveLength(0);
  });
});
