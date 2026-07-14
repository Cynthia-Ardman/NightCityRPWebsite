import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { db, loreEntries, lorePendingEdits, loreImportDrafts, reviewVotes, auditLog, users } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

// Best-effort fixer DMs on decisions must never reach the real Discord API in
// tests; stub the sender so decisions resolve without network.
vi.mock("../lib/discord", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, sendDirectMessage: vi.fn().mockResolvedValue(undefined) };
});

const app = buildTestApp();

// Submitters of lore proposals are fixers/admins (eligibility unchanged).
function createFixer(opts: { id?: string; username?: string } = {}) {
  return createUser({ ...opts, roles: ["fixer"] });
}
// Eligible voters are the CS_APPROVER pool (mirrors the shared review
// pipeline). They also carry the fixer role so staff-view paths resolve.
function createReviewer() {
  return createUser({ roles: ["fixer", "cs approver"] });
}

async function seedEntry(overrides: Partial<typeof loreEntries.$inferInsert> = {}) {
  const [e] = await db
    .insert(loreEntries)
    .values({
      category: "corporation",
      name: "Arasaka",
      slug: `arasaka-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      publicBody: "A megacorporation.",
      fixerBody: "Secret: the board answers to Saburo's ghost.",
      sources: [{ label: "Lore Bible", url: "https://example.com/arasaka" }] as never,
      ...overrides,
    })
    .returning();
  return e;
}

async function submitCreate(fixerId: string, diff: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/directory/lore/edits")
    .set("x-test-user", fixerId)
    .send({ kind: "create", diff });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

describe("GET /directory/lore/:id (fixer-only content gating)", () => {
  it("serves a non-staff player the entry with fixer-only content redacted", async () => {
    const player = await createUser();
    const entry = await seedEntry();

    const res = await request(app)
      .get(`/api/directory/lore/${entry.id}`)
      .set("x-test-user", player.id);

    expect(res.status).toBe(200);
    expect(res.body.fixerBody).toBeNull();
    expect(res.body.sources).toEqual([]);
    expect(res.body.canViewFixer).toBe(false);
    expect(res.body.hasFixerContent).toBe(true);
  });

  it("returns full fixerBody and sources to a fixer", async () => {
    const fixer = await createFixer();
    const entry = await seedEntry();

    const res = await request(app)
      .get(`/api/directory/lore/${entry.id}`)
      .set("x-test-user", fixer.id);

    expect(res.status).toBe(200);
    expect(res.body.fixerBody).toBe("Secret: the board answers to Saburo's ghost.");
    expect(res.body.sources).toEqual([{ label: "Lore Bible", url: "https://example.com/arasaka" }]);
    expect(res.body.canViewFixer).toBe(true);
  });

  it("returns full fixerBody and sources to an admin", async () => {
    const admin = await createAdmin();
    const entry = await seedEntry();

    const res = await request(app)
      .get(`/api/directory/lore/${entry.id}`)
      .set("x-test-user", admin.id);

    expect(res.status).toBe(200);
    expect(res.body.fixerBody).toBe("Secret: the board answers to Saburo's ghost.");
    expect(res.body.sources.length).toBe(1);
    expect(res.body.canViewFixer).toBe(true);
  });
});

describe("Fixer proposals create pending edits, not live entries", () => {
  it("a fixer create-proposal stages a pending edit and publishes nothing", async () => {
    const fixer = await createFixer();

    const res = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", fixer.id)
      .send({
        kind: "create",
        diff: {
          category: "gang",
          name: "Maelstrom",
          publicBody: "Chrome-obsessed gang.",
          fixerBody: "Leadership rotates after every cyberpsycho incident.",
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.kind).toBe("create");

    // Nothing is live yet.
    const live = await db.select().from(loreEntries).where(eq(loreEntries.name, "Maelstrom"));
    expect(live.length).toBe(0);

    // The pending edit row exists and is owned by the fixer.
    const pending = await db
      .select()
      .from(lorePendingEdits)
      .where(eq(lorePendingEdits.id, res.body.id));
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe("pending");
    expect(pending[0].submittedBy).toBe(fixer.id);
  });

  it("forbids a non-staff player from proposing edits", async () => {
    const player = await createUser();
    const res = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", player.id)
      .send({ kind: "create", diff: { category: "gang", name: "Nope" } });
    expect(res.status).toBe(403);
  });

  it("a fixer edit-proposal snapshots the targeted fields without touching the live entry", async () => {
    const fixer = await createFixer();
    const entry = await seedEntry({ name: "Militech", publicBody: "Arms manufacturer." });

    const res = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", fixer.id)
      .send({
        kind: "edit",
        loreEntryId: entry.id,
        diff: { publicBody: "The largest arms manufacturer in the world." },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.beforeSnapshot).toMatchObject({ publicBody: "Arms manufacturer." });

    // The live entry is unchanged until the proposal is closed & applied.
    const [stillLive] = await db.select().from(loreEntries).where(eq(loreEntries.id, entry.id));
    expect(stillLive.publicBody).toBe("Arms manufacturer.");
  });
});

describe("lore voting — majority threshold + apply at close", () => {
  it("holds at pending after one approval, approves (no effect) on the second, publishes only on close", async () => {
    const submitter = await createFixer();
    const r1 = await createReviewer();
    const r2 = await createReviewer();
    await createReviewer(); // third reviewer makes the majority threshold 2
    const reqId = await submitCreate(submitter.id, {
      category: "gang",
      name: "Tyger Claws",
      publicBody: "A gang operating out of Japantown.",
      fixerBody: "Pay protection to the Arasaka remnant.",
    });

    const first = await request(app)
      .post(`/api/directory/lore/edits/${reqId}/vote`)
      .set("x-test-user", r1.id)
      .send({ vote: "approve" });
    expect(first.status).toBe(200);
    expect(first.body.decided).toBeNull();
    expect(first.body.status).toBe("pending");
    expect(first.body.approveCount).toBe(1);
    expect(first.body.threshold).toBe(2);
    // Nothing live yet.
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "Tyger Claws"))).toHaveLength(0);

    const second = await request(app)
      .post(`/api/directory/lore/edits/${reqId}/vote`)
      .set("x-test-user", r2.id)
      .send({ vote: "approve" });
    expect(second.status).toBe(200);
    expect(second.body.decided).toBe("approved");
    expect(second.body.status).toBe("approved");
    // Staged lifecycle: approval no longer applies the effect.
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "Tyger Claws"))).toHaveLength(0);

    // Roster/voters contract parity: a reviewer detail read carries voters keyed
    // by user id (NOT a vote-record id), so the UI can match them against the
    // eligible-reviewer roster. Both approvers must appear, none extra.
    const detail = await request(app).get(`/api/directory/lore/edits/${reqId}`).set("x-test-user", r1.id);
    expect(detail.status).toBe(200);
    const card = detail.body;
    expect(card.eligibleVoterCount).toBe(3);
    expect(card.approveCount).toBe(2);
    const voterIds = (card.voters as { id: string; vote: string }[]).map((v) => v.id).sort();
    expect(voterIds).toEqual([r1.id, r2.id].sort());
    expect((card.eligibleReviewers as { id: string }[]).map((rv) => rv.id)).toEqual(
      expect.arrayContaining([r1.id, r2.id]),
    );
    expect(card.voters.every((v: { id: string }) => card.eligibleReviewers.some((rv: { id: string }) => rv.id === v.id))).toBe(true);

    // Close commits the deferred effect: exactly one live entry.
    const close = await request(app)
      .post(`/api/review/lore/${reqId}/close`)
      .set("x-test-user", r1.id)
      .send({});
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    const live = await db.select().from(loreEntries).where(eq(loreEntries.name, "Tyger Claws"));
    expect(live).toHaveLength(1);
    expect(live[0].publicBody).toBe("A gang operating out of Japantown.");
    expect(live[0].fixerBody).toBe("Pay protection to the Arasaka remnant.");

    const [row] = await db.select().from(lorePendingEdits).where(eq(lorePendingEdits.id, reqId));
    expect(row.appliedEntryId).toBe(live[0].id);

    // Closing again is idempotent — no second publish.
    const closeAgain = await request(app)
      .post(`/api/review/lore/${reqId}/close`)
      .set("x-test-user", r1.id)
      .send({});
    expect(closeAgain.status).toBe(200);
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "Tyger Claws"))).toHaveLength(1);
  });

  it("an edit-proposal applies its diff to the existing entry only at close", async () => {
    const submitter = await createFixer();
    const r1 = await createReviewer();
    const r2 = await createReviewer();
    await createReviewer();
    const entry = await seedEntry({ name: "Kang Tao", publicBody: "Smart-weapon corp." });

    const proposal = await request(app)
      .post("/api/directory/lore/edits")
      .set("x-test-user", submitter.id)
      .send({ kind: "edit", loreEntryId: entry.id, diff: { publicBody: "A Chinese smart-weapon manufacturer." } });
    expect(proposal.status).toBe(201);
    const reqId = proposal.body.id as number;

    await request(app).post(`/api/directory/lore/edits/${reqId}/vote`).set("x-test-user", r1.id).send({ vote: "approve" });
    const decide = await request(app).post(`/api/directory/lore/edits/${reqId}/vote`).set("x-test-user", r2.id).send({ vote: "approve" });
    expect(decide.body.status).toBe("approved");
    // Still unchanged before close.
    expect((await db.select().from(loreEntries).where(eq(loreEntries.id, entry.id)))[0].publicBody).toBe("Smart-weapon corp.");

    const close = await request(app).post(`/api/review/lore/${reqId}/close`).set("x-test-user", r1.id).send({});
    expect(close.status).toBe(200);
    const [updated] = await db.select().from(loreEntries).where(eq(loreEntries.id, entry.id));
    expect(updated.publicBody).toBe("A Chinese smart-weapon manufacturer.");
  });

  it("403s a reviewer voting on a proposal they submitted", async () => {
    const submitterReviewer = await createReviewer();
    await createReviewer();
    const reqId = await submitCreate(submitterReviewer.id, { category: "faction", name: "NCPD" });

    const res = await request(app)
      .post(`/api/directory/lore/edits/${reqId}/vote`)
      .set("x-test-user", submitterReviewer.id)
      .send({ vote: "approve" });
    expect(res.status).toBe(403);
  });

  it("403s a non-reviewer player attempting to vote", async () => {
    const submitter = await createFixer();
    const player = await createUser();
    const reqId = await submitCreate(submitter.id, { category: "faction", name: "Voodoo Boys" });

    const res = await request(app)
      .post(`/api/directory/lore/edits/${reqId}/vote`)
      .set("x-test-user", player.id)
      .send({ vote: "approve" });
    expect(res.status).toBe(403);
  });
});

describe("lore override (admin)", () => {
  it("lets an admin approve immediately and records overriddenBy; effect deferred to close", async () => {
    const submitter = await createFixer();
    await createReviewer();
    await createReviewer(); // votes would otherwise be needed; override bypasses them
    const admin = await createAdmin();
    const reqId = await submitCreate(submitter.id, { category: "gang", name: "6th Street" });

    const res = await request(app)
      .post(`/api/directory/lore/edits/${reqId}/override`)
      .set("x-test-user", admin.id)
      .send({ decision: "approve" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    const [row] = await db.select().from(lorePendingEdits).where(eq(lorePendingEdits.id, reqId));
    expect(row.overriddenBy).toBe(admin.id);
    // Override approves but defers the publish to close.
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "6th Street"))).toHaveLength(0);

    const close = await request(app).post(`/api/review/lore/${reqId}/close`).set("x-test-user", admin.id).send({});
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "6th Street"))).toHaveLength(1);
  });

  it("lets an admin deny via override; close archives and publishes nothing", async () => {
    const submitter = await createFixer();
    const admin = await createAdmin();
    const reqId = await submitCreate(submitter.id, { category: "misc", name: "Rumor Mill" });

    const res = await request(app)
      .post(`/api/directory/lore/edits/${reqId}/override`)
      .set("x-test-user", admin.id)
      .send({ decision: "deny" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");

    const close = await request(app).post(`/api/review/lore/${reqId}/close`).set("x-test-user", admin.id).send({});
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "Rumor Mill"))).toHaveLength(0);
  });

  it("403s a non-admin reviewer attempting an override", async () => {
    const submitter = await createFixer();
    const reviewer = await createReviewer();
    const reqId = await submitCreate(submitter.id, { category: "gang", name: "Animals" });
    const res = await request(app)
      .post(`/api/directory/lore/edits/${reqId}/override`)
      .set("x-test-user", reviewer.id)
      .send({ decision: "approve" });
    expect(res.status).toBe(403);
  });
});

describe("lore close/reopen", () => {
  it("403s a non-reviewer closing a proposal and never publishes", async () => {
    const submitter = await createFixer();
    const r1 = await createReviewer();
    const r2 = await createReviewer();
    const outsider = await createUser();
    const reqId = await submitCreate(submitter.id, { category: "gang", name: "Wraiths" });

    await request(app).post(`/api/directory/lore/edits/${reqId}/vote`).set("x-test-user", r1.id).send({ vote: "approve" });
    const decide = await request(app).post(`/api/directory/lore/edits/${reqId}/vote`).set("x-test-user", r2.id).send({ vote: "approve" });
    expect(decide.body.status).toBe("approved");

    const close = await request(app).post(`/api/review/lore/${reqId}/close`).set("x-test-user", outsider.id).send({});
    expect(close.status).toBe(403);
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "Wraiths"))).toHaveLength(0);
  });

  it("reopens a CLOSED proposal to pending, preserves appliedEntryId + votes, and re-closing never double-publishes", async () => {
    const submitter = await createFixer();
    const r1 = await createReviewer();
    const r2 = await createReviewer();
    const reqId = await submitCreate(submitter.id, { category: "gang", name: "Scavengers" });

    await request(app).post(`/api/directory/lore/edits/${reqId}/vote`).set("x-test-user", r1.id).send({ vote: "approve" });
    await request(app).post(`/api/directory/lore/edits/${reqId}/vote`).set("x-test-user", r2.id).send({ vote: "approve" });

    const close = await request(app).post(`/api/review/lore/${reqId}/close`).set("x-test-user", r1.id).send({});
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "Scavengers"))).toHaveLength(1);

    const [closedRow] = await db.select().from(lorePendingEdits).where(eq(lorePendingEdits.id, reqId));
    expect(closedRow.appliedEntryId).toBeTruthy();

    const reopen = await request(app).post(`/api/review/lore/${reqId}/reopen`).set("x-test-user", r1.id).send({});
    expect(reopen.status).toBe(200);
    expect(reopen.body.status).toBe("pending");

    // appliedEntryId preserved (effect not orphaned); decision/closed fields
    // wiped; prior-round votes PRESERVED so reviewers needn't re-vote.
    const [reopened] = await db.select().from(lorePendingEdits).where(eq(lorePendingEdits.id, reqId));
    expect(reopened.appliedEntryId).toBe(closedRow.appliedEntryId);
    expect(reopened.closedAt).toBeNull();
    expect(reopened.closedBy).toBeNull();
    expect(reopened.decidedAt).toBeNull();
    expect(
      await db.select().from(reviewVotes).where(and(eq(reviewVotes.subjectType, "lore"), eq(reviewVotes.subjectId, reqId))),
    ).toHaveLength(2);

    // No re-voting needed: a reviewer queue read re-evaluates the carried-over
    // votes (finalize-on-read) and auto-finalizes back to approved.
    const queue = await request(app).get("/api/directory/lore/edits").set("x-test-user", r1.id);
    expect(queue.body.find((r: { id: number }) => r.id === reqId)?.status).toBe("approved");

    // Because appliedEntryId is preserved, the second close only archives — it
    // never publishes a second entry.
    const reClose = await request(app).post(`/api/review/lore/${reqId}/close`).set("x-test-user", r1.id).send({});
    expect(reClose.status).toBe(200);
    expect(reClose.body.status).toBe("closed");
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "Scavengers"))).toHaveLength(1);
  });
});

describe("lore finalize-on-read after the eligible pool shrinks", () => {
  it("flips a stranded pending proposal to approved when the shrunk pool drops the threshold", async () => {
    const submitter = await createFixer();
    const r1 = await createReviewer();
    const r2 = await createReviewer();
    const r3 = await createReviewer();
    const r4 = await createReviewer(); // pool of 4 → threshold 3
    const reqId = await submitCreate(submitter.id, { category: "gang", name: "Valentinos" });

    await request(app).post(`/api/directory/lore/edits/${reqId}/vote`).set("x-test-user", r1.id).send({ vote: "approve" });
    const second = await request(app).post(`/api/directory/lore/edits/${reqId}/vote`).set("x-test-user", r2.id).send({ vote: "approve" });
    expect(second.body.decided).toBeNull();
    expect(second.body.status).toBe("pending");
    expect(second.body.threshold).toBe(3);

    // A reviewing read while the tally is still short must NOT finalize.
    const before = await request(app).get("/api/directory/lore/edits").set("x-test-user", r3.id);
    expect(before.body.find((r: { id: number }) => r.id === reqId)?.status).toBe("pending");

    // A non-voting reviewer loses their role: pool 4 → 3, threshold 3 → 2.
    await db.update(users).set({ roles: [] }).where(eq(users.id, r4.id));

    // The next reviewer-queue read self-heals the stranded ticket to approved.
    const after = await request(app).get("/api/directory/lore/edits").set("x-test-user", r3.id);
    expect(after.body.find((r: { id: number }) => r.id === reqId)?.status).toBe("approved");

    const [row] = await db.select().from(lorePendingEdits).where(eq(lorePendingEdits.id, reqId));
    expect(row.status).toBe("approved");
    // Effect stays DEFERRED — nothing published yet.
    expect(row.appliedEntryId).toBeNull();
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "Valentinos"))).toHaveLength(0);

    // An auto-finalize audit row is recorded for traceability.
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "lore_auto_finalize_approve"));
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // Close & Apply now works and publishes exactly one entry.
    const close = await request(app).post(`/api/review/lore/${reqId}/close`).set("x-test-user", r3.id).send({});
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "Valentinos"))).toHaveLength(1);
  });
});

describe("retired admin approve/reject endpoints", () => {
  it("approve and reject both 410 (replaced by vote/override)", async () => {
    const submitter = await createFixer();
    const admin = await createAdmin();
    const reqId = await submitCreate(submitter.id, { category: "misc", name: "Old Flow" });

    const approve = await request(app)
      .post(`/api/directory/lore/edits/${reqId}/approve`)
      .set("x-test-user", admin.id)
      .send({});
    expect(approve.status).toBe(410);

    const reject = await request(app)
      .post(`/api/directory/lore/edits/${reqId}/reject`)
      .set("x-test-user", admin.id)
      .send({});
    expect(reject.status).toBe(410);

    // The proposal is untouched — still pending, nothing published.
    const [row] = await db.select().from(lorePendingEdits).where(eq(lorePendingEdits.id, reqId));
    expect(row.status).toBe("pending");
    expect(await db.select().from(loreEntries).where(eq(loreEntries.name, "Old Flow"))).toHaveLength(0);
  });
});

describe("import-draft approval stays on the admin flow", () => {
  it("carries imageUrl through an import-draft create approval", async () => {
    const admin = await createAdmin();
    const img = "/api/storage/objects/lore-import-night-corp.png";
    const [draft] = await db
      .insert(loreImportDrafts)
      .values({
        groupKey: `nightcorp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        proposedName: "Night Corp",
        proposedCategory: "corporation",
        publicBody: "An imported megacorp.",
        imageUrl: img,
      })
      .returning();

    const res = await request(app)
      .post(`/api/directory/lore/import/drafts/${draft.id}/approve`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBe(img);

    const [live] = await db
      .select()
      .from(loreEntries)
      .where(eq(loreEntries.id, res.body.id));
    expect(live.imageUrl).toBe(img);
  });
});
