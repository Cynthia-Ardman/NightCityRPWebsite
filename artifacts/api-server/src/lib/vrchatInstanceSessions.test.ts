import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, vrchatInstanceSessions, vrchatInstanceSamples } from "@workspace/db";
import { recordInstanceSessions } from "./vrchatInstances";

const LOC_A = "wrld_a:11111~group(grp_x)~groupAccessType(members)~region(use)";
const LOC_B = "wrld_b:22222~group(grp_x)~groupAccessType(public)~region(us)";

function inst(location: string, userCount: number, overrides: Partial<{ worldId: string; worldName: string; capacity: number | null }> = {}) {
  return {
    location,
    worldId: overrides.worldId ?? location.split(":")[0],
    worldName: overrides.worldName ?? "Test World",
    accessType: "group_members" as const,
    region: "use",
    userCount,
    capacity: overrides.capacity ?? 40,
  };
}

beforeEach(async () => {
  await db.delete(vrchatInstanceSamples);
  await db.delete(vrchatInstanceSessions);
});

describe("recordInstanceSessions", () => {
  it("creates an open session with an initial sample on first sight", async () => {
    const t0 = new Date("2026-07-19T01:00:00Z");
    await recordInstanceSessions([inst(LOC_A, 5)], t0);

    const rows = await db.select().from(vrchatInstanceSessions);
    expect(rows).toHaveLength(1);
    const s = rows[0];
    expect(s.location).toBe(LOC_A);
    expect(s.closedAt).toBeNull();
    expect(s.peakUserCount).toBe(5);
    expect(s.sampleCount).toBe(1);
    expect(s.sumUserCounts).toBe(5);
    expect(s.firstSeenAt.toISOString()).toBe(t0.toISOString());

    const samples = await db.select().from(vrchatInstanceSamples).where(eq(vrchatInstanceSamples.sessionId, s.id));
    expect(samples).toHaveLength(1);
    expect(samples[0].userCount).toBe(5);
  });

  it("updates the SAME open session across polls: peak, average sums, lastSeenAt", async () => {
    const t0 = new Date("2026-07-19T01:00:00Z");
    const t1 = new Date("2026-07-19T01:02:00Z");
    const t2 = new Date("2026-07-19T01:04:00Z");
    await recordInstanceSessions([inst(LOC_A, 3)], t0);
    await recordInstanceSessions([inst(LOC_A, 9)], t1);
    await recordInstanceSessions([inst(LOC_A, 6)], t2);

    const rows = await db.select().from(vrchatInstanceSessions);
    expect(rows).toHaveLength(1);
    const s = rows[0];
    expect(s.peakUserCount).toBe(9); // GREATEST keeps the max, not the latest
    expect(s.sampleCount).toBe(3);
    expect(s.sumUserCounts).toBe(18);
    expect(s.firstSeenAt.toISOString()).toBe(t0.toISOString());
    expect(s.lastSeenAt.toISOString()).toBe(t2.toISOString());
    expect(s.closedAt).toBeNull();

    const samples = await db.select().from(vrchatInstanceSamples).where(eq(vrchatInstanceSamples.sessionId, s.id));
    expect(samples.map((x) => x.userCount).sort((a, b) => a - b)).toEqual([3, 6, 9]);
  });

  it("closes vanished sessions with closedAt = lastSeenAt, and an empty poll closes everything", async () => {
    const t0 = new Date("2026-07-19T01:00:00Z");
    const t1 = new Date("2026-07-19T01:02:00Z");
    const t2 = new Date("2026-07-19T01:04:00Z");
    await recordInstanceSessions([inst(LOC_A, 4), inst(LOC_B, 2)], t0);
    // A survives, B vanishes.
    await recordInstanceSessions([inst(LOC_A, 4)], t1);
    let rows = await db.select().from(vrchatInstanceSessions);
    const b1 = rows.find((r) => r.location === LOC_B)!;
    expect(b1.closedAt?.toISOString()).toBe(t0.toISOString()); // last poll that saw it, not t1
    expect(rows.find((r) => r.location === LOC_A)!.closedAt).toBeNull();

    // Empty successful poll closes A too.
    await recordInstanceSessions([], t2);
    rows = await db.select().from(vrchatInstanceSessions);
    expect(rows.find((r) => r.location === LOC_A)!.closedAt?.toISOString()).toBe(t1.toISOString());
  });

  it("a location reopening after close starts a NEW session row", async () => {
    const t0 = new Date("2026-07-19T01:00:00Z");
    const t1 = new Date("2026-07-19T01:02:00Z");
    const t2 = new Date("2026-07-19T02:00:00Z");
    await recordInstanceSessions([inst(LOC_A, 4)], t0);
    await recordInstanceSessions([], t1); // closes it
    await recordInstanceSessions([inst(LOC_A, 7)], t2); // same location string reused

    const rows = await db
      .select()
      .from(vrchatInstanceSessions)
      .where(eq(vrchatInstanceSessions.location, LOC_A));
    expect(rows).toHaveLength(2);
    const open = rows.find((r) => r.closedAt === null)!;
    expect(open.firstSeenAt.toISOString()).toBe(t2.toISOString());
    expect(open.peakUserCount).toBe(7);
  });

  it("dedupes duplicate locations within a single poll payload", async () => {
    const t0 = new Date("2026-07-19T01:00:00Z");
    await recordInstanceSessions([inst(LOC_A, 4), inst(LOC_A, 4)], t0);
    const rows = await db.select().from(vrchatInstanceSessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].sampleCount).toBe(1);
  });
});
