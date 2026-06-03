// Difficulty selection, authoritative scoring, and path validation for the
// Breach Protocol minigame. Used by the server (authoritative) and the client
// (live UX feedback) so both share identical rules.

import {
  combineDaemons,
  generatePuzzle,
  HEX_VALUES,
  type Pos,
  type Puzzle,
} from "./puzzleGenerator";
import { countSolutions, findFirstSolution } from "./bruteCounter";

export type Difficulty =
  | "easy"
  | "medium"
  | "hard"
  | "very_hard"
  | "nightmare"
  | "impossible";

// Ordered easiest → hardest, with the staff-only unsolvable "impossible" last.
export const DIFFICULTIES: Difficulty[] = [
  "easy",
  "medium",
  "hard",
  "very_hard",
  "nightmare",
  "impossible",
];

// Difficulties offered on the (unrecorded) practice page and its leaderboard.
// "impossible" generates an intentionally unsolvable grid, which makes no sense
// to practice or rank, so it is excluded here while remaining available to
// staff for assigned puzzles.
export type PracticeDifficulty = Exclude<Difficulty, "impossible">;

export const PRACTICE_DIFFICULTIES: PracticeDifficulty[] = [
  "easy",
  "medium",
  "hard",
  "very_hard",
  "nightmare",
];

// Per-tier generation profile. Difficulty is no longer purely a solution-count
// bucket: each tier picks the board SHAPE (grid size, daemon count, sequence
// length) up front, and `matches` only tunes how forgiving the solution-count
// retry is. `countCap` bounds the brute-force counter during the retry loop so
// generation stays fast on the larger 6x6 / 7x7 boards (we only need to know
// whether the count lands in the band, not the exact total).
export interface DifficultyProfile {
  rows: number;
  cols: number;
  daemonCount: number;
  // Upper bound on a single daemon's length (see generatePuzzle's maxLen).
  maxLen: number;
  // Whether a generated grid's solution count satisfies this tier.
  matches: (count: number) => boolean;
  // Short-circuit cap for the match-test counter (see countSolutions cap).
  countCap: number;
}

export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  // Existing 5x5 / 3-daemon tiers — bands unchanged from the original logic.
  easy: { rows: 5, cols: 5, daemonCount: 3, maxLen: 4, matches: (c) => c > 5, countCap: 6 },
  medium: { rows: 5, cols: 5, daemonCount: 3, maxLen: 4, matches: (c) => c >= 2 && c <= 5, countCap: 6 },
  hard: { rows: 5, cols: 5, daemonCount: 3, maxLen: 4, matches: (c) => c === 1, countCap: 2 },
  // New harder tiers: bigger boards, more daemons, longer sequences, aiming for
  // a near-unique solution (allow up to 2 so the retry loop converges quickly).
  very_hard: { rows: 6, cols: 6, daemonCount: 4, maxLen: 5, matches: (c) => c >= 1 && c <= 2, countCap: 3 },
  nightmare: { rows: 7, cols: 7, daemonCount: 5, maxLen: 5, matches: (c) => c >= 1 && c <= 2, countCap: 3 },
  // Intentionally unsolvable (scrambled), staff-only.
  impossible: { rows: 5, cols: 5, daemonCount: 3, maxLen: 4, matches: (c) => c === 0, countCap: 0 },
};

const hexToNum = (h: string) => parseInt(h, 16);

function randomHex() {
  return HEX_VALUES[Math.floor(Math.random() * HEX_VALUES.length)];
}

// Number of distinct legal paths that solve all daemons for this grid.
export function countPuzzleSolutions(
  grid: string[][],
  daemons: string[][],
): number {
  const matrix = grid.map((row) => row.map(hexToNum));
  const pattern = combineDaemons(daemons).map(hexToNum);
  return countSolutions(pattern, matrix);
}

// Like countPuzzleSolutions but short-circuits once the count exceeds `cap`
// (returning cap + 1). Used by the generation retry loop so counting stays
// cheap on the larger 6x6 / 7x7 tiers.
export function countPuzzleSolutionsCapped(
  grid: string[][],
  daemons: string[][],
  cap: number,
): number {
  const matrix = grid.map((row) => row.map(hexToNum));
  const pattern = combineDaemons(daemons).map(hexToNum);
  return countSolutions(pattern, matrix, cap);
}

// Map a solution count to a human difficulty bucket (for display / labelling).
export function difficultyFromCount(count: number): Difficulty {
  if (count === 0) return "impossible";
  if (count === 1) return "hard";
  if (count <= 5) return "medium";
  return "easy";
}

function scrambleToImpossible(puzzle: Puzzle) {
  puzzle.path.forEach(({ r, c }, idx) => {
    let val = randomHex();
    if (val === puzzle.solutionSeq[idx]) {
      val = randomHex();
    }
    puzzle.grid[r][c] = val;
  });
  const longestDaemon = Math.max(...puzzle.daemons.map((d) => d.length));
  const maxBuffer = Math.max(longestDaemon, puzzle.solutionSeq.length - 1);
  const minBuffer = longestDaemon;
  const range = maxBuffer - minBuffer;
  puzzle.bufferSize =
    range > 0
      ? Math.floor(Math.random() * (range + 1)) + minBuffer
      : minBuffer;
}

export interface GeneratedPuzzle {
  grid: string[][];
  daemons: string[][];
  bufferSize: number;
  solutionCount: number;
}

function generateForProfile(profile: DifficultyProfile, impossible: boolean): Puzzle {
  const puzzle = generatePuzzle(
    profile.rows,
    profile.cols,
    profile.daemonCount,
    0,
    profile.maxLen,
  );
  if (impossible) scrambleToImpossible(puzzle);
  return puzzle;
}

// Generate a puzzle whose SHAPE and solution count match the requested tier,
// retrying a bounded number of times before falling back. The match test uses
// the capped counter (so it stays fast on the bigger 6x6 / 7x7 boards); the
// returned solutionCount is the true (uncapped) count of the chosen grid. For
// the solvable tiers the fallback prefers any grid that is at least solvable so
// we never hand a player a 6x6 / 7x7 grid with no legal solution.
export function generatePuzzleByDifficulty(
  diff: Difficulty,
  attempts = 60,
): GeneratedPuzzle {
  const profile = DIFFICULTY_PROFILES[diff] ?? DIFFICULTY_PROFILES.medium;
  const impossible = diff === "impossible";
  let solvableFallback: Puzzle | null = null;

  for (let i = 0; i < attempts; i++) {
    const puzzle = generateForProfile(profile, impossible);
    const capped = countPuzzleSolutionsCapped(
      puzzle.grid,
      puzzle.daemons,
      profile.countCap,
    );
    if (profile.matches(capped)) {
      return {
        grid: puzzle.grid,
        daemons: puzzle.daemons,
        bufferSize: puzzle.bufferSize,
        solutionCount: countPuzzleSolutions(puzzle.grid, puzzle.daemons),
      };
    }
    if (!impossible && capped >= 1 && solvableFallback === null) {
      solvableFallback = puzzle;
    }
  }

  // Fallback: a solvable best-effort grid when possible (difficulty
  // approximate), otherwise the last freshly generated grid.
  const puzzle = solvableFallback ?? generateForProfile(profile, impossible);
  return {
    grid: puzzle.grid,
    daemons: puzzle.daemons,
    bufferSize: puzzle.bufferSize,
    solutionCount: countPuzzleSolutions(puzzle.grid, puzzle.daemons),
  };
}

function containsContiguous(arr: string[], subseq: string[]): boolean {
  if (subseq.length === 0) return false;
  for (let i = 0; i <= arr.length - subseq.length; i++) {
    let match = true;
    for (let j = 0; j < subseq.length; j++) {
      if (arr[i + j] !== subseq[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

// Validate that a selection obeys the Breach Protocol movement rules for a grid
// of the given size: first pick is on row 0, then alternate matching the last
// cell's column / row, never repeating a cell, never exceeding the buffer.
export function isValidSelectionPath(
  selection: Pos[],
  rows: number,
  cols: number,
  bufferSize: number,
): boolean {
  if (selection.length === 0) return true;
  if (selection.length > bufferSize) return false;
  const seen = new Set<string>();
  for (let i = 0; i < selection.length; i++) {
    const { r, c } = selection[i];
    if (r < 0 || r >= rows || c < 0 || c >= cols) return false;
    const key = `${r},${c}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (i === 0) {
      if (r !== 0) return false;
    } else {
      const last = selection[i - 1];
      const expectColumn = i % 2 === 1;
      if (expectColumn && c !== last.c) return false;
      if (!expectColumn && r !== last.r) return false;
    }
  }
  return true;
}

export interface ScoreResult {
  valid: boolean;
  solvedDaemons: number[];
  allSolved: boolean;
}

// Authoritatively score a player's final selection against the stored grid and
// daemons. `valid` is false when the path breaks the movement rules.
export function scoreSelection(
  grid: string[][],
  daemons: string[][],
  bufferSize: number,
  selection: Pos[],
): ScoreResult {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const valid = isValidSelectionPath(selection, rows, cols, bufferSize);
  if (!valid) {
    return { valid: false, solvedDaemons: [], allSolved: false };
  }
  const seq = selection.map((p) => grid[p.r][p.c]);
  const solvedDaemons: number[] = [];
  daemons.forEach((daemon, idx) => {
    if (containsContiguous(seq, daemon)) {
      solvedDaemons.push(idx);
    }
  });
  return {
    valid: true,
    solvedDaemons,
    allSolved: solvedDaemons.length === daemons.length && daemons.length > 0,
  };
}

// Find ONE legal solution path (≤ bufferSize picks) that breaches every daemon,
// or null when the grid is unsolvable. Used for the staff preview so a fixer can
// see a worked solution before assigning. Reuses the pattern-guided BFS that
// defines `solutionCount` (the combined-daemon superstring), so it stays fast on
// the larger 6x6 / 7x7 tiers — an exhaustive buffer-depth DFS blows up there.
export function solvePuzzle(
  grid: string[][],
  daemons: string[][],
  bufferSize: number,
): Pos[] | null {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (rows === 0 || cols === 0 || daemons.length === 0) return null;

  const matrix = grid.map((row) => row.map(hexToNum));
  const pattern = combineDaemons(daemons).map(hexToNum);
  const coords = findFirstSolution(pattern, matrix);
  if (!coords) return null;

  const path: Pos[] = coords.map(({ x, y }) => ({ r: y, c: x }));
  // The combined-pattern path is the tightest solution; only return it when it
  // actually fits the buffer and verifiably breaches every daemon.
  if (path.length > bufferSize) return null;
  const score = scoreSelection(grid, daemons, bufferSize, path);
  return score.valid && score.allSolved ? path : null;
}
