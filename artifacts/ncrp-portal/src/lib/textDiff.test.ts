import { describe, it, expect } from "vitest";
import { diffWords, diffLines, collapseContext, isDiffSafe, multisetDiff, MAX_DIFF_CELLS } from "./textDiff";

describe("diffWords", () => {
  it("marks a single changed word and keeps the rest equal", () => {
    const ops = diffWords("Baross Iron Jaw Mundy", "Baross Evil Eyes Mundy");
    // Reconstructing equal+remove yields the before; equal+add yields the after.
    const before = ops.filter((o) => o.type !== "add").map((o) => o.value).join("");
    const after = ops.filter((o) => o.type !== "remove").map((o) => o.value).join("");
    expect(before).toBe("Baross Iron Jaw Mundy");
    expect(after).toBe("Baross Evil Eyes Mundy");
    expect(ops.some((o) => o.type === "add")).toBe(true);
    expect(ops.some((o) => o.type === "remove")).toBe(true);
    // The shared "Baross " prefix and " Mundy" suffix stay equal.
    expect(ops[0]).toEqual({ type: "equal", value: "Baross " });
  });

  it("treats an unchanged string as all-equal", () => {
    const ops = diffWords("no change here", "no change here");
    expect(ops).toEqual([{ type: "equal", value: "no change here" }]);
  });

  it("handles empty before (pure addition)", () => {
    const ops = diffWords("", "brand new");
    expect(ops).toEqual([{ type: "add", value: "brand new" }]);
  });
});

describe("diffLines", () => {
  it("emits one op per line and flags the changed line", () => {
    const before = "a\nb\nc";
    const after = "a\nB\nc";
    const ops = diffLines(before, after);
    expect(ops.filter((o) => o.type === "remove")).toEqual([{ type: "remove", value: "b" }]);
    expect(ops.filter((o) => o.type === "add")).toEqual([{ type: "add", value: "B" }]);
    expect(ops.filter((o) => o.type === "equal").map((o) => o.value)).toEqual(["a", "c"]);
  });
});

describe("collapseContext", () => {
  it("collapses long unchanged runs into a gap row", () => {
    const ops = diffLines(
      ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("\n"),
      ["l1", "l2", "l3", "l4", "l5", "CHANGED", "l7", "l8", "l9", "l10"].join("\n"),
    );
    const rows = collapseContext(ops, 1);
    // First gap collapses l1..l4 (only l5 is within 1 of the change).
    expect(rows[0]).toEqual({ type: "gap", count: 4 });
    expect(rows.some((r) => r.type === "remove" && r.value === "l6")).toBe(true);
    expect(rows.some((r) => r.type === "add" && r.value === "CHANGED")).toBe(true);
    // Trailing l8..l10 collapse into a gap as well.
    expect(rows[rows.length - 1]).toEqual({ type: "gap", count: 3 });
  });

  it("keeps everything when within the context window", () => {
    const ops = diffLines("a\nb", "a\nB");
    const rows = collapseContext(ops, 3);
    expect(rows.some((r) => r.type === "gap")).toBe(false);
  });

  it("never collapses a changed line", () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const afterArr = before.split("\n");
    afterArr[25] = "MUTATED";
    const rows = collapseContext(diffLines(before, afterArr.join("\n")), 3);
    expect(rows.some((r) => r.type === "remove" && r.value === "line 25")).toBe(true);
    expect(rows.some((r) => r.type === "add" && r.value === "MUTATED")).toBe(true);
  });
});

describe("multisetDiff", () => {
  it("counts a dropped duplicate as a removal", () => {
    const { added, removed } = multisetDiff(["u", "u"], ["u"]);
    expect(removed).toEqual(["u"]);
    expect(added).toEqual([]);
  });

  it("reports adds and removes for disjoint lists", () => {
    const { added, removed } = multisetDiff(["a", "b"], ["b", "c"]);
    expect(removed).toEqual(["a"]);
    expect(added).toEqual(["c"]);
  });

  it("reports no change for identical multisets regardless of order", () => {
    const { added, removed } = multisetDiff(["a", "b", "a"], ["a", "a", "b"]);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe("isDiffSafe", () => {
  it("allows normal-sized fields", () => {
    expect(isDiffSafe("a short before", "a short after", "words")).toBe(true);
    expect(isDiffSafe("a\nb\nc", "a\nB\nc", "lines")).toBe(true);
  });

  it("rejects fields whose LCS table exceeds the cell budget", () => {
    const big = Array.from({ length: Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10 }, (_, i) => `l${i}`).join("\n");
    expect(isDiffSafe(big, big + "\nextra", "lines")).toBe(false);
  });
});
