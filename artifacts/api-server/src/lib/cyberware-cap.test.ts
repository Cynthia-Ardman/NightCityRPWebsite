import { describe, it, expect } from "vitest";
import {
  MAX_CREATION_CWP,
  collectCyberware,
  buildCyberwareCostMap,
  entryPoints,
  validateCyberware,
  type CyberwareEntry,
} from "./cyberware-cap";

// Mirrors the rows returned from the catalog_cyberware table (cwp is nullable text).
const CATALOG_ROWS = [
  { name: "Sandevistan", cwp: "4" },
  { name: "Mantis Blades", cwp: "3" },
  { name: "Subdermal Armor", cwp: "2" },
  { name: "Cyberdeck", cwp: "1" },
];

const costMap = buildCyberwareCostMap(CATALOG_ROWS);

describe("buildCyberwareCostMap", () => {
  it("normalizes names by trimming and lowercasing", () => {
    const map = buildCyberwareCostMap([{ name: "  SandeVISTAN  ", cwp: "4" }]);
    expect(map.get("sandevistan")).toBe(4);
  });

  it("keeps the highest CWP when duplicate names exist", () => {
    const map = buildCyberwareCostMap([
      { name: "Sandevistan", cwp: "4" },
      { name: "sandevistan", cwp: "7" }, // crafted cheap/expensive duplicate
      { name: "SANDEVISTAN", cwp: "2" },
    ]);
    expect(map.get("sandevistan")).toBe(7);
  });

  it("treats null / non-numeric cwp as 0", () => {
    const map = buildCyberwareCostMap([
      { name: "Mystery Chrome", cwp: null },
      { name: "Garbage", cwp: "not-a-number" },
    ]);
    expect(map.get("mystery chrome")).toBe(0);
    expect(map.get("garbage")).toBe(0);
  });

  it("skips rows whose name is blank after trimming", () => {
    const map = buildCyberwareCostMap([{ name: "   ", cwp: "5" }]);
    expect(map.size).toBe(0);
  });
});

describe("entryPoints", () => {
  it("uses the catalog cost and ignores a tampered client-sent points value", () => {
    // Client claims this catalog install is free.
    expect(entryPoints({ name: "Sandevistan", points: 0 }, costMap)).toBe(4);
    // Client claims a negative cost to try to offset other entries.
    expect(entryPoints({ name: "Mantis Blades", points: -10 }, costMap)).toBe(3);
  });

  it("matches catalog items regardless of casing / surrounding whitespace", () => {
    expect(entryPoints({ name: "  sandeVISTAN ", points: 99 }, costMap)).toBe(4);
  });

  it("falls back to the client-sent value for custom (non-catalog) entries", () => {
    expect(entryPoints({ name: "Homebrew Implant", points: 2 }, costMap)).toBe(2);
  });

  it("treats a missing/invalid custom points value as 0", () => {
    expect(entryPoints({ name: "Homebrew Implant" }, costMap)).toBe(0);
    expect(entryPoints({ name: "Homebrew Implant", points: NaN }, costMap)).toBe(0);
  });
});

describe("validateCyberware", () => {
  it("passes a legitimate sheet at exactly the cap", () => {
    const entries: CyberwareEntry[] = [
      { name: "Sandevistan", points: 4 },
      { name: "Subdermal Armor", points: 2 },
    ];
    expect(validateCyberware(entries, costMap)).toBeNull();
  });

  it("passes an organic character with no cyberware", () => {
    expect(validateCyberware([], costMap)).toBeNull();
  });

  it("passes a legitimate sheet mixing catalog and custom entries under the cap", () => {
    const entries: CyberwareEntry[] = [
      { name: "Cyberdeck", points: 1 }, // catalog: 1
      { name: "Homebrew Implant", points: 2 }, // custom: 2
    ];
    expect(validateCyberware(entries, costMap)).toBeNull();
  });

  it("rejects a tampered payload claiming a catalog install costs 0 when the real cost is over cap", () => {
    const entries: CyberwareEntry[] = [
      { name: "Sandevistan", points: 0 }, // really 4
      { name: "Mantis Blades", points: 0 }, // really 3 -> total 7 > 6
    ];
    expect(validateCyberware(entries, costMap)).toBe(
      `Max ${MAX_CREATION_CWP} cyberware points (CWP) at creation`,
    );
  });

  it("rejects a negative custom points value used to offset an over-cap catalog install", () => {
    const entries: CyberwareEntry[] = [
      { name: "Sandevistan", points: 4 }, // catalog: 4
      { name: "Mantis Blades", points: 3 }, // catalog: 3 -> 7 so far
      { name: "Exploit", points: -5 }, // custom negative to drag total to 2
    ];
    expect(validateCyberware(entries, costMap)).toBe("Cyberware CWP cannot be negative");
  });

  it("rejects when a catalog cost (not the client value) pushes the total over the cap", () => {
    // Two duplicate-named catalog rows: the higher cost is authoritative.
    const map = buildCyberwareCostMap([
      { name: "Sandevistan", cwp: "4" },
      { name: "Sandevistan", cwp: "8" },
    ]);
    const entries: CyberwareEntry[] = [{ name: "Sandevistan", points: 1 }];
    expect(validateCyberware(entries, map)).toBe(
      `Max ${MAX_CREATION_CWP} cyberware points (CWP) at creation`,
    );
  });

  it("rejects custom entries that legitimately exceed the cap", () => {
    const entries: CyberwareEntry[] = [{ name: "Homebrew Implant", points: 7 }];
    expect(validateCyberware(entries, costMap)).toBe(
      `Max ${MAX_CREATION_CWP} cyberware points (CWP) at creation`,
    );
  });
});

describe("collectCyberware", () => {
  it("reads the current cyberware array and drops nameless entries", () => {
    const d = { cyberware: [{ name: "Sandevistan", points: 4 }, { name: "  ", points: 9 }, { points: 1 }] };
    expect(collectCyberware(d)).toEqual([{ name: "Sandevistan", points: 4 }]);
  });

  it("falls back to legacy by-slot + misc lists when cyberware is empty", () => {
    const d = {
      cyberware: [],
      cyberwareBySlot: [{ name: "Mantis Blades", points: 3 }],
      cyberwareMisc: [{ name: "Cyberdeck", points: 1 }],
    };
    expect(collectCyberware(d)).toEqual([
      { name: "Mantis Blades", points: 3 },
      { name: "Cyberdeck", points: 1 },
    ]);
  });

  it("end-to-end: a tampered legacy payload is still caught via collect + validate", () => {
    const d = {
      cyberwareBySlot: [
        { name: "Sandevistan", points: 0 },
        { name: "Mantis Blades", points: 0 },
      ],
    };
    const entries = collectCyberware(d);
    expect(validateCyberware(entries, costMap)).toBe(
      `Max ${MAX_CREATION_CWP} cyberware points (CWP) at creation`,
    );
  });
});
