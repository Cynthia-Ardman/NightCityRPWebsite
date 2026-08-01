import { describe, it, expect } from "vitest";
import { buildSheetInventoryRows } from "./sheets";
import { looseNameKey } from "../lib/strings";

// Catalog map keyed the way loadGunCatalogMap keys it (looseNameKey).
type GunAttrs = { category: string; weaponType: string; fireMode: string; powerLevel: string; manufacturer: string };
const entries: Array<[string, GunAttrs]> = [
  ["Militech M-10AF Lexington", { category: "Power", weaponType: "Pistol", fireMode: "Semi-Auto", powerLevel: "Standard", manufacturer: "Militech" }],
];
const gunCatalog = new Map(entries.map(([name, attrs]) => [looseNameKey(name), attrs]));
const cyberCatalog = new Map<string, { cwp: number; slot: string }>();

function rowsFor(guns: string[], params: Parameters<typeof buildSheetInventoryRows>[3] = {}) {
  return buildSheetInventoryRows({ guns }, cyberCatalog, gunCatalog, params);
}

describe("sheet gun resolution at close (loose name matching)", () => {
  it("auto-resolves an exact catalog name without reviewer params", () => {
    const r = rowsFor(["Militech M-10AF Lexington"]);
    expect("rows" in r && r.rows[0]).toMatchObject({ category: "gun" });
    expect("rows" in r && r.rows[0].notes).toContain("Category: Power");
  });

  it.each([
    "militech m-10af lexington", // case
    "Militech  M-10AF   Lexington", // extra whitespace
    "Militech M10AF Lexington,", // punctuation variants
    "militech m 10af lexington",
  ])("auto-resolves the case/whitespace/punctuation variant %j", (typed) => {
    const r = rowsFor([typed]);
    expect("error" in r).toBe(false);
    if ("rows" in r) {
      // Player's typed spelling is preserved; attributes come from the catalog.
      expect(r.rows[0].name).toBe(typed.trim());
      expect(r.rows[0].notes).toContain("Fire: Semi-Auto");
    }
  });

  it("still hard-requires reviewer attributes for a genuinely custom gun", () => {
    const r = rowsFor(["Frankengun Mk0"]);
    expect(r).toMatchObject({ error: expect.stringContaining('custom gun "Frankengun Mk0"') });

    const ok = rowsFor(["Frankengun Mk0"], {
      sheetGuns: [{ index: 0, category: "Power", weaponType: "Rifle", fireMode: "Full-Auto", powerLevel: "High", manufacturer: "" }],
    });
    expect("rows" in ok && ok.rows[0].notes).toContain("Type: Rifle");
  });
});
