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
import { countSolutions } from "./bruteCounter";

export type Difficulty = "easy" | "medium" | "hard" | "impossible";

export const DIFFICULTIES: Difficulty[] = [
  "easy",
  "medium",
  "hard",
  "impossible",
];

// Difficulties offered on the (unrecorded) practice page and its leaderboard.
// "impossible" generates an intentionally unsolvable grid, which makes no sense
// to practice or rank, so it is excluded here while remaining available to
// staff for assigned puzzles.
export type PracticeDifficulty = "easy" | "medium" | "hard";

export const PRACTICE_DIFFICULTIES: PracticeDifficulty[] = [
  "easy",
  "medium",
  "hard",
];

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

// Map a solution count to a human difficulty bucket (for display / labelling).
export function difficultyFromCount(count: number): Difficulty {
  if (count === 0) return "impossible";
  if (count === 1) return "hard";
  if (count <= 5) return "medium";
  return "easy";
}

function matchesDifficulty(count: number, diff: Difficulty): boolean {
  switch (diff) {
    case "easy":
      return count > 5;
    case "medium":
      return count >= 2 && count <= 5;
    case "hard":
      return count === 1;
    case "impossible":
      return count === 0;
  }
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

// Generate a puzzle whose solution count matches the requested difficulty,
// retrying a bounded number of times before falling back to a best-effort grid.
export function generatePuzzleByDifficulty(
  diff: Difficulty,
  attempts = 60,
): GeneratedPuzzle {
  for (let i = 0; i < attempts; i++) {
    const puzzle = generatePuzzle();
    if (diff === "impossible") {
      scrambleToImpossible(puzzle);
    }
    const solutionCount = countPuzzleSolutions(puzzle.grid, puzzle.daemons);
    if (matchesDifficulty(solutionCount, diff)) {
      return {
        grid: puzzle.grid,
        daemons: puzzle.daemons,
        bufferSize: puzzle.bufferSize,
        solutionCount,
      };
    }
  }
  // Fallback: best-effort puzzle (still valid, difficulty approximate).
  const puzzle = generatePuzzle();
  if (diff === "impossible") {
    scrambleToImpossible(puzzle);
  }
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
// see a worked solution before assigning. DFS over the movement rules, pruned by
// the buffer cap; grids are small so this terminates quickly.
export function solvePuzzle(
  grid: string[][],
  daemons: string[][],
  bufferSize: number,
): Pos[] | null {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (rows === 0 || cols === 0 || daemons.length === 0) return null;

  const used = new Set<string>();
  const path: Pos[] = [];

  const dfs = (): Pos[] | null => {
    const score = scoreSelection(grid, daemons, bufferSize, path);
    if (score.valid && score.allSolved) return path.slice();
    if (path.length >= bufferSize) return null;

    const idx = path.length;
    const candidates: Pos[] = [];
    if (idx === 0) {
      for (let c = 0; c < cols; c++) candidates.push({ r: 0, c });
    } else {
      const last = path[idx - 1];
      const expectColumn = idx % 2 === 1;
      if (expectColumn) {
        for (let r = 0; r < rows; r++) candidates.push({ r, c: last.c });
      } else {
        for (let c = 0; c < cols; c++) candidates.push({ r: last.r, c });
      }
    }
    for (const cell of candidates) {
      const key = `${cell.r},${cell.c}`;
      if (used.has(key)) continue;
      used.add(key);
      path.push(cell);
      const found = dfs();
      if (found) return found;
      path.pop();
      used.delete(key);
    }
    return null;
  };

  return dfs();
}
