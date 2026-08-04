/**
 * Bidirectional audit: PORTAL_ROUTES in api-server/lib/notificationHrefs.ts
 * must stay in sync with the actual <Route path="..."> declarations in App.tsx.
 *
 * If a portal route is removed or renamed, the test fails here — not silently
 * in the api-server test that only checks against the (now-stale) copy.
 *
 * Sources of truth:
 *   LIVE  — artifacts/ncrp-portal/src/App.tsx (this file's own sibling)
 *   COPY  — artifacts/api-server/src/lib/notificationHrefs.ts (PORTAL_ROUTES)
 *
 * Both directions are checked:
 *   1. Every route in PORTAL_ROUTES must appear in App.tsx (copy has no phantoms).
 *   2. Every route parsed from App.tsx must appear in PORTAL_ROUTES (copy is complete).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

// ---------------------------------------------------------------------------
// Import PORTAL_ROUTES directly from the api-server module.
// notificationHrefs.ts has zero workspace imports so it transforms cleanly.
// ---------------------------------------------------------------------------
import { PORTAL_ROUTES } from "../../../api-server/src/lib/notificationHrefs";

// ---------------------------------------------------------------------------
// Parse App.tsx for every <Route path="..."> declaration.
// ---------------------------------------------------------------------------
const appTsxPath = path.resolve(
  fileURLToPath(import.meta.url),
  "../../App.tsx",
);

function parseAppRoutes(source: string): string[] {
  // Match all path="..." attributes inside <Route ... > elements.
  // The regex handles both self-closing and open tags, and path anywhere
  // within the tag's attributes (not just first).
  const routeTagRe = /<Route\b([^>]*?)>/gs;
  const pathAttrRe = /\bpath="([^"]+)"/;
  const routes: string[] = [];
  for (const tagMatch of source.matchAll(routeTagRe)) {
    const attrs = tagMatch[1];
    const p = pathAttrRe.exec(attrs);
    if (p) routes.push(p[1]);
  }
  return routes;
}

const appSource = readFileSync(appTsxPath, "utf-8");
const APP_ROUTES = parseAppRoutes(appSource);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("App.tsx route parser (sanity)", () => {
  it("finds a non-empty list of routes", () => {
    expect(APP_ROUTES.length).toBeGreaterThan(0);
  });

  it("includes well-known anchor routes", () => {
    expect(APP_ROUTES).toContain("/");
    expect(APP_ROUTES).toContain("/missions/:id");
    expect(APP_ROUTES).toContain("/inbox");
    expect(APP_ROUTES).toContain("/characters/:id");
  });
});

describe("PORTAL_ROUTES ↔ App.tsx bidirectional audit", () => {
  const appSet = new Set(APP_ROUTES);
  const copySet = new Set(PORTAL_ROUTES);

  it("PORTAL_ROUTES has no phantom entries (every copy route exists in App.tsx)", () => {
    const phantoms = [...copySet].filter((r) => !appSet.has(r));
    expect(phantoms, [
      `These routes are in PORTAL_ROUTES (api-server/lib/notificationHrefs.ts)`,
      `but NOT found in App.tsx — either remove them from PORTAL_ROUTES or`,
      `re-add them to App.tsx:`,
      ...phantoms.map((r) => `  "${r}"`),
    ].join("\n")).toEqual([]);
  });

  it("PORTAL_ROUTES is complete (every App.tsx route appears in the copy)", () => {
    const missing = APP_ROUTES.filter((r) => !copySet.has(r));
    expect(missing, [
      `These routes are in App.tsx but NOT in PORTAL_ROUTES`,
      `(api-server/lib/notificationHrefs.ts) — add them to PORTAL_ROUTES:`,
      ...missing.map((r) => `  "${r}"`),
    ].join("\n")).toEqual([]);
  });

  it("both sources agree on the total route count", () => {
    // Surfaces duplicates in either list (distinct from the set checks above).
    expect(APP_ROUTES.length).toBe(PORTAL_ROUTES.length);
  });
});
