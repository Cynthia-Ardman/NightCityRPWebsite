import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, missions, reviewVotes, auditLog } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

const app = buildTestApp();

describe("GET /admin/fixer-activity", () => {
  it("forbids non-admin callers (including fixers)", async () => {
    const fixer = await createUser({ roles: ["FIXER"] });
    const res = await request(app).get("/api/admin/fixer-activity").set("x-test-user", fixer.id);
    expect(res.status).toBe(403);
  });

  it("lists fixers with per-source counts and last-action timestamps", async () => {
    const admin = await createAdmin();
    const activeFixer = await createUser({ roles: ["FIXER"], username: "active_fixer" });
    const idleFixer = await createUser({ roles: ["FIXER"], username: "idle_fixer" });
    const trial = await createUser({ roles: ["TRIAL_FIXER"], username: "trial_fixer" });
    const player = await createUser({ roles: [] });

    // Recent activity for the active fixer.
    await db.insert(missions).values({ title: "Recent op", fixerId: activeFixer.id });
    await db.insert(reviewVotes).values({
      subjectType: "request", subjectId: 999_901, voterId: activeFixer.id, vote: "approve",
    });
    await db.insert(auditLog).values({
      category: "mission", action: "mission.create", actorId: activeFixer.id,
    });
    // A second audit action ~8 days ago lands in a DIFFERENT weekly bucket.
    await db.insert(auditLog).values({
      category: "mission", action: "mission.update", actorId: activeFixer.id,
      createdAt: new Date(Date.now() - 8 * 86_400_000),
    });
    // Old activity (outside a 30-day window) for the idle fixer.
    const old = new Date(Date.now() - 200 * 86_400_000);
    await db.insert(missions).values({ title: "Ancient op", fixerId: idleFixer.id, createdAt: old });

    const res = await request(app)
      .get("/api/admin/fixer-activity?days=30")
      .set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);

    const byId = new Map(res.body.fixers.map((f: { userId: string }) => [f.userId, f]));
    expect(byId.has(activeFixer.id)).toBe(true);
    expect(byId.has(idleFixer.id)).toBe(true);
    expect(byId.has(trial.id)).toBe(true);
    expect(byId.has(player.id)).toBe(false);

    const active = byId.get(activeFixer.id) as Record<string, unknown>;
    expect(active.missionsCreated).toBe(1);
    expect(active.reviewVotes).toBe(1);
    expect(active.auditActions).toBe(2);
    expect(active.lastFixerActionAt).toBeTruthy();
    // Weekly buckets: oldest-first array whose total matches the windowed
    // audit count, with the two actions split across two different weeks.
    const weekly = active.weekly as number[];
    expect(Array.isArray(weekly)).toBe(true);
    expect(weekly.length).toBe(res.body.weeks);
    expect(weekly.reduce((a, b) => a + b, 0)).toBe(2);
    expect(weekly[weekly.length - 1]).toBe(1);
    expect(weekly[weekly.length - 2]).toBe(1);

    // Idle fixer: 0 in-window counts but the ALL-TIME last action is preserved.
    const idle = byId.get(idleFixer.id) as Record<string, unknown>;
    expect(idle.missionsCreated).toBe(0);
    expect(idle.lastFixerActionAt).toBeTruthy();
    expect(new Date(String(idle.lastFixerActionAt)).getTime()).toBeLessThan(Date.now() - 100 * 86_400_000);

    const trialRow = byId.get(trial.id) as Record<string, unknown>;
    expect(trialRow.isTrialFixer).toBe(true);
    expect(trialRow.lastFixerActionAt).toBeNull();

    // Least-recently-active sorted first: never-active trial or old idle before active.
    const order = res.body.fixers.map((f: { userId: string }) => f.userId);
    expect(order.indexOf(activeFixer.id)).toBeGreaterThan(order.indexOf(idleFixer.id));
  });
});
