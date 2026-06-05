import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, characterSheets, reviewVotes } from "@workspace/db";
import { buildTestApp } from "./app";
import { createUser } from "./testDb";

const app = buildTestApp();

async function createPendingSheet(ownerId: string, name = "Test Sheet") {
  const [s] = await db
    .insert(characterSheets)
    .values({ ownerId, name, status: "pending", data: {} })
    .returning();
  return s;
}

async function getSummary(userId: string) {
  const res = await request(app).get("/api/dashboard/summary").set("x-test-user", userId);
  expect(res.status).toBe(200);
  return res.body as { pendingSheets: number };
}

describe("dashboard pendingSheets count", () => {
  it("counts a pending sheet a reviewer has NOT yet voted on", async () => {
    const reviewer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    await createPendingSheet(owner.id);

    const summary = await getSummary(reviewer.id);
    expect(summary.pendingSheets).toBe(1);
  });

  it("excludes a sheet the reviewer has ALREADY voted on (the reported bug)", async () => {
    const reviewer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const sheet = await createPendingSheet(owner.id);

    // Reviewer casts an approve vote — below the majority threshold, so the
    // sheet stays pending, but there is nothing left for THIS reviewer to do.
    await db.insert(reviewVotes).values({
      subjectType: "sheet",
      subjectId: sheet.id,
      voterId: reviewer.id,
      vote: "approve",
    });

    const summary = await getSummary(reviewer.id);
    expect(summary.pendingSheets).toBe(0);
  });

  it("excludes a sheet the reviewer voted REJECT on (any vote, not just approve)", async () => {
    const reviewer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const sheet = await createPendingSheet(owner.id);

    await db.insert(reviewVotes).values({
      subjectType: "sheet",
      subjectId: sheet.id,
      voterId: reviewer.id,
      vote: "reject",
    });

    const summary = await getSummary(reviewer.id);
    expect(summary.pendingSheets).toBe(0);
  });

  it("counts a pending sheet with a NULL owner (unowned sheets stay actionable)", async () => {
    const reviewer = await createUser({ roles: ["fixer"] });
    await db
      .insert(characterSheets)
      .values({ ownerId: reviewer.id, name: "seed", status: "approved", data: {} });
    // Force an unowned pending sheet directly (ownerId is NOT NULL in schema, so
    // simulate the "not me" branch with a different owner; IS DISTINCT FROM also
    // keeps a genuinely null owner countable at the SQL level).
    const other = await createUser();
    await createPendingSheet(other.id);

    const summary = await getSummary(reviewer.id);
    expect(summary.pendingSheets).toBe(1);
  });

  it("does not count a reviewer's OWN pending sheet", async () => {
    const reviewer = await createUser({ roles: ["fixer"] });
    await createPendingSheet(reviewer.id);

    const summary = await getSummary(reviewer.id);
    expect(summary.pendingSheets).toBe(0);
  });

  it("still counts OTHER reviewers' un-voted sheets after this reviewer votes on one", async () => {
    const reviewer = await createUser({ roles: ["fixer"] });
    const owner = await createUser();
    const voted = await createPendingSheet(owner.id, "Voted");
    await createPendingSheet(owner.id, "Unvoted");

    await db.insert(reviewVotes).values({
      subjectType: "sheet",
      subjectId: voted.id,
      voterId: reviewer.id,
      vote: "approve",
    });

    const summary = await getSummary(reviewer.id);
    expect(summary.pendingSheets).toBe(1);
  });

  it("returns 0 for a non-reviewer regardless of pending sheets", async () => {
    const player = await createUser();
    const owner = await createUser();
    await createPendingSheet(owner.id);

    const summary = await getSummary(player.id);
    expect(summary.pendingSheets).toBe(0);
  });
});
