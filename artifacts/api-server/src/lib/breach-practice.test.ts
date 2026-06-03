import { describe, it, expect } from "vitest";
import { db, breachPracticeStats } from "@workspace/db";

import { createUser } from "../test/testDb";
import {
  getPracticeStats,
  recordPracticeAttempt,
  mergePracticeStats,
  clearPracticeStats,
  getPracticeLeaderboard,
  type PracticeStatsView,
  type PracticeLeaderboardView,
} from "./breach";

function ok(result: { status: number; body: unknown }): PracticeStatsView {
  expect(result.status).toBe(200);
  return result.body as PracticeStatsView;
}

describe("breach practice stats (opt-in account sync)", () => {
  it("starts empty for a fresh user", async () => {
    const user = await createUser();
    const stats = ok(await getPracticeStats(user));
    expect(stats.easy).toEqual({ attempts: 0, solves: 0, fastestClearMs: null });
    expect(stats.hard).toEqual({ attempts: 0, solves: 0, fastestClearMs: null });
  });

  it("records attempts and keeps the fastest clear", async () => {
    const user = await createUser();
    await recordPracticeAttempt(user, "easy", true, 5000);
    await recordPracticeAttempt(user, "easy", false, 9999); // failed: no clear time
    const after = ok(await recordPracticeAttempt(user, "easy", true, 3000));
    expect(after.easy.attempts).toBe(3);
    expect(after.easy.solves).toBe(2);
    expect(after.easy.fastestClearMs).toBe(3000); // best of 5000 / 3000
  });

  it("a slower later solve does not worsen the fastest clear", async () => {
    const user = await createUser();
    await recordPracticeAttempt(user, "hard", true, 2000);
    const after = ok(await recordPracticeAttempt(user, "hard", true, 8000));
    expect(after.hard.fastestClearMs).toBe(2000);
    expect(after.hard.solves).toBe(2);
  });

  it("rejects an invalid difficulty", async () => {
    const user = await createUser();
    const res = await recordPracticeAttempt(user, "trivial", true, 1000);
    expect(res.status).toBe(400);
  });

  it("clamps solves to attempts and ignores garbage on merge", async () => {
    const user = await createUser();
    const merged = ok(
      await mergePracticeStats(user, {
        easy: { attempts: 2, solves: 99, fastestClearMs: 4000 }, // solves > attempts
        medium: { attempts: "x", solves: -3, fastestClearMs: -1 }, // garbage
      }),
    );
    expect(merged.easy.attempts).toBe(2);
    expect(merged.easy.solves).toBe(2); // clamped to attempts
    expect(merged.easy.fastestClearMs).toBe(4000);
    expect(merged.medium).toEqual({ attempts: 0, solves: 0, fastestClearMs: null });
  });

  it("merge folds local stats into existing account stats keeping the better clear", async () => {
    const user = await createUser();
    // Existing account progress.
    await recordPracticeAttempt(user, "easy", true, 6000);
    // First-sync merge of a browser snapshot with a better clear.
    const merged = ok(
      await mergePracticeStats(user, {
        easy: { attempts: 4, solves: 3, fastestClearMs: 2500 },
        medium: { attempts: 1, solves: 0, fastestClearMs: null },
      }),
    );
    expect(merged.easy.attempts).toBe(5); // 1 + 4
    expect(merged.easy.solves).toBe(4); // 1 + 3
    expect(merged.easy.fastestClearMs).toBe(2500); // min(6000, 2500)
    expect(merged.medium.attempts).toBe(1);
  });

  it("clear resets the account stats", async () => {
    const user = await createUser();
    await recordPracticeAttempt(user, "medium", true, 4000);
    const cleared = ok(await clearPracticeStats(user));
    expect(cleared.medium).toEqual({ attempts: 0, solves: 0, fastestClearMs: null });
    const reread = ok(await getPracticeStats(user));
    expect(reread.medium.attempts).toBe(0);
  });

  it("keeps each user's stats isolated", async () => {
    const a = await createUser();
    const b = await createUser();
    await recordPracticeAttempt(a, "easy", true, 1000);
    const bStats = ok(await getPracticeStats(b));
    expect(bStats.easy.attempts).toBe(0);
  });

  it("ignores legacy 'impossible' rows in practice stats", async () => {
    const user = await createUser();
    // Seed a pre-removal row directly — practice no longer accepts this difficulty.
    await db.insert(breachPracticeStats).values({
      userId: user.id,
      difficulty: "impossible",
      attempts: 7,
      solves: 4,
      fastestClearMs: 1234,
    });
    const stats = ok(await getPracticeStats(user));
    expect(Object.keys(stats).sort()).toEqual([
      "easy",
      "hard",
      "medium",
      "nightmare",
      "very_hard",
    ]);
    expect((stats as Record<string, unknown>).impossible).toBeUndefined();
  });
});

function board(result: { status: number; body: unknown }): PracticeLeaderboardView {
  expect(result.status).toBe(200);
  return result.body as PracticeLeaderboardView;
}

describe("breach practice leaderboard", () => {
  it("ranks individual clear runs per difficulty and excludes non-solvers", async () => {
    const fast = await createUser({ username: "fast_runner" });
    const slow = await createUser({ username: "slow_runner" });
    const failer = await createUser({ username: "never_solved" });

    await recordPracticeAttempt(fast, "hard", true, 2000);
    await recordPracticeAttempt(slow, "hard", true, 5000);
    await recordPracticeAttempt(failer, "hard", false, 9999); // no clear time

    const lb = board(await getPracticeLeaderboard());
    expect(lb.hard.map((e) => e.username)).toEqual(["fast_runner", "slow_runner"]);
    expect(lb.hard[0].clearMs).toBe(2000);
    expect(lb.hard[1].clearMs).toBe(5000);
    // A run that was never solved is not recorded and never ranks.
    expect(lb.hard.some((e) => e.username === "never_solved")).toBe(false);
    // Other difficulties stay empty when nobody has a clear there.
    expect(lb.easy).toEqual([]);
  });

  it("lets one player hold multiple slots, ordered by run time", async () => {
    const ace = await createUser({ username: "ace" });
    await recordPracticeAttempt(ace, "hard", true, 3000);
    await recordPracticeAttempt(ace, "hard", true, 1000);
    await recordPracticeAttempt(ace, "hard", true, 2000);

    const lb = board(await getPracticeLeaderboard());
    // Every winning run gets its own slot — no per-user dedup.
    expect(lb.hard).toHaveLength(3);
    expect(lb.hard.every((e) => e.username === "ace")).toBe(true);
    expect(lb.hard.map((e) => e.clearMs)).toEqual([1000, 2000, 3000]);
    // Ids are unique so the UI has a stable key even with repeated users.
    expect(new Set(lb.hard.map((e) => e.id)).size).toBe(3);
  });

  it("breaks equal-time ties by earliest achieved", async () => {
    const first = await createUser({ username: "first_in" });
    const second = await createUser({ username: "second_in" });
    // Same time; the run recorded earlier should rank ahead.
    await recordPracticeAttempt(first, "medium", true, 3000);
    await recordPracticeAttempt(second, "medium", true, 3000);

    const lb = board(await getPracticeLeaderboard());
    const tied = lb.medium.filter((e) => e.clearMs === 3000);
    expect(tied.map((e) => e.username)).toEqual(["first_in", "second_in"]);
  });

  it("caps each difficulty at the top 10 runs", async () => {
    const grinder = await createUser({ username: "grinder" });
    // 12 distinct clear times; only the 10 fastest should appear.
    for (let i = 1; i <= 12; i++) {
      await recordPracticeAttempt(grinder, "easy", true, i * 1000);
    }
    const lb = board(await getPracticeLeaderboard());
    expect(lb.easy).toHaveLength(10);
    expect(lb.easy[0].clearMs).toBe(1000);
    expect(lb.easy[9].clearMs).toBe(10000);
    // The two slowest runs are dropped.
    expect(lb.easy.some((e) => e.clearMs > 10000)).toBe(false);
  });

  it("does not duplicate the seeded run when the same snapshot is merged again", async () => {
    const resyncer = await createUser({ username: "resyncer" });
    const snapshot = { hard: { attempts: 3, solves: 2, fastestClearMs: 2500 } };
    await mergePracticeStats(resyncer, snapshot);
    await mergePracticeStats(resyncer, snapshot); // replay (retry / stale local copy)

    const lb = board(await getPracticeLeaderboard());
    const mine = lb.hard.filter((e) => e.username === "resyncer");
    expect(mine).toHaveLength(1);
    expect(mine[0].clearMs).toBe(2500);
  });

  it("reset empties the player's leaderboard runs", async () => {
    const quitter = await createUser({ username: "quitter" });
    await recordPracticeAttempt(quitter, "medium", true, 2000);
    await recordPracticeAttempt(quitter, "medium", true, 4000);
    expect(board(await getPracticeLeaderboard()).medium).toHaveLength(2);

    await clearPracticeStats(quitter);
    expect(board(await getPracticeLeaderboard()).medium).toEqual([]);
  });
});
