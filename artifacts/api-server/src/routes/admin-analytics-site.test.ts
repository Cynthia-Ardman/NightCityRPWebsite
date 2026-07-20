import { describe, it, expect } from "vitest";
import request from "supertest";
import { db, siteActivityDaily, characters } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createAdmin } from "../test/testDb";
import { recordHit, flushSiteActivity, recordLogin } from "../lib/siteActivity";

const app = buildTestApp();

describe("site activity tracking + analytics", () => {
  it("batches hits, records logins, and surfaces the site section in analytics", async () => {
    const admin = await createAdmin();
    const player = await createUser({ roles: [] });

    // Hits accumulate in memory and only reach the DB on flush.
    recordHit(player.id);
    recordHit(player.id);
    recordHit(admin.id);
    await flushSiteActivity();
    await recordLogin(player.id);

    // Flushing again on the same day increments the same rows.
    recordHit(player.id);
    await flushSiteActivity();

    const rows = await db.select().from(siteActivityDaily);
    const playerRow = rows.find((r) => r.userId === player.id);
    expect(playerRow?.hits).toBe(3);
    expect(playerRow?.logins).toBe(1);
    expect(rows.find((r) => r.userId === admin.id)?.hits).toBe(1);

    // A character created this week shows up in the site series.
    await db.insert(characters).values({ name: "Analytics PC", kind: "pc", ownerId: player.id });

    const res = await request(app).get("/api/admin/analytics?range=4w").set("x-test-user", admin.id);
    expect(res.status).toBe(200);
    const site = res.body.site;
    expect(site).toBeTruthy();
    expect(site.totalActiveUsers).toBeGreaterThanOrEqual(2);
    expect(site.totalLogins).toBeGreaterThanOrEqual(1);
    expect(site.totalCharactersCreated).toBeGreaterThanOrEqual(1);
    expect(site.trackingSince).toBeTruthy();
    expect(Array.isArray(site.weekly)).toBe(true);
    const latest = site.weekly[site.weekly.length - 1];
    expect(latest.pageHits).toBeGreaterThanOrEqual(4);
    expect(latest.activeUsers).toBeGreaterThanOrEqual(2);
  });
});
