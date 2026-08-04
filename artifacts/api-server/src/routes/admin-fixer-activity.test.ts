import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, missions, reviewVotes, auditLog } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

const app = buildTestApp();

describe("GET /admin/fixer-activity", () => {
  it("forbids non-admin callers (including fixers)", async () => {
    const fixer = await createUser({ roles: ["fixer"] });
    const res = await request(app).get("/api/admin/fixer-activity").set("x-test-user", fixer.id);
    expect(res.status).toBe(403);
  });

  it("lists fixers with per-source counts and last-action timestamps", async () => {
    const admin = await createAdmin();
    const activeFixer = await createUser({ roles: ["fixer"], username: "active_fixer" });
    const idleFixer = await createUser({ roles: ["fixer"], username: "idle_fixer" });
    const trial = await createUser({ roles: ["trial-fixer"], username: "trial_fixer" });
    const csApprover = await createUser({ roles: ["cs approver"], username: "cs_only" });
    const player = await createUser({ roles: [] });

    // Recent activity for the active fixer. The review vote must NOT count —
    // review work is CS-approver work, and this user is fixer-only.
    await db.insert(missions).values({ title: "Recent op", fixerId: activeFixer.id });
    await db.insert(reviewVotes).values({
      subjectType: "request", subjectId: 999_901, voterId: activeFixer.id, vote: "approve",
    });
    // CS approver: a counted vote AND a mission row that must NOT count
    // (mission work is fixer work, and this user is CS-only).
    await db.insert(reviewVotes).values({
      subjectType: "request", subjectId: 999_902, voterId: csApprover.id, vote: "approve",
    });
    await db.insert(missions).values({ title: "Stray op", fixerId: csApprover.id });
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
    expect(active.isFixer).toBe(true);
    expect(active.isCsApprover).toBe(false);
    expect(active.missionsCreated).toBe(1);
    // Fixer-only user: review work belongs to CS approvers, so the stray
    // vote is masked out of both the count and the weekly buckets.
    expect(active.reviewVotes).toBe(0);
    expect(active.auditActions).toBe(2);

    // CS-only user is rostered, credited for the vote, and NOT credited
    // for the stray mission row (fixer work).
    const cs = byId.get(csApprover.id) as Record<string, unknown>;
    expect(cs).toBeTruthy();
    expect(cs.isFixer).toBe(false);
    expect(cs.isCsApprover).toBe(true);
    expect(cs.reviewVotes).toBe(1);
    expect(cs.missionsCreated).toBe(0);
    expect(cs.lastFixerActionAt).toBeTruthy();
    expect(active.lastFixerActionAt).toBeTruthy();
    // Weekly buckets: oldest-first array whose total matches the windowed
    // audit count, with the two actions split across two different weeks.
    const weekly = active.weekly as number[];
    expect(Array.isArray(weekly)).toBe(true);
    expect(weekly.length).toBe(res.body.weeks);
    expect(weekly.reduce((a, b) => a + b, 0)).toBe(2);
    expect(weekly[weekly.length - 1]).toBe(1);
    expect(weekly[weekly.length - 2]).toBe(1);

    // Per-source weekly buckets power the chart's single-fixer view.
    const bySource = active.weeklyBySource as Record<string, number[]>;
    expect(bySource.auditActions).toEqual(weekly);
    expect(bySource.missionsCreated.reduce((a, b) => a + b, 0)).toBe(1);
    expect(bySource.reviewVotes.reduce((a, b) => a + b, 0)).toBe(0);
    expect(bySource.missionsCompleted.reduce((a, b) => a + b, 0)).toBe(0);
    expect(bySource.missionsCreated.length).toBe(res.body.weeks);

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
