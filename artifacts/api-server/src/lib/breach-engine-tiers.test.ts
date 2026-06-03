import { describe, it, expect } from "vitest";
import {
  DIFFICULTIES,
  PRACTICE_DIFFICULTIES,
  DIFFICULTY_PROFILES,
  generatePuzzleByDifficulty,
  solvePuzzle,
  scoreSelection,
  countPuzzleSolutions,
  type Difficulty,
} from "@workspace/breach";

// These tests guard the harder Breach tiers: each difficulty must keep its
// declared board SHAPE and stay solvable (or, for "impossible", unsolvable),
// while the original 5x5 tiers are unchanged.

describe("breach difficulty rosters", () => {
  it("orders all tiers easiest → hardest with impossible last", () => {
    expect(DIFFICULTIES).toEqual([
      "easy",
      "medium",
      "hard",
      "very_hard",
      "nightmare",
      "impossible",
    ]);
  });

  it("offers every tier except impossible for practice", () => {
    expect(PRACTICE_DIFFICULTIES).toEqual([
      "easy",
      "medium",
      "hard",
      "very_hard",
      "nightmare",
    ]);
  });
});

describe("breach tier board shapes", () => {
  const cases: Array<{ diff: Difficulty; rows: number; cols: number; daemons: number }> = [
    { diff: "easy", rows: 5, cols: 5, daemons: 3 },
    { diff: "medium", rows: 5, cols: 5, daemons: 3 },
    { diff: "hard", rows: 5, cols: 5, daemons: 3 },
    { diff: "very_hard", rows: 6, cols: 6, daemons: 4 },
    { diff: "nightmare", rows: 7, cols: 7, daemons: 5 },
    { diff: "impossible", rows: 5, cols: 5, daemons: 3 },
  ];

  for (const { diff, rows, cols, daemons } of cases) {
    it(`${diff} generates a ${rows}x${cols} grid with ${daemons} daemons`, () => {
      const profile = DIFFICULTY_PROFILES[diff];
      expect(profile.rows).toBe(rows);
      expect(profile.cols).toBe(cols);
      expect(profile.daemonCount).toBe(daemons);

      // Generate a handful so we cover the retry/fallback paths, not just one RNG draw.
      for (let i = 0; i < 5; i++) {
        const p = generatePuzzleByDifficulty(diff);
        expect(p.grid.length).toBe(rows);
        expect(p.grid.every((row) => row.length === cols)).toBe(true);
        expect(p.daemons.length).toBe(daemons);
      }
    });
  }
});

describe("breach tier solvability", () => {
  for (const diff of ["easy", "medium", "hard", "very_hard", "nightmare"] as const) {
    it(`${diff} produces a grid that can actually be breached`, () => {
      const p = generatePuzzleByDifficulty(diff);
      expect(p.solutionCount).toBeGreaterThanOrEqual(1);

      const solution = solvePuzzle(p.grid, p.daemons, p.bufferSize);
      expect(solution).not.toBeNull();
      expect(solution!.length).toBeLessThanOrEqual(p.bufferSize);

      const score = scoreSelection(p.grid, p.daemons, p.bufferSize, solution!);
      expect(score.valid).toBe(true);
      expect(score.allSolved).toBe(true);
    });
  }

  it("impossible produces an unsolvable grid", () => {
    const p = generatePuzzleByDifficulty("impossible");
    expect(p.solutionCount).toBe(0);
    expect(countPuzzleSolutions(p.grid, p.daemons)).toBe(0);
    expect(solvePuzzle(p.grid, p.daemons, p.bufferSize)).toBeNull();
  });
});
