import { describe, it, expect } from "vitest";
import { batchSlotClashError } from "./cyberwareSlots";

const catalog = new Map<string, string>([
  ["neofiber", "Skeleton & Torso Musculature"],
  ["dense marrow", "Skeleton & Torso Musculature"],
  ["skill chip", "Miscellaneous"],
]);

describe("batchSlotClashError", () => {
  it("returns null for a clean batch", () => {
    const err = batchSlotClashError(
      [
        { name: "NeoFiber", notes: "CWP 3 · slot: Skeleton & Torso Musculature", quantity: 1 },
        { name: "Skill Chip", notes: "CWP 1", quantity: 1 },
      ],
      catalog,
    );
    expect(err).toBeNull();
  });

  it("rejects an installed row with quantity > 1 (any slot)", () => {
    const err = batchSlotClashError([{ name: "Skill Chip", notes: "CWP 1", quantity: 2 }], catalog);
    expect(err).toMatch(/only one copy/i);
  });

  it("rejects the same item installed twice, even in an uncapped slot", () => {
    const err = batchSlotClashError(
      [
        { name: "Skill Chip", notes: "CWP 1", quantity: 1 },
        { name: "Skill Chip", notes: "CWP 1", quantity: 1 },
      ],
      catalog,
    );
    expect(err).toMatch(/more than once/i);
  });

  it("rejects two different items in the same capped slot", () => {
    const err = batchSlotClashError(
      [
        { name: "NeoFiber", notes: "CWP 3", quantity: 1 },
        { name: "Dense Marrow", notes: "CWP 2", quantity: 1 },
      ],
      catalog,
    );
    expect(err).toMatch(/both occupy/i);
  });

  it("ignores uninstalled rows (no CWP tag)", () => {
    const err = batchSlotClashError(
      [
        { name: "NeoFiber", notes: "CWP 3", quantity: 1 },
        { name: "NeoFiber", notes: "spare in the stash", quantity: 1 },
      ],
      catalog,
    );
    expect(err).toBeNull();
  });
});
