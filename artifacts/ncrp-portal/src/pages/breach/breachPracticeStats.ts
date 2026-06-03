import { PRACTICE_DIFFICULTIES, type PracticeDifficulty } from "@workspace/breach";

// Local-only practice progress. This NEVER touches the server, the economy, or
// any reward path — it lives purely in the player's browser so the practice
// page's "not recorded" contract stays intact.

export type DifficultyStats = {
  attempts: number;
  solves: number;
  fastestClearMs: number | null;
};

export type PracticeStats = Record<PracticeDifficulty, DifficultyStats>;

const STORAGE_KEY = "ncrp-breach-practice-stats-v1";

const DIFFICULTIES: PracticeDifficulty[] = PRACTICE_DIFFICULTIES;

function emptyDifficultyStats(): DifficultyStats {
  return { attempts: 0, solves: 0, fastestClearMs: null };
}

export function emptyStats(): PracticeStats {
  return {
    easy: emptyDifficultyStats(),
    medium: emptyDifficultyStats(),
    hard: emptyDifficultyStats(),
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function normalizeDifficulty(raw: unknown): DifficultyStats {
  const base = emptyDifficultyStats();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  if (isFiniteNumber(r.attempts) && r.attempts >= 0) base.attempts = Math.floor(r.attempts);
  if (isFiniteNumber(r.solves) && r.solves >= 0) base.solves = Math.floor(r.solves);
  if (isFiniteNumber(r.fastestClearMs) && r.fastestClearMs >= 0) {
    base.fastestClearMs = Math.floor(r.fastestClearMs);
  }
  // Guard against corrupt data where solves exceeds attempts.
  if (base.solves > base.attempts) base.solves = base.attempts;
  return base;
}

export function loadStats(): PracticeStats {
  const stats = emptyStats();
  if (typeof window === "undefined") return stats;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return stats;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const d of DIFFICULTIES) {
      stats[d] = normalizeDifficulty(parsed[d]);
    }
  } catch {
    // Corrupt or unavailable storage — fall back to a clean slate.
  }
  return stats;
}

function saveStats(stats: PracticeStats) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // Ignore quota/availability errors — stats are best-effort only.
  }
}

export function recordAttempt(
  difficulty: PracticeDifficulty,
  success: boolean,
  elapsedMs: number,
): PracticeStats {
  const stats = loadStats();
  const cur = stats[difficulty];
  cur.attempts += 1;
  if (success) {
    cur.solves += 1;
    const clamped = Math.max(0, Math.floor(elapsedMs));
    if (cur.fastestClearMs === null || clamped < cur.fastestClearMs) {
      cur.fastestClearMs = clamped;
    }
  }
  saveStats(stats);
  return stats;
}

export function clearStats(): PracticeStats {
  const stats = emptyStats();
  saveStats(stats);
  return stats;
}

export function formatClearTime(ms: number | null): string {
  if (ms === null) return "—";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.floor(totalSeconds % 60);
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

export function winRate(stats: DifficultyStats): string {
  if (stats.attempts === 0) return "—";
  return `${Math.round((stats.solves / stats.attempts) * 100)}%`;
}
