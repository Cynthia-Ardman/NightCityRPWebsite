import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";

vi.mock("../lib/discord", async (importActual) => {
  const actual = await importActual<typeof import("../lib/discord")>();
  return {
    ...actual,
    sendDirectMessage: vi.fn(async () => "dm-id"),
    postToChannel: vi.fn(async () => null),
  };
});

import { db, characterSheets, characters, reviewVotes, auditLog, inventoryItems } from "@workspace/db";
import { sendDirectMessage } from "../lib/discord";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

const app = buildTestApp();
const mockDm = vi.mocked(sendDirectMessage);

beforeEach(() => {
  mockDm.mockReset();
  mockDm.mockResolvedValue("dm-id");
});

function createFixer() {
  return createUser({ roles: ["fixer"] });
}

// A bare pending sheet is enough to exercise the vote / override /
// request-changes pipeline (those paths don't re-validate sheet fields).
async function createPendingSheet(ownerId: string, name = "Test Subject") {
  const [s] = await db
    .insert(characterSheets)
    .values({ ownerId, name, status: "pending", data: { sheetType: "PC" } })
    .returning();
  return s;
}

// A fully-valid PC sheet payload — required so the /submit (resubmit) path
// passes validateSheetForSubmission.
function validSheetData(name: string) {
  return {
    sheetType: "PC",
    fullName: name,
    pronouns: "they/them",
    occupation: "Courier",
    psychProfile: "Calm under pressure.",
    physicalDescription: "Tall, augmented.",
    background: "Came up in Watson.",
    age: 27,
    skills: "Driving, Stealth",
    gear: ["Jacket"],
    portraitUrls: ["https://example.com/p.png"],
    statsImageUrls: ["https://example.com/s.png"],
  };
}

describe("sheet voting — majority threshold", () => {
  it("holds at pending after one approval, approves (no materialize) on the second, materializes only on close", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const f3 = await createFixer(); // third reviewer makes the majority threshold 2
    const sheet = await createPendingSheet(owner.id, "Majority Subject");

    const first = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", f1.id)
      .send({ vote: "approve" });
    expect(first.status).toBe(200);
    expect(first.body.decided).toBeNull();
    expect(first.body.status).toBe("pending");
    expect(first.body.approveCount).toBe(1);
    expect(first.body.threshold).toBe(2);

    const [midway] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(midway.status).toBe("pending");
    expect(midway.characterId).toBeNull();

    const second = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", f2.id)
      .send({ vote: "approve" });
    expect(second.status).toBe(200);
    expect(second.body.decided).toBe("approved");

    const [after] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(after.status).toBe("approved");
    // Staged lifecycle: the character is NOT materialized at approval time.
    expect(after.characterId).toBeNull();

    // Close materializes the character and archives the sheet.
    const close = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", f3.id)
      .send({});
    expect(close.status).toBe(200);
    const [closed] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(closed.status).toBe("closed");
    expect(closed.characterId).not.toBeNull();
    expect(await db.select().from(characters).where(eq(characters.id, closed.characterId!))).toHaveLength(1);
  });

  it("403s a reviewer voting on a sheet they submitted", async () => {
    const fixerOwner = await createFixer();
    const sheet = await createPendingSheet(fixerOwner.id, "Self Vote");
    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", fixerOwner.id)
      .send({ vote: "approve" });
    expect(res.status).toBe(403);

    const [after] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(after.status).toBe("pending");
  });
});

describe("sheet override", () => {
  it("lets an admin approve immediately and records overriddenBy", async () => {
    const owner = await createUser();
    await createFixer();
    await createFixer(); // votes would otherwise be needed; override bypasses them
    const admin = await createAdmin();
    const sheet = await createPendingSheet(owner.id, "Override Me");

    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/override`)
      .set("x-test-user", admin.id)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    const [row] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(row.overriddenBy).toBe(admin.id);
    // Override approves but defers materialization to close.
    expect(row.characterId).toBeNull();

    const close = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", admin.id)
      .send({});
    expect(close.status).toBe(200);
    const [closed] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(closed.status).toBe("closed");
    expect(closed.characterId).not.toBeNull();
  });

  it("403s a non-admin reviewer attempting an override", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const sheet = await createPendingSheet(owner.id, "No Override");
    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/override`)
      .set("x-test-user", fixer.id)
      .send({});
    expect(res.status).toBe(403);

    const [after] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(after.status).toBe("pending");
  });
});

// Park a sheet in the legacy `changes_requested` state directly. The
// request-changes endpoint that used to do this is retired (it now 410s and
// never blocks), but legacy rows still exist and must keep resubmitting.
async function parkChangesRequested(sheetId: number, note = "needs work") {
  await db
    .update(characterSheets)
    .set({ status: "changes_requested", decisionNote: note })
    .where(eq(characterSheets.id, sheetId));
}

describe("sheet request-changes (retired) + resubmit", () => {
  it("request-changes is retired: returns 410 and never parks/blocks the sheet", async () => {
    const owner = await createUser();
    const fixer = await createFixer();
    const sheet = await createPendingSheet(owner.id, "Needs Work");

    const rc = await request(app)
      .post(`/api/sheets/${sheet.id}/request-changes`)
      .set("x-test-user", fixer.id)
      .send({ comment: "Add a portrait." });
    expect(rc.status).toBe(410);
    expect(mockDm).not.toHaveBeenCalled();

    const [after] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(after.status).toBe("pending");
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "request_changes"));
    expect(audits).toHaveLength(0);
  });

  it("clears prior votes on resubmit so the next round starts fresh", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    await createFixer();
    await createFixer(); // threshold 2 so one approve does not decide
    const [sheet] = await db
      .insert(characterSheets)
      .values({ ownerId: owner.id, name: "Fresh Round", status: "pending", data: validSheetData("Fresh Round") })
      .returning();

    // One approve vote lands while still pending.
    const vote = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", f1.id)
      .send({ vote: "approve" });
    expect(vote.body.decided).toBeNull();
    expect(
      await db
        .select()
        .from(reviewVotes)
        .where(and(eq(reviewVotes.subjectType, "sheet"), eq(reviewVotes.subjectId, sheet.id))),
    ).toHaveLength(1);

    // A legacy changes_requested park, then the owner resubmits.
    await parkChangesRequested(sheet.id, "Reconsider.");
    const resub = await request(app)
      .post(`/api/sheets/${sheet.id}/submit`)
      .set("x-test-user", owner.id)
      .send({});
    expect(resub.status).toBe(200);
    expect(resub.body.status).toBe("pending");

    // Votes wiped — the fresh round starts from zero.
    expect(
      await db
        .select()
        .from(reviewVotes)
        .where(and(eq(reviewVotes.subjectType, "sheet"), eq(reviewVotes.subjectId, sheet.id))),
    ).toHaveLength(0);
  });
});

describe("sheet close — materialize-once idempotency", () => {
  async function seedApprovableSheet(ownerId: string) {
    const [s] = await db
      .insert(characterSheets)
      .values({
        ownerId,
        name: "Chrome Subject",
        status: "pending",
        data: {
          sheetType: "PC",
          cyberware: [{ name: "Cyberarm", slot: "arms", points: 2 }],
          gear: ["Armored Jacket", "Power Pistol"],
        },
      })
      .returning();
    return s;
  }

  it("close materializes exactly one character + one inventory seed, and a second close is a no-op", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer(); // third reviewer → majority threshold 2

    const sheet = await seedApprovableSheet(owner.id);

    // Two approvals decide the sheet (effects are deferred to close).
    for (const f of [f1, f2]) {
      const v = await request(app)
        .post(`/api/sheets/${sheet.id}/vote`)
        .set("x-test-user", f.id)
        .send({ vote: "approve" });
      expect(v.status).toBe(200);
    }
    const [decided] = await db
      .select()
      .from(characterSheets)
      .where(eq(characterSheets.id, sheet.id));
    expect(decided.status).toBe("approved");

    // First close: materialize character + seed inventory.
    const c1 = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", f1.id)
      .send({});
    expect(c1.status).toBe(200);

    const charsAfter1 = await db
      .select()
      .from(characters)
      .where(eq(characters.ownerId, owner.id));
    expect(charsAfter1).toHaveLength(1);
    const charId = charsAfter1[0].id;
    const invAfter1 = await db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.characterId, charId));
    // 1 cyberware + 2 gear seeded from the sheet.
    expect(invAfter1).toHaveLength(3);

    // Second close is idempotent: no duplicate character, no re-seed.
    const c2 = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", f2.id)
      .send({});
    expect(c2.status).toBe(200);

    expect(
      await db.select().from(characters).where(eq(characters.ownerId, owner.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, charId)),
    ).toHaveLength(3);

    // A closed sheet cannot be reopened.
    const reopen = await request(app)
      .post(`/api/review/sheet/${sheet.id}/reopen`)
      .set("x-test-user", f1.id)
      .send({});
    expect(reopen.status).toBe(409);
  });
});
