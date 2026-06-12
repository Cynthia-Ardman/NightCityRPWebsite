import { describe, it, expect } from "vitest";
import {
  extractCwp,
  parseItemLine,
  parseCyberwareBody,
  totalCwp,
} from "./CyberwareSection";

describe("CyberwareSection: extractCwp", () => {
  it("pulls a parenthesized (2 CWP) cost out of free text", () => {
    const { cwp, remainder } = extractCwp("Sandevistan (2 CWP)");
    expect(cwp).toBe(2);
    expect(remainder).toBe("Sandevistan");
  });

  it("pulls a dash-separated cost", () => {
    const { cwp, remainder } = extractCwp("Mantis Blades - 3 CWP");
    expect(cwp).toBe(3);
    // The dash is the separator stripped along with the CWP token.
    expect(remainder).toMatch(/Mantis Blades/);
  });

  it("recognizes 'points' as a synonym for CWP", () => {
    const { cwp } = extractCwp("Some chrome (1 point)");
    expect(cwp).toBe(1);
  });

  it("recognizes the 'pts' abbreviation", () => {
    const { cwp } = extractCwp("Cyberdeck - 2 pts");
    expect(cwp).toBe(2);
  });

  it("returns null cost for a line with no CWP marker", () => {
    const { cwp, remainder } = extractCwp("Cybereye");
    expect(cwp).toBeNull();
    expect(remainder).toBe("Cybereye");
  });

  it("parses decimal costs like 1.5 CWP", () => {
    const { cwp } = extractCwp("Tweak (1.5 CWP)");
    expect(cwp).toBe(1.5);
  });
});

describe("CyberwareSection: parseItemLine", () => {
  it("strips bullet markers and trims the name", () => {
    const item = parseItemLine("- Kiroshi Optics (2 CWP)");
    expect(item).not.toBeNull();
    expect(item!.name).toBe("Kiroshi Optics");
    expect(item!.cwp).toBe(2);
  });

  it("splits name and description on a dash separator", () => {
    const item = parseItemLine("Sandevistan - speedware boost (2 CWP)");
    expect(item).not.toBeNull();
    expect(item!.name).toBe("Sandevistan");
    expect(item!.description).toBe("speedware boost");
    expect(item!.cwp).toBe(2);
  });

  it("returns null for an empty/whitespace line", () => {
    expect(parseItemLine("")).toBeNull();
    expect(parseItemLine("   ")).toBeNull();
  });

  it("returns null for a literal 'None' line", () => {
    expect(parseItemLine("None.")).toBeNull();
    expect(parseItemLine("none")).toBeNull();
  });

  it("returns an item with null cwp when no CWP marker is present", () => {
    const item = parseItemLine("• Cybereye");
    expect(item).not.toBeNull();
    expect(item!.name).toBe("Cybereye");
    expect(item!.cwp).toBeNull();
  });
});

describe("CyberwareSection: parseCyberwareBody slot aliases", () => {
  it("normalizes 'Eyes:' to the canonical Ocular System slot", () => {
    const parsed = parseCyberwareBody("Eyes: Kiroshi Optics (2 CWP)");
    expect(parsed.groups.map((g) => g.slot)).toContain("Ocular System");
    const ocular = parsed.groups.find((g) => g.slot === "Ocular System")!;
    expect(ocular.items[0].name).toBe("Kiroshi Optics");
    expect(ocular.items[0].cwp).toBe(2);
  });

  it("normalizes 'Ears' to the canonical Auditory System slot", () => {
    const parsed = parseCyberwareBody("Ears: Cybernetic Ear (1 CWP)");
    expect(parsed.groups.find((g) => g.slot === "Auditory System")).toBeDefined();
  });

  it("groups items under their declared slot across multiple lines", () => {
    const body = [
      "Ocular: Kiroshi Optics (2 CWP)",
      "Neural:",
      "- Sandevistan (3 CWP)",
      "- Cyberdeck (1 CWP)",
    ].join("\n");
    const parsed = parseCyberwareBody(body);
    const neural = parsed.groups.find((g) => g.slot === "Neural")!;
    expect(neural.items.map((i) => i.name)).toEqual(["Sandevistan", "Cyberdeck"]);
  });

  it("places items that follow a blank-line break (no current slot) into uncategorized", () => {
    // A blank line resets the current slot, so the bullet that follows has
    // no owning slot and lands in `uncategorized` once any slot has been
    // seen earlier in the body.
    const body = [
      "Neural: Sandevistan (3 CWP)",
      "",
      "- Mystery Mod (1 CWP)",
    ].join("\n");
    const parsed = parseCyberwareBody(body);
    const neural = parsed.groups.find((g) => g.slot === "Neural");
    expect(neural?.items.map((i) => i.name)).toEqual(["Sandevistan"]);
    expect(parsed.uncategorized.map((i) => i.name)).toEqual(["Mystery Mod"]);
  });

  it("resolves slot headers that carry a slot-count parenthetical", () => {
    const body = [
      "Arms & Arm Attachments (1 slot per arm): Cyberarm (Dextrous)",
      "Ocular System: Targeting Optic",
      "Legs & Mobility (1 slot per leg): Reinforced Tendons",
      "Hands & Feet (2 slots): Grip Plating",
    ].join("\n");
    const parsed = parseCyberwareBody(body);
    expect(parsed.preamble).toBeNull();
    const arms = parsed.groups.find((g) => g.slot === "Arms & Arm Attachments")!;
    expect(arms.items.map((i) => i.name)).toEqual(["Cyberarm (Dextrous)"]);
    const legs = parsed.groups.find((g) => g.slot === "Legs & Mobility")!;
    expect(legs.items.map((i) => i.name)).toEqual(["Reinforced Tendons"]);
    const handsFeet = parsed.groups.find((g) => g.slot === "Hands & Feet")!;
    expect(handsFeet.items.map((i) => i.name)).toEqual(["Grip Plating"]);
    // Nothing should have leaked into Ocular as a stray item.
    const ocular = parsed.groups.find((g) => g.slot === "Ocular System")!;
    expect(ocular.items.map((i) => i.name)).toEqual(["Targeting Optic"]);
  });

  it("treats a bare slot-name line (no colon) as its own header", () => {
    // Real sheet shape: every header has a colon except a lone "Neural" line.
    // Without bare-header detection, "Neural" and the item below it were
    // absorbed as items under the previous "Legs & Mobility" header.
    const body = [
      "   * Legs & Mobility (1 slot per leg):",
      "   * Neural",
      "Netrunner suite LV2 II 3",
      "   * Ocular System: Smart Eyes II 2",
      "   * Miscellaneous: ",
      "Internal Storage II 1",
    ].join("\n");
    const parsed = parseCyberwareBody(body);
    // Legs & Mobility had no items of its own → not rendered.
    expect(parsed.groups.find((g) => g.slot === "Legs & Mobility")).toBeUndefined();
    const neural = parsed.groups.find((g) => g.slot === "Neural")!;
    expect(neural).toBeDefined();
    expect(neural.items.map((i) => i.name)).toEqual(["Netrunner suite LV2 II 3"]);
    const ocular = parsed.groups.find((g) => g.slot === "Ocular System")!;
    expect(ocular.items.map((i) => i.name)).toEqual(["Smart Eyes II 2"]);
  });

  it("does NOT treat a bullet item that aliases a slot as a bare header", () => {
    // "Cyberdeck" is a loose alias for Neural, but as a bullet item under an
    // existing slot it must stay an item, not start a new header.
    const body = ["Neural: Sandevistan (3 CWP)", "- Cyberdeck"].join("\n");
    const parsed = parseCyberwareBody(body);
    const neural = parsed.groups.find((g) => g.slot === "Neural")!;
    expect(neural.items.map((i) => i.name)).toEqual(["Sandevistan", "Cyberdeck"]);
  });

  it("keeps single-word alias item lines (Eyes/Brain) as items, not headers", () => {
    const body = ["Ocular System: Smart Eyes (2 CWP)", "- Eyes", "- Brain"].join("\n");
    const parsed = parseCyberwareBody(body);
    const ocular = parsed.groups.find((g) => g.slot === "Ocular System")!;
    expect(ocular.items.map((i) => i.name)).toEqual(["Smart Eyes", "Eyes", "Brain"]);
    // No spurious Auditory/Neural groups created from the alias item lines.
    expect(parsed.groups.find((g) => g.slot === "Auditory System")).toBeUndefined();
  });

  it("falls back to raw body when no recognizable slot is found", () => {
    const parsed = parseCyberwareBody("just some free text with no structure");
    expect(parsed.rawFallback).toBeTruthy();
  });
});

describe("CyberwareSection: totalCwp", () => {
  it("sums CWP across all groups and uncategorized items", () => {
    const parsed = parseCyberwareBody(
      ["Ocular: Kiroshi (2 CWP)", "Neural: Sandevistan (3 CWP)"].join("\n"),
    );
    expect(totalCwp(parsed)).toBe(5);
  });

  it("returns null when no item has a CWP cost", () => {
    const parsed = parseCyberwareBody(["Ocular: Cybereye", "Neural: Cyberdeck"].join("\n"));
    expect(totalCwp(parsed)).toBeNull();
  });

  it("ignores items with no cost while summing the rest", () => {
    const parsed = parseCyberwareBody(
      ["Ocular: Kiroshi (2 CWP)", "Neural: Cyberdeck"].join("\n"),
    );
    expect(totalCwp(parsed)).toBe(2);
  });
});
