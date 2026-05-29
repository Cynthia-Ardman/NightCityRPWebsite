import { describe, it, expect } from "vitest";
import { rollExpression } from "./DiceRoller";

describe("DiceRoller: rollExpression bounds", () => {
  it("rolls a single die in the [1, sides] range", () => {
    for (let trial = 0; trial < 200; trial++) {
      const { rolls, total, modifier } = rollExpression("1d6");
      expect(rolls).toHaveLength(1);
      expect(rolls[0]).toBeGreaterThanOrEqual(1);
      expect(rolls[0]).toBeLessThanOrEqual(6);
      expect(modifier).toBe(0);
      expect(total).toBe(rolls[0]);
    }
  });

  it("rolls N dice with sum within the legal min/max envelope", () => {
    for (let trial = 0; trial < 50; trial++) {
      const { rolls, total } = rollExpression("4d6");
      expect(rolls).toHaveLength(4);
      for (const r of rolls) {
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(6);
      }
      expect(total).toBeGreaterThanOrEqual(4);
      expect(total).toBeLessThanOrEqual(24);
    }
  });

  it("supports common quick-roll macros (1d10, 1d100, 2d6, 4d6)", () => {
    const cases: Array<[string, number, number, number]> = [
      ["1d10", 1, 1, 10],
      ["1d100", 1, 1, 100],
      ["2d6", 2, 2, 12],
      ["4d6", 4, 4, 24],
    ];
    for (const [expr, count, lo, hi] of cases) {
      for (let trial = 0; trial < 30; trial++) {
        const { rolls, total } = rollExpression(expr);
        expect(rolls).toHaveLength(count);
        expect(total).toBeGreaterThanOrEqual(lo);
        expect(total).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("applies a positive flat modifier to the total", () => {
    const { total, modifier, rolls } = rollExpression("1d20+5", () => 0); // forces a 1
    expect(rolls).toEqual([1]);
    expect(modifier).toBe(5);
    expect(total).toBe(6);
  });

  it("applies a negative flat modifier to the total", () => {
    const { total, modifier, rolls } = rollExpression("1d20-3", () => 0.999_999); // forces a 20
    expect(rolls).toEqual([20]);
    expect(modifier).toBe(-3);
    expect(total).toBe(17);
  });

  it("defaults to one die when count is omitted", () => {
    const { rolls } = rollExpression("d20");
    expect(rolls).toHaveLength(1);
    expect(rolls[0]).toBeGreaterThanOrEqual(1);
    expect(rolls[0]).toBeLessThanOrEqual(20);
  });

  it("uses the injected RNG so results are deterministic", () => {
    const seq = [0, 0.5, 0.999_999];
    let i = 0;
    const { rolls, total } = rollExpression("3d10", () => seq[i++]);
    // 0 -> 1, 0.5 -> 6, 0.999999 -> 10 (since 1 + floor(0.999999 * 10) = 10)
    expect(rolls).toEqual([1, 6, 10]);
    expect(total).toBe(17);
  });

  it("rejects nonsense expressions", () => {
    expect(() => rollExpression("not-a-roll")).toThrow();
    expect(() => rollExpression("")).toThrow();
    expect(() => rollExpression("d")).toThrow();
  });

  it("rejects dice with sides < 2 or > 1000", () => {
    expect(() => rollExpression("1d1")).toThrow();
    expect(() => rollExpression("1d1001")).toThrow();
  });

  it("rejects counts < 1 or > 100", () => {
    expect(() => rollExpression("0d6")).toThrow();
    expect(() => rollExpression("101d6")).toThrow();
  });
});
