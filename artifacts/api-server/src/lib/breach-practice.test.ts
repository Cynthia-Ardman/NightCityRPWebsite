import { describe, it, expect } from "vitest";

import { createUser } from "../test/testDb";
import {
  getPracticeStats,
  recordPracticeAttempt,
  mergePracticeStats,
  clearPracticeStats,
  type PracticeStatsView,
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
    expect(stats.impossible).toEqual({ attempts: 0, solves: 0, fastestClearMs: null });
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
});
