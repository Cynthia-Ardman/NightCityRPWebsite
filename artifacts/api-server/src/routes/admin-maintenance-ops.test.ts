import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq, like } from "drizzle-orm";

// Mock the currency provider so no test ever touches the real Unbelievaboat API.
vi.mock("../lib/unbelievaboat", () => ({
  patchBalance: vi.fn(),
  getBalance: vi.fn(),
}));

import { db, users, missions, events, guidebookPages, auditLog } from "@workspace/db";
import { getBalance } from "../lib/unbelievaboat";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";

const app = buildTestApp();
const mockGetBalance = vi.mocked(getBalance);

beforeEach(() => {
  mockGetBalance.mockReset();
});

const OPS = [
  "mission-thread-backfill",
  "economy-reconcile",
  "rehost-event-images",
  "guidebook-link-repair",
] as const;

describe("admin maintenance ops — authz", () => {
  it("403s every op for a plain user", async () => {
    const user = await createUser();
    for (const op of OPS) {
      const res = await request(app)
        .post(`/api/admin/maintenance/${op}`)
        .set("x-test-user", user.id)
        .send({ dryRun: true, userId: user.id });
      expect(res.status, op).toBe(403);
    }
  });
});

describe("POST /admin/maintenance/mission-thread-backfill", () => {
  it("dry run lists posted active missions missing a thread, writes nothing", async () => {
    const admin = await createAdmin();
    const [target] = await db
      .insert(missions)
      .values({ title: "No Thread Yet", workflowState: "posted", status: "open" })
      .returning();
    // Draft mission must NOT be a target.
    await db.insert(missions).values({ title: "Draft", workflowState: "draft", status: "open" });

    const res = await request(app)
      .post("/api/admin/maintenance/mission-thread-backfill")
      .set("x-test-user", admin.id)
      .send({ dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.targets[0]).toMatchObject({ id: target.id, missing: "thread" });
    // Dry runs are audited too, marked as dryRun.
    const audits = await db
      .select()
      .from(auditLog)
      .where(like(auditLog.action, "maintenance_mission_thread_backfill"));
    expect(audits.length).toBe(1);
    expect((audits[0].afterJson as { dryRun?: boolean }).dryRun).toBe(true);
  });
});

describe("POST /admin/maintenance/economy-reconcile", () => {
  it("400s without userId and 404s for an unknown user", async () => {
    const admin = await createAdmin();
    const noUser = await request(app)
      .post("/api/admin/maintenance/economy-reconcile")
      .set("x-test-user", admin.id)
      .send({ dryRun: true });
    expect(noUser.status).toBe(400);
    const unknown = await request(app)
      .post("/api/admin/maintenance/economy-reconcile")
      .set("x-test-user", admin.id)
      .send({ dryRun: true, userId: "nobody" });
    expect(unknown.status).toBe(404);
  });

  it("dry run reports the UB delta without writing", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    await db.update(users).set({ walletBalance: 100 }).where(eq(users.id, player.id));
    mockGetBalance.mockResolvedValue({ cash: 0, bank: 250, total: 250 } as never);

    const res = await request(app)
      .post("/api/admin/maintenance/economy-reconcile")
      .set("x-test-user", admin.id)
      .send({ dryRun: true, userId: player.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dryRun: true,
      userId: player.id,
      walletBalance: 100,
      ubBalance: 250,
      delta: 150,
      wouldSeed: true,
    });
    const [fresh] = await db.select().from(users).where(eq(users.id, player.id));
    expect(fresh.walletBalance).toBe(100);
    expect(fresh.lastSyncedUbBalance).toBeNull();
  });

  it("502s the dry run when UnbelievaBoat is unreachable", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    mockGetBalance.mockResolvedValue(null as never);
    const res = await request(app)
      .post("/api/admin/maintenance/economy-reconcile")
      .set("x-test-user", admin.id)
      .send({ dryRun: true, userId: player.id });
    expect(res.status).toBe(502);
  });

  it("live run with economy disabled is a no-op but still audited", async () => {
    const admin = await createAdmin();
    const player = await createUser();
    // getEconomyMode defaults to disabled with no bot_config flag set.
    const res = await request(app)
      .post("/api/admin/maintenance/economy-reconcile")
      .set("x-test-user", admin.id)
      .send({ dryRun: false, userId: player.id });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe("disabled");
    const audits = await db
      .select()
      .from(auditLog)
      .where(like(auditLog.action, "maintenance_economy_reconcile"));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const last = audits[audits.length - 1];
    expect((last.afterJson as { dryRun?: boolean; status?: string }).dryRun).toBe(false);
    expect((last.afterJson as { status?: string }).status).toBe("disabled");
  });
});

describe("POST /admin/maintenance/rehost-event-images", () => {
  it("dry run lists only events with a raw guild-events CDN banner", async () => {
    const admin = await createAdmin();
    const now = new Date();
    const later = new Date(now.getTime() + 3600_000);
    const [target] = await db
      .insert(events)
      .values({
        title: "Expiring Banner",
        startAt: now,
        endAt: later,
        imageUrl: "https://cdn.discordapp.com/guild-events/123456/abcdef.png",
      })
      .returning();
    await db.insert(events).values({
      title: "Already Hosted",
      startAt: now,
      endAt: later,
      imageUrl: "/api/storage/objects/some-id",
    });

    const res = await request(app)
      .post("/api/admin/maintenance/rehost-event-images")
      .set("x-test-user", admin.id)
      .send({ dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.targets[0]).toMatchObject({ id: target.id, title: "Expiring Banner" });
  });
});

describe("POST /admin/maintenance/guidebook-link-repair", () => {
  it("dry run reports mapped rewrites without writing; live run rewrites + audits inline", async () => {
    const admin = await createAdmin();
    // Page A is the mapped target of Discord channel 999000.
    const [pageA] = await db
      .insert(guidebookPages)
      .values({ title: "Target Page", slug: "target-page", body: "hello", discordChannelId: "999000" })
      .returning();
    // Page B links to that channel via a markdown destination (stranded link).
    const [pageB] = await db
      .insert(guidebookPages)
      .values({
        title: "Linking Page",
        slug: "linking-page",
        body: "See [the rules](https://discord.com/channels/111/999000) for details.",
      })
      .returning();

    const dry = await request(app)
      .post("/api/admin/maintenance/guidebook-link-repair")
      .set("x-test-user", admin.id)
      .send({ dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.pagesChanged).toBe(1);
    expect(dry.body.pages[0].pageId).toBe(pageB.id);
    const [unchanged] = await db.select().from(guidebookPages).where(eq(guidebookPages.id, pageB.id));
    expect(unchanged.body).toContain("discord.com/channels");

    const live = await request(app)
      .post("/api/admin/maintenance/guidebook-link-repair")
      .set("x-test-user", admin.id)
      .send({ dryRun: false });
    expect(live.status).toBe(200);
    expect(live.body.dryRun).toBe(false);
    expect(live.body.pagesChanged).toBe(1);
    const [rewritten] = await db.select().from(guidebookPages).where(eq(guidebookPages.id, pageB.id));
    expect(rewritten.body).toContain(`](/guidebook/${pageA.id})`);
    expect(rewritten.body).not.toContain("discord.com/channels");
    // editedSinceImport untouched.
    expect(rewritten.editedSinceImport).toBe(false);

    // Both the dry run and the live run are audited; the live one is last.
    const audits = await db
      .select()
      .from(auditLog)
      .where(like(auditLog.action, "maintenance_guidebook_link_repair"))
      .orderBy(auditLog.id);
    expect(audits.length).toBe(2);
    expect(audits[0].actorId).toBe(admin.id);
    expect((audits[0].afterJson as { dryRun?: boolean }).dryRun).toBe(true);
    expect((audits[1].afterJson as { dryRun?: boolean }).dryRun).toBe(false);

    // Idempotent: a second scan finds nothing left.
    const again = await request(app)
      .post("/api/admin/maintenance/guidebook-link-repair")
      .set("x-test-user", admin.id)
      .send({ dryRun: true });
    expect(again.body.pagesChanged).toBe(0);
  });
});
