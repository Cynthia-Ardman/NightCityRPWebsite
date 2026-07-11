import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";

import { db, characterSheets, characters } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();

async function createPendingSheet(ownerId: string, name = "Test Subject") {
  const [s] = await db
    .insert(characterSheets)
    .values({ ownerId, name, status: "pending", data: { sheetType: "PC" } })
    .returning();
  return s;
}

describe("POST /api/sheets/:id/vote self-review guard", () => {
  it("403s when the approver is the sheet owner, leaving the sheet pending", async () => {
    const owner = await createUser({ roles: ["cs approver"] });
    const sheet = await createPendingSheet(owner.id);

    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", owner.id)
      .send({ vote: "approve" });

    expect(res.status).toBe(403);

    const [after] = await db
      .select()
      .from(characterSheets)
      .where(eq(characterSheets.id, sheet.id));
    expect(after.status).toBe("pending");
    expect(after.characterId).toBeNull();
  });

  it("lets a different approver approve, then materializes the character on close", async () => {
    const owner = await createUser();
    const approver = await createUser({ roles: ["cs approver"] });
    const sheet = await createPendingSheet(owner.id, "Approve Me");

    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", approver.id)
      .send({ vote: "approve" });

    expect(res.status).toBe(200);

    const [after] = await db
      .select()
      .from(characterSheets)
      .where(eq(characterSheets.id, sheet.id));
    expect(after.status).toBe("approved");
    // Staged lifecycle: approval defers materialization until close.
    expect(after.characterId).toBeNull();

    const close = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", approver.id)
      .send({});
    expect(close.status).toBe(200);

    const [closed] = await db
      .select()
      .from(characterSheets)
      .where(eq(characterSheets.id, sheet.id));
    expect(closed.status).toBe("closed");
    expect(closed.characterId).not.toBeNull();

    const [char] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, closed.characterId!));
    expect(char).toBeTruthy();
    expect(char.ownerId).toBe(owner.id);
  });

  it("a newly materialized character inherits the household checkup date instead of resetting the meds streak", async () => {
    const owner = await createUser();
    const approver = await createUser({ roles: ["cs approver"] });

    // Existing billable PC whose last checkup was 3 weeks ago — the household
    // meds streak is therefore at week 3.
    const existing = await createCharacter({ ownerId: owner.id });
    const threeWeeksAgo = new Date(Date.now() - 3 * 7 * 86400000);
    await db
      .update(characters)
      .set({ lastCheckupAt: threeWeeksAgo })
      .where(eq(characters.id, existing.id));

    const sheet = await createPendingSheet(owner.id, "Second Character");
    const vote = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", approver.id)
      .send({ vote: "approve" });
    expect(vote.status).toBe(200);
    const close = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", approver.id)
      .send({});
    expect(close.status).toBe(200);

    const [closed] = await db
      .select()
      .from(characterSheets)
      .where(eq(characterSheets.id, sheet.id));
    expect(closed.characterId).not.toBeNull();
    const [newChar] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, closed.characterId!));
    // The new character carries the household's effective checkup date, so
    // max(lastCheckupAt ?? createdAt) across the household is unchanged.
    expect(newChar.lastCheckupAt?.getTime()).toBe(threeWeeksAgo.getTime());
  });

  it("approving a linked character with no prior checkup inherits the household date, excluding itself", async () => {
    const owner = await createUser();
    const approver = await createUser({ roles: ["cs approver"] });

    // Existing billable PC anchors the household streak at ~2 weeks.
    const anchor = await createCharacter({ ownerId: owner.id });
    const twoWeeksAgo = new Date(Date.now() - 2 * 7 * 86400000);
    await db
      .update(characters)
      .set({ lastCheckupAt: twoWeeksAgo })
      .where(eq(characters.id, anchor.id));

    // Pre-existing (player-created, unapproved) character linked to the sheet.
    const linked = await createCharacter({ ownerId: owner.id, approved: false });
    const [sheet] = await db
      .insert(characterSheets)
      .values({
        ownerId: owner.id,
        name: "Linked Char",
        status: "pending",
        characterId: linked.id,
        data: { sheetType: "PC" },
      })
      .returning();

    const vote = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", approver.id)
      .send({ vote: "approve" });
    expect(vote.status).toBe(200);
    const close = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", approver.id)
      .send({});
    expect(close.status).toBe(200);

    const [after] = await db.select().from(characters).where(eq(characters.id, linked.id));
    expect(after.approved).toBe(true);
    expect(after.lastCheckupAt?.getTime()).toBe(twoWeeksAgo.getTime());
  });

  it("a first character (no existing billable PCs) materializes with no inherited checkup date", async () => {
    const owner = await createUser();
    const approver = await createUser({ roles: ["cs approver"] });
    const sheet = await createPendingSheet(owner.id, "First Character");

    const vote = await request(app)
      .post(`/api/sheets/${sheet.id}/vote`)
      .set("x-test-user", approver.id)
      .send({ vote: "approve" });
    expect(vote.status).toBe(200);
    const close = await request(app)
      .post(`/api/review/sheet/${sheet.id}/close`)
      .set("x-test-user", approver.id)
      .send({});
    expect(close.status).toBe(200);

    const [closed] = await db
      .select()
      .from(characterSheets)
      .where(eq(characterSheets.id, sheet.id));
    const [newChar] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, closed.characterId!));
    // Fresh start: createdAt acts as the implicit initial checkup.
    expect(newChar.lastCheckupAt).toBeNull();
  });
});
