import { describe, it, expect } from "vitest";
import {
  CYBERWARE_MAX_STREAK,
  deriveCyberwareBand,
  householdMultiplier,
  weeksSinceLastCheckup,
  projectedWeeklyMeds,
} from "./jobs";

describe("deriveCyberwareBand", () => {
  it("maps chrome counts to the right risk band and weekly cap", () => {
    expect(deriveCyberwareBand(0)).toEqual({ level: "none", cap: 0 });
    expect(deriveCyberwareBand(6)).toEqual({ level: "none", cap: 0 });
    expect(deriveCyberwareBand(7)).toEqual({ level: "medium", cap: 2000 });
    expect(deriveCyberwareBand(9)).toEqual({ level: "medium", cap: 2000 });
    expect(deriveCyberwareBand(10)).toEqual({ level: "high", cap: 5000 });
    expect(deriveCyberwareBand(12)).toEqual({ level: "high", cap: 5000 });
    expect(deriveCyberwareBand(13)).toEqual({ level: "extreme", cap: 10000 });
    expect(deriveCyberwareBand(50)).toEqual({ level: "extreme", cap: 10000 });
  });

  it("clamps negatives and floors fractional counts", () => {
    expect(deriveCyberwareBand(-5)).toEqual({ level: "none", cap: 0 });
    expect(deriveCyberwareBand(7.9)).toEqual({ level: "medium", cap: 2000 });
  });
});

describe("householdMultiplier", () => {
  it("is 1x for a single (or zero) billable character", () => {
    expect(householdMultiplier(0)).toBe(1);
    expect(householdMultiplier(1)).toBe(1);
  });

  it("adds 25% per extra billable character", () => {
    expect(householdMultiplier(2)).toBe(1.25);
    expect(householdMultiplier(3)).toBe(1.5);
    expect(householdMultiplier(4)).toBe(1.75);
  });
});

describe("weeksSinceLastCheckup", () => {
  const now = new Date("2026-05-29T00:00:00Z");

  it("treats 'never had a checkup' as the maximum streak", () => {
    expect(weeksSinceLastCheckup(null, now)).toBe(CYBERWARE_MAX_STREAK);
    expect(weeksSinceLastCheckup(undefined, now)).toBe(CYBERWARE_MAX_STREAK);
  });

  it("returns 1 for a checkup that just happened (or is in the future)", () => {
    expect(weeksSinceLastCheckup(now, now)).toBe(1);
    const future = new Date(now.getTime() + 86400000);
    expect(weeksSinceLastCheckup(future, now)).toBe(1);
  });

  it("counts whole weeks elapsed, 1-indexed", () => {
    const oneWeekAgo = new Date(now.getTime() - 7 * 86400000);
    expect(weeksSinceLastCheckup(oneWeekAgo, now)).toBe(2);
    const threeWeeksAgo = new Date(now.getTime() - 21 * 86400000);
    expect(weeksSinceLastCheckup(threeWeeksAgo, now)).toBe(4);
  });

  it("caps the streak at CYBERWARE_MAX_STREAK", () => {
    const longAgo = new Date(now.getTime() - 100 * 7 * 86400000);
    expect(weeksSinceLastCheckup(longAgo, now)).toBe(CYBERWARE_MAX_STREAK);
  });
});

describe("projectedWeeklyMeds", () => {
  it("charges nothing for characters below the meds threshold", () => {
    const r = projectedWeeklyMeds({ chromeCount: 5, household: 1, weeksUnpaid: 1 });
    expect(r.charge).toBe(0);
    expect(r.level).toBe("none");
  });

  it("computes the base weekly charge as floor(cap/128) at week 1", () => {
    // medium cap 2000 -> 2000/128 = 15.625 -> floor 15
    const r = projectedWeeklyMeds({ chromeCount: 7, household: 1, weeksUnpaid: 1 });
    expect(r.cap).toBe(2000);
    expect(r.baseCharge).toBe(15);
    expect(r.charge).toBe(15);
    expect(r.multiplier).toBe(1);
  });

  it("doubles the charge per skipped week but never exceeds the band cap", () => {
    // week 8: 15.625 * 2^7 = 2000 -> hits the cap exactly
    const atCap = projectedWeeklyMeds({ chromeCount: 7, household: 1, weeksUnpaid: 8 });
    expect(atCap.baseCharge).toBe(2000);
    // beyond week 8 it stays clamped at the cap
    const beyond = projectedWeeklyMeds({ chromeCount: 7, household: 1, weeksUnpaid: 12 });
    expect(beyond.baseCharge).toBe(2000);
  });

  it("applies the household multiplier AFTER the cap clamp", () => {
    // base 15 at week 1, household of 2 -> floor(15 * 1.25) = 18
    const r = projectedWeeklyMeds({ chromeCount: 7, household: 2, weeksUnpaid: 1 });
    expect(r.multiplier).toBe(1.25);
    expect(r.charge).toBe(18);
    // capped base can be pushed past the band cap by the multiplier (intended)
    const capped = projectedWeeklyMeds({ chromeCount: 7, household: 3, weeksUnpaid: 8 });
    expect(capped.baseCharge).toBe(2000);
    expect(capped.charge).toBe(3000); // 2000 * 1.5
  });

  it("clamps weeksUnpaid into the valid 1..MAX range", () => {
    const low = projectedWeeklyMeds({ chromeCount: 10, household: 1, weeksUnpaid: 0 });
    expect(low.weeksUnpaid).toBe(1);
    const high = projectedWeeklyMeds({ chromeCount: 10, household: 1, weeksUnpaid: 999 });
    expect(high.weeksUnpaid).toBe(CYBERWARE_MAX_STREAK);
  });
});
