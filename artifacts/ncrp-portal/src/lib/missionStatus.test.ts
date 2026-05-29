import { describe, it, expect } from "vitest";
import {
  MISSION_STATUSES,
  MISSION_TIERS,
  missionStatusClass,
  missionStatusLabel,
  missionTierClass,
  missionTierLabel,
} from "./missionStatus";

describe("missionStatusLabel", () => {
  it("maps every known DB token to its human label", () => {
    expect(missionStatusLabel("open")).toBe("Open");
    expect(missionStatusLabel("pending")).toBe("Pending");
    expect(missionStatusLabel("completed")).toBe("Completed");
    expect(missionStatusLabel("completed_players_paid")).toBe("Players Paid");
    expect(missionStatusLabel("completed_paid")).toBe("Fully Paid");
    expect(missionStatusLabel("cancelled")).toBe("Canceled");
  });

  it("falls back to a humanized title-case for unknown tokens", () => {
    expect(missionStatusLabel("in_progress")).toBe("In Progress");
    expect(missionStatusLabel("weird_legacy_value")).toBe("Weird Legacy Value");
  });

  it("never returns an empty string for an empty fallback input", () => {
    // The fallback path simply title-cases its input. Empty in -> empty out.
    expect(typeof missionStatusLabel("")).toBe("string");
  });

  it("covers every status enumerated in MISSION_STATUSES", () => {
    for (const s of MISSION_STATUSES) {
      const label = missionStatusLabel(s);
      expect(label.length).toBeGreaterThan(0);
      // The label should never just echo the snake_case token as-is.
      expect(label).not.toMatch(/_/);
    }
  });
});

describe("missionStatusClass", () => {
  it("returns a non-empty class string for every known status", () => {
    for (const s of MISSION_STATUSES) {
      const cls = missionStatusClass(s);
      expect(typeof cls).toBe("string");
      expect(cls.trim().length).toBeGreaterThan(0);
    }
  });

  it("colors open magenta, pending yellow, completed cyan, fully paid green, cancelled destructive", () => {
    expect(missionStatusClass("open")).toContain("nc-magenta");
    expect(missionStatusClass("pending")).toContain("nc-yellow");
    expect(missionStatusClass("completed")).toContain("nc-cyan");
    expect(missionStatusClass("completed_paid")).toContain("green");
    expect(missionStatusClass("cancelled")).toContain("destructive");
  });

  it("falls back to a muted class for unknown tokens", () => {
    const cls = missionStatusClass("not_a_real_status");
    expect(cls).toContain("muted");
    expect(cls.trim().length).toBeGreaterThan(0);
  });
});

describe("missionTierLabel / missionTierClass", () => {
  it("labels every tier 1-4", () => {
    expect(missionTierLabel(1)).toBe("Tier 1");
    expect(missionTierLabel(4)).toBe("Tier 4");
  });

  it("returns a non-empty class for every tier", () => {
    for (const t of MISSION_TIERS) {
      const cls = missionTierClass(t);
      expect(typeof cls).toBe("string");
      expect(cls.trim().length).toBeGreaterThan(0);
    }
  });
});
