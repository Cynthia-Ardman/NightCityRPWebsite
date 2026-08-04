/**
 * Regression test: every notification href builder in notificationHrefs.ts
 * must produce a URL that matches at least one real portal route.
 *
 * Design:
 *  - PORTAL_ROUTES (the live source of truth) lives in notificationHrefs.ts
 *    alongside the builders. Any change to portal routes OR builders requires
 *    updating that single file; the test catches discrepancies automatically.
 *  - Route patterns use `:param` syntax (wouter style). We convert each pattern
 *    to a regex so `/missions/:id` matches `/missions/42`.
 *  - The test enumerates all exported builders, invokes each with a sample
 *    argument, and asserts the result resolves to a known route.
 */

import { describe, it, expect } from "vitest";
import {
  PORTAL_ROUTES,
  hrefLedger,
  hrefMission,
  hrefMissionOrLedger,
  hrefInbox,
  hrefSubmissions,
  hrefCharacter,
  hrefSheet,
  hrefBreachPlay,
  hrefLoreEntry,
  hrefLoreMine,
  hrefAdmin,
} from "../lib/notificationHrefs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a wouter route pattern to a regex that matches concrete hrefs. */
function patternToRegex(pattern: string): RegExp {
  // Escape regex metacharacters except `:param` segments.
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // escape special chars
    .replace(/:[^/]+/g, "[^/]+"); // :param → any non-slash segment
  return new RegExp(`^${escaped}$`);
}

/** Assert that `href` matches at least one route pattern. */
function assertResolvable(href: string, label: string): void {
  const matches = PORTAL_ROUTES.some((p) => patternToRegex(p).test(href));
  if (!matches) {
    throw new Error(
      `Notification href "${href}" (${label}) does not match any PORTAL_ROUTE.\n` +
        `Known routes:\n${PORTAL_ROUTES.join("\n")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PORTAL_ROUTES", () => {
  it("is non-empty and contains at least the root route", () => {
    expect(PORTAL_ROUTES.length).toBeGreaterThan(0);
    expect(PORTAL_ROUTES).toContain("/");
  });

  it("all patterns are valid (start with / and contain no spaces)", () => {
    for (const r of PORTAL_ROUTES) {
      expect(r).toMatch(/^\//);
      expect(r).not.toMatch(/\s/);
    }
  });
});

describe("notification href builders → portal routes", () => {
  it("hrefLedger resolves", () => {
    assertResolvable(hrefLedger(), "hrefLedger");
    expect(hrefLedger()).toBe("/ledger");
  });

  it("hrefMission resolves with a numeric id", () => {
    assertResolvable(hrefMission(42), "hrefMission(42)");
    assertResolvable(hrefMission("99"), "hrefMission('99')");
    expect(hrefMission(42)).toBe("/missions/42");
  });

  it("hrefMissionOrLedger: resolves with id or falls back to ledger", () => {
    assertResolvable(hrefMissionOrLedger(7), "hrefMissionOrLedger(7)");
    assertResolvable(hrefMissionOrLedger(null), "hrefMissionOrLedger(null)");
    assertResolvable(hrefMissionOrLedger(undefined), "hrefMissionOrLedger(undefined)");
    expect(hrefMissionOrLedger(7)).toBe("/missions/7");
    expect(hrefMissionOrLedger(null)).toBe("/ledger");
    expect(hrefMissionOrLedger(undefined)).toBe("/ledger");
  });

  it("hrefInbox resolves", () => {
    assertResolvable(hrefInbox(), "hrefInbox");
    expect(hrefInbox()).toBe("/inbox");
  });

  it("hrefSubmissions resolves", () => {
    assertResolvable(hrefSubmissions(), "hrefSubmissions");
    expect(hrefSubmissions()).toBe("/submissions");
  });

  it("hrefCharacter resolves with numeric and string ids", () => {
    assertResolvable(hrefCharacter(1), "hrefCharacter(1)");
    assertResolvable(hrefCharacter("abc"), "hrefCharacter('abc')");
    expect(hrefCharacter(1)).toBe("/characters/1");
    // Confirm it does NOT use the staff-only directory path.
    expect(hrefCharacter(1)).not.toContain("/directory/characters/");
  });

  it("hrefSheet resolves", () => {
    assertResolvable(hrefSheet(5), "hrefSheet(5)");
    expect(hrefSheet(5)).toBe("/sheets/5");
  });

  it("hrefBreachPlay resolves", () => {
    assertResolvable(hrefBreachPlay(3), "hrefBreachPlay(3)");
    expect(hrefBreachPlay(3)).toBe("/breach/play/3");
  });

  it("hrefLoreEntry resolves", () => {
    assertResolvable(hrefLoreEntry(10), "hrefLoreEntry(10)");
    expect(hrefLoreEntry(10)).toBe("/directory/lore/10");
  });

  it("hrefLoreMine resolves", () => {
    assertResolvable(hrefLoreMine(), "hrefLoreMine");
    expect(hrefLoreMine()).toBe("/directory/lore/mine");
  });

  it("hrefAdmin resolves", () => {
    assertResolvable(hrefAdmin(), "hrefAdmin");
    expect(hrefAdmin()).toBe("/admin");
  });
});

describe("PORTAL_ROUTES regression: routes used by builders must all exist", () => {
  // Collect every concrete href shape that a builder can produce and verify it
  // against PORTAL_ROUTES. This makes the test self-validating: if a route is
  // removed from App.tsx, update PORTAL_ROUTES, and these assertions fail.
  const BUILDER_SAMPLES: Array<[string, string]> = [
    ["hrefLedger", "/ledger"],
    ["hrefMission", "/missions/42"],
    ["hrefMissionOrLedger (with id)", "/missions/1"],
    ["hrefMissionOrLedger (fallback)", "/ledger"],
    ["hrefInbox", "/inbox"],
    ["hrefSubmissions", "/submissions"],
    ["hrefCharacter", "/characters/1"],
    ["hrefSheet", "/sheets/1"],
    ["hrefBreachPlay", "/breach/play/1"],
    ["hrefLoreEntry", "/directory/lore/1"],
    ["hrefLoreMine", "/directory/lore/mine"],
    ["hrefAdmin", "/admin"],
  ];

  for (const [label, href] of BUILDER_SAMPLES) {
    it(`"${href}" (${label}) is in PORTAL_ROUTES`, () => {
      assertResolvable(href, label);
    });
  }
});
