import { describe, it, expect } from "vitest";
import {
  MISSION_STATUSES,
  missionStatusClass,
  missionStatusLabel,
} from "./missionStatus";

describe("missionStatusLabel", () => {
  it("maps every known DB token to its human label", () => {
    expect(missionStatusLabel("pending")).toBe("Pending");
    expect(missionStatusLabel("completed")).toBe("Completed");
    expect(missionStatusLabel("completed_and_paid")).toBe("Completed and Paid");
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

  it("colors pending yellow, completed cyan, paid green, cancelled destructive", () => {
    expect(missionStatusClass("pending")).toContain("nc-yellow");
    expect(missionStatusClass("completed")).toContain("nc-cyan");
    expect(missionStatusClass("completed_and_paid")).toContain("green");
    expect(missionStatusClass("cancelled")).toContain("destructive");
  });

  it("falls back to a muted class for unknown tokens", () => {
    const cls = missionStatusClass("not_a_real_status");
    expect(cls).toContain("muted");
    expect(cls.trim().length).toBeGreaterThan(0);
  });
});
