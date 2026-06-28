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

import {
  db,
  characterSheets,
  characters,
  reviewVotes,
  auditLog,
  inventoryItems,
  users,
  catalogCyberware,
  catalogGuns,
} from "@workspace/db";
import { sendDirectMessage } from "../lib/discord";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

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

    // First close: materialize character + seed inventory. "Cyberarm" is a
    // CUSTOM (non-catalog) item so its mechanical attributes must be supplied.
    const c1 = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", f1.id)
      .send({ sheetCyberware: [{ index: 0, cwp: 2, slot: "arms" }] });
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

// Closing a sheet that carries CUSTOM (non-catalog) cyberware/guns must require
// the closer to supply their mechanical attributes — reaching parity with the
// standalone custom cyberware/gun request close flow. Catalog items auto-resolve
// from the catalog and are never prompted.
describe("sheet close — custom item attribute resolution", () => {
  async function seedSheet(ownerId: string, data: Record<string, unknown>) {
    const [s] = await db
      .insert(characterSheets)
      .values({ ownerId, name: "Chrome Subject", status: "pending", data: { sheetType: "PC", ...data } })
      .returning();
    return s;
  }

  async function approveSheet(sheetId: number, reviewers: { id: string }[]) {
    for (const f of reviewers) {
      const v = await request(app)
        .post(`/api/sheets/${sheetId}/vote`)
        .set("x-test-user", f.id)
        .send({ vote: "approve" });
      expect(v.status).toBe(200);
    }
  }

  it("rejects the close with 400 when a custom cyberware item has no attributes", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer();
    const sheet = await seedSheet(owner.id, {
      cyberware: [{ name: "Frankenarm", slot: "arms", points: 3 }],
    });
    await approveSheet(sheet.id, [f1, f2]);

    const close = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", f1.id)
      .send({});
    expect(close.status).toBe(400);
    // No character is materialized on the failed close.
    expect(await db.select().from(characters).where(eq(characters.ownerId, owner.id))).toHaveLength(0);
    const [still] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(still.status).toBe("approved");
  });

  it("rejects the close with 400 when a custom gun has no attributes", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer();
    const sheet = await seedSheet(owner.id, { guns: ["Homemade Slugthrower"] });
    await approveSheet(sheet.id, [f1, f2]);

    const close = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", f1.id)
      .send({});
    expect(close.status).toBe(400);
    expect(await db.select().from(characters).where(eq(characters.ownerId, owner.id))).toHaveLength(0);
  });

  it("materializes custom cyberware + gun with the supplied attributes", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer();
    const sheet = await seedSheet(owner.id, {
      cyberware: [{ name: "Frankenarm", slot: "arms", points: 3, notes: "rusty" }],
      guns: ["Homemade Slugthrower"],
    });
    await approveSheet(sheet.id, [f1, f2]);

    const close = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", f1.id)
      .send({
        sheetCyberware: [{ index: 0, cwp: 3, slot: "arms" }],
        sheetGuns: [
          {
            index: 0,
            category: "Power",
            weaponType: "Pistol",
            fireMode: "Semi-Auto",
            powerLevel: "M",
            manufacturer: "Scav Built",
          },
        ],
      });
    expect(close.status).toBe(200);

    const [char] = await db.select().from(characters).where(eq(characters.ownerId, owner.id));
    expect(char).toBeTruthy();
    const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, char.id));
    const cyber = inv.find((i) => i.category === "cyberware");
    expect(cyber?.notes).toBe("CWP 3 · rusty · slot: arms");
    const gun = inv.find((i) => i.category === "gun");
    expect(gun?.notes).toBe("Manufacturer: Scav Built · Category: Power · Type: Pistol · Fire: Semi-Auto · Power: M");
  });

  it("auto-resolves catalog cyberware + gun without requiring attributes", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer();
    await db.insert(catalogCyberware).values({ name: "Kerenzikov", slot: "nervous system", cwp: "2" });
    await db
      .insert(catalogGuns)
      .values({ name: "Militech M-10AF Lexington", category: "Power", weaponType: "Pistol", fireMode: "Semi-Auto", powerLevel: "M", manufacturer: "Militech" });

    const sheet = await seedSheet(owner.id, {
      cyberware: [{ name: "Kerenzikov", slot: "ignored", points: 99 }],
      guns: ["Militech M-10AF Lexington"],
    });
    await approveSheet(sheet.id, [f1, f2]);

    // No sheetCyberware/sheetGuns params — catalog resolves them.
    const close = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", f1.id)
      .send({});
    expect(close.status).toBe(200);

    const [char] = await db.select().from(characters).where(eq(characters.ownerId, owner.id));
    const inv = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, char.id));
    const cyber = inv.find((i) => i.category === "cyberware");
    // Catalog CWP (2) + slot win over the player's typed values.
    expect(cyber?.notes).toBe("CWP 2 · slot: nervous system");
    const gun = inv.find((i) => i.category === "gun");
    expect(gun?.notes).toBe(
      "Manufacturer: Militech · Category: Power · Type: Pistol · Fire: Semi-Auto · Power: M",
    );
  });
});

// A sheet can pass majority only AFTER the eligible reviewer pool shrinks (a
// reviewer's role is revoked or they leave). The decision is otherwise only
// evaluated at vote-cast time, stranding the sheet `pending` with no Close &
// Apply. The reviewer detail read must re-evaluate and finalize it.
describe("sheet auto-finalize on reviewer read after pool shrinks", () => {
  it("flips a stranded pending sheet to approved when the shrunk pool drops the threshold", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    const f3 = await createFixer();
    const f4 = await createFixer(); // pool of 4 → threshold 3
    const sheet = await createPendingSheet(owner.id, "Stranded Subject");

    await request(app).post(`/api/sheets/${sheet.id}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    const second = await request(app).post(`/api/sheets/${sheet.id}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });
    expect(second.body.decided).toBeNull();
    expect(second.body.status).toBe("pending");
    expect(second.body.threshold).toBe(3);

    // Reading the detail now must NOT finalize — the tally is still short.
    const before = await request(app).get(`/api/sheets/${sheet.id}`).set("x-test-user", f3.id);
    expect(before.body.status).toBe("pending");

    // A non-voting reviewer loses their role: pool 4 → 3, threshold 3 → 2.
    await db.update(users).set({ roles: [] }).where(eq(users.id, f4.id));

    // The next reviewer detail read self-heals the stranded sheet to approved.
    const after = await request(app).get(`/api/sheets/${sheet.id}`).set("x-test-user", f3.id);
    expect(after.body.status).toBe("approved");

    const [row] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(row.status).toBe("approved");
    // Materialization stays DEFERRED to close — no character yet.
    expect(row.characterId).toBeNull();
    expect(await db.select().from(characters).where(eq(characters.ownerId, owner.id))).toHaveLength(0);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "sheet_auto_finalize_approved"));
    expect(audits).toHaveLength(1);

    // Close & Apply now works and materializes the character.
    const close = await request(app).post(`/api/review/sheet/${sheet.id}/close`).set("x-test-user", f3.id).send({});
    expect(close.status).toBe(200);
    const [closed] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(closed.status).toBe("closed");
    expect(closed.characterId).not.toBeNull();
  });
});

// Reopening an approved (but not-yet-closed) sheet must CLEAR the prior-round
// votes so it becomes a genuinely fresh review round. If votes were preserved,
// finalize-on-read would re-tally them on the next reviewer read and snap the
// sheet straight back to approved — making reopen look like it did nothing.
describe("sheet reopen clears votes", () => {
  it("clears prior votes and stays pending after a reopen", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    const f2 = await createFixer();
    await createFixer(); // pool 3 → threshold 2
    const sheet = await createPendingSheet(owner.id, "Reopen Clear Votes");

    await request(app).post(`/api/sheets/${sheet.id}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    await request(app).post(`/api/sheets/${sheet.id}/vote`).set("x-test-user", f2.id).send({ vote: "approve" });
    const [approved] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(approved.status).toBe("approved");

    const reopen = await request(app)
      .post(`/api/review/sheet/${sheet.id}/reopen`)
      .set("x-test-user", f1.id)
      .send({});
    expect(reopen.status).toBe(200);
    expect(reopen.body.status).toBe("pending");

    // Votes are wiped by the reopen.
    expect(
      await db
        .select()
        .from(reviewVotes)
        .where(and(eq(reviewVotes.subjectType, "sheet"), eq(reviewVotes.subjectId, sheet.id))),
    ).toHaveLength(0);

    // A reviewer detail read does NOT re-finalize — the sheet stays pending
    // because there are no carried-over votes to re-tally.
    const detail = await request(app).get(`/api/sheets/${sheet.id}`).set("x-test-user", f1.id);
    expect(detail.body.status).toBe("pending");
    const [stillPending] = await db.select().from(characterSheets).where(eq(characterSheets.id, sheet.id));
    expect(stillPending.status).toBe("pending");
    expect(stillPending.characterId).toBeNull();
  });
});

// Re-casting the SAME vote clears it (un-vote); switching updates in place.
describe("sheet voting — toggle (un-vote)", () => {
  it("clears the vote on a repeat click and switches when the other value is chosen", async () => {
    const owner = await createUser();
    const f1 = await createFixer();
    await createFixer();
    await createFixer(); // pool 3 → threshold 2
    const sheet = await createPendingSheet(owner.id, "Toggle Subject");
    const countVotes = async () =>
      (await db.select().from(reviewVotes).where(and(eq(reviewVotes.subjectType, "sheet"), eq(reviewVotes.subjectId, sheet.id)))).length;

    const v1 = await request(app).post(`/api/sheets/${sheet.id}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    expect(v1.body.approveCount).toBe(1);
    expect(await countVotes()).toBe(1);

    const v2 = await request(app).post(`/api/sheets/${sheet.id}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    expect(v2.status).toBe(200);
    expect(v2.body.approveCount).toBe(0);
    expect(v2.body.status).toBe("pending");
    expect(await countVotes()).toBe(0);

    // Switching approve → reject updates in place.
    await request(app).post(`/api/sheets/${sheet.id}/vote`).set("x-test-user", f1.id).send({ vote: "approve" });
    const v3 = await request(app).post(`/api/sheets/${sheet.id}/vote`).set("x-test-user", f1.id).send({ vote: "reject" });
    expect(v3.body.approveCount).toBe(0);
    expect(v3.body.rejectCount).toBe(1);
    const rows = await db.select().from(reviewVotes).where(and(eq(reviewVotes.subjectType, "sheet"), eq(reviewVotes.subjectId, sheet.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].vote).toBe("reject");
  });
});
