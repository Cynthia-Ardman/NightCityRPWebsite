import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, missions } from "@workspace/db";
import { buildTestApp } from "./app";
import { createUser } from "./testDb";

const app = buildTestApp();

async function createMission(opts: {
  fixerId: string;
  title?: string;
  workflowState?: string;
}) {
  const [m] = await db
    .insert(missions)
    .values({
      title: opts.title ?? "Test Mission",
      tier: 1,
      status: "open",
      workflowState: opts.workflowState ?? "posted",
      fixerId: opts.fixerId,
    })
    .returning();
  return m;
}

describe("GET /api/fixers/:userId/missions", () => {
  it("returns 401 unauthenticated", async () => {
    const res = await request(app).get("/api/fixers/whoever/missions");
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown user", async () => {
    const viewer = await createUser();
    const res = await request(app)
      .get("/api/fixers/nope/missions")
      .set("x-test-user", viewer.id);
    expect(res.status).toBe(404);
  });

  it("shows a player only the fixer's posted missions", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const viewer = await createUser();
    const posted = await createMission({ fixerId: fixer.id, title: "Posted job" });
    await createMission({ fixerId: fixer.id, title: "Draft job", workflowState: "draft" });
    await createMission({ fixerId: fixer.id, title: "Proposal job", workflowState: "proposal" });
    // Another fixer's mission must not appear.
    const other = await createUser({ roles: ["fixer"] });
    await createMission({ fixerId: other.id, title: "Other fixer job" });

    const res = await request(app)
      .get(`/api/fixers/${fixer.id}/missions`)
      .set("x-test-user", viewer.id);
    expect(res.status).toBe(200);
    expect(res.body.fixer.id).toBe(fixer.id);
    expect(res.body.fixer.name).toBe(fixer.username);
    const ids = res.body.missions.map((m: { id: number }) => m.id);
    expect(ids).toEqual([posted.id]);
  });

  it("shows a manager the fixer's full pipeline", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const admin = await createUser({ roles: ["admin"] });
    const posted = await createMission({ fixerId: fixer.id, title: "Posted job" });
    const draft = await createMission({ fixerId: fixer.id, title: "Draft job", workflowState: "draft" });

    const res = await request(app)
      .get(`/api/fixers/${fixer.id}/missions`)
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const ids = res.body.missions.map((m: { id: number }) => m.id).sort();
    expect(ids).toEqual([posted.id, draft.id].sort());
  });
});
