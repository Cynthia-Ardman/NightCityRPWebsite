import { describe, it, expect } from "vitest";
import {
  categoryInfo,
  powerInfo,
  restrictionInfo,
  powerColor,
  GUN_CATEGORY_INFO,
  GUN_POWER_INFO,
  GUN_POWER_COLORS,
} from "./gunMechanics";

describe("gunMechanics resolvers", () => {
  it("resolves canonical and aliased category values to the same blurb", () => {
    expect(categoryInfo("Power")).toBe(GUN_CATEGORY_INFO.Power);
    expect(categoryInfo("power")).toBe(GUN_CATEGORY_INFO.Power);
    expect(categoryInfo("Tech")).toBe(GUN_CATEGORY_INFO.Tech);
    expect(categoryInfo("Smart")).toBe(GUN_CATEGORY_INFO.Smart);
  });

  it("resolves power levels through aliases", () => {
    expect(powerInfo("L")).toBe(GUN_POWER_INFO.L);
    expect(powerInfo("low")).toBe(GUN_POWER_INFO.L);
    expect(powerInfo("medium")).toBe(GUN_POWER_INFO.M);
    expect(powerInfo("high")).toBe(GUN_POWER_INFO.H);
  });

  it("resolves restriction tiers", () => {
    expect(restrictionInfo("Basic")?.label).toBe("Basic");
    expect(restrictionInfo("Controlled")?.label).toBe("Controlled");
    expect(restrictionInfo("Restricted")?.label).toBe("Restricted");
  });

  it("degrades gracefully for off-list / empty values", () => {
    expect(categoryInfo("Plasma")).toBeNull();
    expect(categoryInfo(null)).toBeNull();
    expect(categoryInfo(undefined)).toBeNull();
    expect(powerInfo("Ultra")).toBeNull();
    expect(powerInfo(null)).toBeNull();
    expect(restrictionInfo("Forbidden")).toBeNull();
  });

  it("pins the in-game power-tier hex codes to the reference values", () => {
    expect(GUN_POWER_COLORS.power.L).toBe("#FFFFFF");
    expect(GUN_POWER_COLORS.power.M).toBe("#FF9900");
    expect(GUN_POWER_COLORS.power.H).toBe("#FF0000");
    expect(GUN_POWER_COLORS.techSmart.L).toBe("#01FFFF");
    expect(GUN_POWER_COLORS.techSmart.M).toBe("#0000FF");
    expect(GUN_POWER_COLORS.techSmart.H).toBe("#9900FF");
  });

  it("tints the power swatch by category family", () => {
    expect(powerColor("Power", "H")).toBe(GUN_POWER_COLORS.power.H);
    expect(powerColor("Power", "low")).toBe(GUN_POWER_COLORS.power.L);
    expect(powerColor("Tech", "M")).toBe(GUN_POWER_COLORS.techSmart.M);
    expect(powerColor("Smart", "high")).toBe(GUN_POWER_COLORS.techSmart.H);
  });

  it("returns no swatch color when category or tier can't be resolved", () => {
    expect(powerColor("Plasma", "H")).toBeNull();
    expect(powerColor("Power", "Ultra")).toBeNull();
    expect(powerColor(null, "H")).toBeNull();
    expect(powerColor("Power", null)).toBeNull();
  });
});
