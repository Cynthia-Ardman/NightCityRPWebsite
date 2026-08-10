import { describe, it, expect, beforeEach } from "vitest";
import { db, vrchatInstanceSessions, vrchatInstanceSamples } from "@workspace/db";
import { computeVrchatInstanceDrilldown, VRCHAT_SESSION_ENDED_BELOW } from "./analytics";

const WORLD = "Trim Test World";

async function seedSession(counts: number[], startIso = "2026-07-19T01:00:00Z") {
  const start = new Date(startIso);
  const times = counts.map((_, i) => new Date(start.getTime() + i * 10 * 60_000));
  const last = times[times.length - 1];
  const [s] = await db
    .insert(vrchatInstanceSessions)
    .values({
      location: `wrld_trim:${Math.random().toString(36).slice(2)}~group(grp_t)`,
      worldId: "wrld_trim",
      worldName: WORLD,
      source: "live",
      firstSeenAt: start,
      lastSeenAt: last,
      closedAt: last,
      peakUserCount: Math.max(...counts),
      sampleCount: counts.length,
      sumUserCounts: counts.reduce((a, b) => a + b, 0),
    })
    .returning();
  await db.insert(vrchatInstanceSamples).values(
    counts.map((c, i) => ({ sessionId: s.id, at: times[i], userCount: c })),
  );
  return s;
}

beforeEach(async () => {
  await db.delete(vrchatInstanceSamples);
  await db.delete(vrchatInstanceSessions);
});

describe("computeVrchatInstanceDrilldown straggler trimming", () => {
  it("trims the trailing tail below the ended-threshold from duration, avg, median and samples", async () => {
    // 6 active samples then 6 straggler samples (1-2 people) — the straggler
    // hour must not count. 10-minute spacing: active span = 50 minutes.
    await seedSession([10, 40, 50, 44, 30, 8, 2, 1, 1, 1, 1, 1]);
    const [d] = await computeVrchatInstanceDrilldown({ world: WORLD, since: new Date(0) });
    expect(d.samples).toHaveLength(6);
    expect(d.durationMinutes).toBe(50);
    // avg/median over the 6 kept samples only
    expect(d.avgUserCount).toBe(30.3); // (10+40+50+44+30+8)/6 = 30.33
    expect(d.medianUserCount).toBe(35); // (30+40)/2
    expect(d.peakUserCount).toBe(50);
  });

  it("leaves sessions that never reached the threshold untouched", async () => {
    const counts = [2, 3, 4, 3, 2];
    await seedSession(counts);
    const [d] = await computeVrchatInstanceDrilldown({ world: WORLD, since: new Date(0) });
    expect(d.samples).toHaveLength(counts.length);
    expect(d.durationMinutes).toBe(40);
    expect(d.medianUserCount).toBe(3);
  });

  it("does not trim when the session ends while still active", async () => {
    await seedSession([10, 20, VRCHAT_SESSION_ENDED_BELOW]);
    const [d] = await computeVrchatInstanceDrilldown({ world: WORLD, since: new Date(0) });
    expect(d.samples).toHaveLength(3);
    expect(d.durationMinutes).toBe(20);
  });
});
