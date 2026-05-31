import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";

import { db, characterSheets, characters } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser } from "../test/testDb";

const app = buildTestApp();

async function createPendingSheet(ownerId: string, name = "Test Subject") {
  const [s] = await db
    .insert(characterSheets)
    .values({ ownerId, name, status: "pending", data: { sheetType: "PC" } })
    .returning();
  return s;
}

describe("POST /api/sheets/:id/decision self-review guard", () => {
  it("403s when the approver is the sheet owner, leaving the sheet pending", async () => {
    const owner = await createUser({ roles: ["cs approver"] });
    const sheet = await createPendingSheet(owner.id);

    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/decision`)
      .set("x-test-user", owner.id)
      .send({ decision: "approved" });

    expect(res.status).toBe(403);

    const [after] = await db
      .select()
      .from(characterSheets)
      .where(eq(characterSheets.id, sheet.id));
    expect(after.status).toBe("pending");
    expect(after.characterId).toBeNull();
  });

  it("lets a different approver approve and materialize the character", async () => {
    const owner = await createUser();
    const approver = await createUser({ roles: ["cs approver"] });
    const sheet = await createPendingSheet(owner.id, "Approve Me");

    const res = await request(app)
      .post(`/api/sheets/${sheet.id}/decision`)
      .set("x-test-user", approver.id)
      .send({ decision: "approved" });

    expect(res.status).toBe(200);

    const [after] = await db
      .select()
      .from(characterSheets)
      .where(eq(characterSheets.id, sheet.id));
    expect(after.status).toBe("approved");
    expect(after.characterId).not.toBeNull();

    const [char] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, after.characterId!));
    expect(char).toBeTruthy();
    expect(char.ownerId).toBe(owner.id);
  });
});
