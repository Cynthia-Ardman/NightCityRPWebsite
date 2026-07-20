import { describe, expect, it } from "vitest";
import { formatDate } from "./format";

describe("formatDate", () => {
  it("returns em dash for null/undefined/empty", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
  });

  it("returns em dash for invalid date strings", () => {
    expect(formatDate("not a date")).toBe("—");
  });

  it("formats ISO strings", () => {
    const out = formatDate("2026-01-01T12:00:00Z");
    expect(out).toContain("2026");
    expect(out).not.toBe("—");
  });

  it("formats Date objects", () => {
    const out = formatDate(new Date(2026, 5, 15));
    expect(out).toContain("2026");
  });

  it("treats numeric timestamps as valid, including 0", () => {
    expect(formatDate(0)).toContain("1970");
    const out = formatDate(Date.UTC(2026, 0, 2));
    expect(out).toContain("2026");
  });
});
