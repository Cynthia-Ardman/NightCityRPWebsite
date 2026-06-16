import { describe, it, expect } from "vitest";
import { resolveRoleNames, parseLocation, buildLaunchUrl } from "./vrchatInstances";

describe("resolveRoleNames", () => {
  const roleMap = new Map<string, string>([
    ["grol_citizen", "Citizen"],
    ["grol_fixer", "Fixer"],
  ]);

  it("maps known role IDs to their display names", () => {
    expect(resolveRoleNames(["grol_citizen", "grol_fixer"], roleMap)).toEqual([
      "Citizen",
      "Fixer",
    ]);
  });

  it("drops unresolved IDs rather than leaking opaque grol_ IDs", () => {
    // Unknown ID (e.g. role not yet in the cached map, or role map was
    // unavailable this poll) must NOT appear in the human-readable output.
    expect(resolveRoleNames(["grol_citizen", "grol_unknown"], roleMap)).toEqual([
      "Citizen",
    ]);
  });

  it("returns empty when the role map is empty (fetch failure / cold start)", () => {
    expect(resolveRoleNames(["grol_citizen"], new Map())).toEqual([]);
  });

  it("returns empty for an instance with no role gate", () => {
    expect(resolveRoleNames([], roleMap)).toEqual([]);
  });
});

describe("parseLocation", () => {
  it("parses a role-restricted group instance", () => {
    const p = parseLocation(
      "wrld_abc:12345~group(grp_x)~groupAccessType(members)~region(use)",
    );
    expect(p.worldId).toBe("wrld_abc");
    expect(p.shortId).toBe("12345");
    expect(p.accessType).toBe("group_members");
    expect(p.region).toBe("use");
  });

  it("treats a plain public location as public", () => {
    expect(parseLocation("wrld_abc:67890").accessType).toBe("public");
  });
});

describe("buildLaunchUrl", () => {
  it("encodes worldId and instanceId", () => {
    const url = buildLaunchUrl("wrld_abc", "12345~group(grp_x)");
    expect(url).toContain("worldId=wrld_abc");
    expect(url).toContain("instanceId=12345~group(grp_x)".replace(/[~()]/g, (c) => encodeURIComponent(c)));
  });
});
