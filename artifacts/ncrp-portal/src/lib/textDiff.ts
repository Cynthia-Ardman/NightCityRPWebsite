// Lightweight, dependency-free text diffing used by the review screens so
// fixers can see WHAT changed instead of eyeballing two full copies of a field.
//
// - diffWords: token-level diff for prose (e.g. a character background). Keeps
//   whitespace as tokens so the reconstructed text is byte-identical.
// - diffLines: line-level diff for structured blobs (e.g. JSON sheet data).
// - collapseContext: hides long runs of unchanged lines (git-style context) so
//   a large JSON only surfaces the changed lines plus a little surrounding context.

export type DiffOp = { type: "equal" | "add" | "remove"; value: string };

// Classic LCS diff over a pair of token arrays. Returns one op per token in
// reading order (equal/remove come from `a`, add comes from `b`).
function computeOps(a: string[], b: string[]): { type: DiffOp["type"]; token: string }[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = length of LCS of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: { type: DiffOp["type"]; token: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", token: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "remove", token: a[i] });
      i++;
    } else {
      ops.push({ type: "add", token: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "remove", token: a[i++] });
  while (j < m) ops.push({ type: "add", token: b[j++] });
  return ops;
}

// Merge consecutive same-type tokens into a single op, re-joining with `joiner`.
function merge(ops: { type: DiffOp["type"]; token: string }[], joiner: string): DiffOp[] {
  const out: DiffOp[] = [];
  for (const o of ops) {
    const last = out[out.length - 1];
    if (last && last.type === o.type) {
      last.value += joiner + o.token;
    } else {
      out.push({ type: o.type, value: o.token });
    }
  }
  return out;
}

function wordTokens(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}
function lineTokens(s: string): string[] {
  return s.split("\n");
}

// The LCS table is O(n*m) in time and memory; above this many cells we'd risk
// stalling the review page, so callers should fall back to a plain render.
export const MAX_DIFF_CELLS = 1_500_000;

// True when an LCS diff of these two values stays within the cell budget.
export function isDiffSafe(before: string, after: string, mode: "words" | "lines"): boolean {
  const tok = mode === "words" ? wordTokens : lineTokens;
  return tok(before).length * tok(after).length <= MAX_DIFF_CELLS;
}

// Word/whitespace-level diff. Splitting on a captured whitespace group keeps the
// separators as their own tokens so equal runs reproduce the original spacing.
export function diffWords(before: string, after: string): DiffOp[] {
  return merge(computeOps(wordTokens(before), wordTokens(after)), "");
}

// Line-level diff. Each returned op holds exactly one line so callers can render
// per-line +/- gutters; runs are not merged.
export function diffLines(before: string, after: string): DiffOp[] {
  return computeOps(lineTokens(before), lineTokens(after)).map((o) => ({ type: o.type, value: o.token }));
}

// Multiset add/removed for two string lists (used for image-URL galleries).
// Frequency-based so a duplicate that is dropped/added is counted correctly,
// unlike a set-difference which would hide multiplicity changes.
export function multisetDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const count = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const b = count(before);
  const a = count(after);
  const removed: string[] = [];
  const added: string[] = [];
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    const delta = (a.get(key) ?? 0) - (b.get(key) ?? 0);
    for (let i = 0; i < -delta; i++) removed.push(key);
    for (let i = 0; i < delta; i++) added.push(key);
  }
  return { added, removed };
}

export type ContextRow = DiffOp | { type: "gap"; count: number };

// Collapse long stretches of unchanged lines, keeping `context` lines on either
// side of every change. Dropped runs become a single { type: "gap", count } row.
export function collapseContext(ops: DiffOp[], context = 3): ContextRow[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "equal") {
      for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
        keep[k] = true;
      }
    }
  }
  const rows: ContextRow[] = [];
  let i = 0;
  while (i < ops.length) {
    if (keep[i]) {
      rows.push(ops[i]);
      i++;
    } else {
      let count = 0;
      while (i < ops.length && !keep[i]) {
        count++;
        i++;
      }
      rows.push({ type: "gap", count });
    }
  }
  return rows;
}
