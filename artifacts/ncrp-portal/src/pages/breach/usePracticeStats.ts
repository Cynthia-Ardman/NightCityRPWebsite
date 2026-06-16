import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBreachPracticeStats,
  useRecordBreachPracticeAttempt,
  useMergeBreachPracticeStats,
  useClearBreachPracticeStats,
  getGetBreachPracticeStatsQueryKey,
} from "@workspace/api-client-react";
import type { PracticeDifficulty } from "@workspace/breach";
import { useAuthMe } from "@/hooks/useAuthMe";
import {
  loadStats,
  recordAttempt as recordLocalAttempt,
  clearStats as clearLocalStats,
  type PracticeStats,
} from "./breachPracticeStats";

// Per-browser opt-in preference: when set, a logged-in player mirrors their own
// practice stats to their account so they follow them across devices. The
// practice page itself stays "not recorded" — this is purely personal progress.
const SYNC_FLAG_KEY = "ncrp-breach-practice-sync-v1";

function readSyncFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SYNC_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSyncFlag(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (on) window.localStorage.setItem(SYNC_FLAG_KEY, "1");
    else window.localStorage.removeItem(SYNC_FLAG_KEY);
  } catch {
    // Best-effort only.
  }
}

export type UsePracticeStats = {
  stats: PracticeStats;
  // True when the viewer is logged in and can therefore opt into account sync.
  canSync: boolean;
  // True when stats are currently mirrored to the account.
  synced: boolean;
  // True while the first-sync merge is in flight.
  syncBusy: boolean;
  recordAttempt: (
    difficulty: PracticeDifficulty,
    success: boolean,
    elapsedMs: number,
    scored?: { grid: string[][]; daemons: string[][]; bufferSize: number; selection: Array<{ r: number; c: number }> },
  ) => void;
  resetStats: () => void;
  enableSync: () => Promise<void>;
  disableSync: () => void;
};

export function usePracticeStats(): UsePracticeStats {
  const me = useAuthMe();
  const canSync = !!me.data && !me.isError;
  const qc = useQueryClient();

  const [syncEnabled, setSyncEnabled] = useState<boolean>(() => readSyncFlag());
  const [localStats, setLocalStats] = useState<PracticeStats>(() => loadStats());

  const synced = canSync && syncEnabled;

  const statsQuery = useGetBreachPracticeStats({
    query: {
      queryKey: getGetBreachPracticeStatsQueryKey(),
      enabled: synced,
      staleTime: 30_000,
    },
  });

  const recordMut = useRecordBreachPracticeAttempt();
  const mergeMut = useMergeBreachPracticeStats();
  const clearMut = useClearBreachPracticeStats();

  // Server is the source of truth while synced; otherwise the browser copy.
  const stats: PracticeStats =
    synced && statsQuery.data ? (statsQuery.data as PracticeStats) : localStats;

  const recordAttempt = useCallback(
    (
      difficulty: PracticeDifficulty,
      success: boolean,
      elapsedMs: number,
      // Puzzle + final selection let the SERVER re-score a synced attempt
      // authoritatively (the client `success` is not trusted for the account
      // leaderboard). The local-only path still uses the client result.
      scored?: { grid: string[][]; daemons: string[][]; bufferSize: number; selection: Array<{ r: number; c: number }> },
    ) => {
      if (synced) {
        recordMut.mutate(
          {
            data: {
              difficulty,
              success,
              elapsedMs,
              ...(scored
                ? {
                    puzzle: { grid: scored.grid, daemons: scored.daemons, bufferSize: scored.bufferSize },
                    selection: scored.selection,
                  }
                : {}),
            },
          },
          {
            onSuccess: (updated) => {
              qc.setQueryData(getGetBreachPracticeStatsQueryKey(), updated);
            },
            onError: () => {
              // Network/auth hiccup — never break practice; fall back to local.
              setLocalStats(recordLocalAttempt(difficulty, success, elapsedMs));
            },
          },
        );
        return;
      }
      setLocalStats(recordLocalAttempt(difficulty, success, elapsedMs));
    },
    [synced, recordMut, qc],
  );

  const resetStats = useCallback(() => {
    if (synced) {
      clearMut.mutate(undefined, {
        onSuccess: (cleared) => {
          qc.setQueryData(getGetBreachPracticeStatsQueryKey(), cleared);
        },
      });
      return;
    }
    setLocalStats(clearLocalStats());
  }, [synced, clearMut, qc]);

  const enableSync = useCallback(async () => {
    if (!canSync) return;
    // Fold whatever is in this browser into the account once, then drop the
    // local snapshot so a later re-enable can't double-count the same history.
    const local = loadStats();
    const merged = await mergeMut.mutateAsync({ data: { stats: local } });
    qc.setQueryData(getGetBreachPracticeStatsQueryKey(), merged);
    setLocalStats(clearLocalStats());
    writeSyncFlag(true);
    setSyncEnabled(true);
  }, [canSync, mergeMut, qc]);

  const disableSync = useCallback(() => {
    writeSyncFlag(false);
    setSyncEnabled(false);
    // Return to whatever local-only progress exists on this browser.
    setLocalStats(loadStats());
  }, []);

  return {
    stats,
    canSync,
    synced,
    syncBusy: mergeMut.isPending,
    recordAttempt,
    resetStats,
    enableSync,
    disableSync,
  };
}
