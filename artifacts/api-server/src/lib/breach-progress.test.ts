import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

// Discord is best-effort (DMs the play link / staff result) — stub it so tests
// never touch the network.
vi.mock("./discord", async (orig) => {
  const actual = await orig<typeof import("./discord")>();
  return {
    ...actual,
    sendDirectMessage: vi.fn().mockResolvedValue(undefined),
    postToChannel: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("./unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));

import { db, breachPuzzles } from "@workspace/db";
import { createUser, createAdmin, createCharacter } from "../test/testDb";
import { previewPuzzle, createPuzzle, startPuzzle, reportProgress, submitResult } from "./breach";
import type { Pos } from "@workspace/breach";

// Assign a real puzzle to the character's owner and return its id + solution.
async function assignPuzzle(
  staff: Awaited<ReturnType<typeof createAdmin>>,
  characterId: number,
  timeLimitSeconds = 600,
) {
  const preview = previewPuzzle(staff, "easy");
  expect(preview.status).toBe(200);
  const body = preview.body as Extract<typeof preview.body, { grid: unknown }>;
  const created = await createPuzzle(staff, {
    assignedCharacterId: characterId,
    difficulty: "easy",
    timeLimitSeconds,
    puzzle: { grid: body.grid, daemons: body.daemons, bufferSize: body.bufferSize },
  });
  expect(created.status).toBe(201);
  const view = created.body as Extract<typeof created.body, { id: number }>;
  return { id: view.id, solution: body.solutionPath, bufferSize: body.bufferSize };
}

async function storedSelection(id: number): Promise<Pos[] | null> {
  const [row] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
  return (row?.selection as Pos[] | null) ?? null;
}

describe("breach live progress reporting", () => {
  it("404s for a missing puzzle and 403s for a non-assigned user", async () => {
    const staff = await createAdmin();
    const player = await createUser();
    const other = await createUser();
    const character = await createCharacter({ ownerId: player.id });
    const { id } = await assignPuzzle(staff, character.id);
    await startPuzzle(player, id);

    const missing = await reportProgress(player, 9_999_999, [{ r: 0, c: 0 }]);
    expect(missing.status).toBe(404);

    const forbidden = await reportProgress(other, id, [{ r: 0, c: 0 }]);
    expect(forbidden.status).toBe(403);
    // Staff are not exempt: only the assigned player may write progress.
    const staffTry = await reportProgress(staff, id, [{ r: 0, c: 0 }]);
    expect(staffTry.status).toBe(403);
  });

  it("rejects (accepted:false) before start, and accepts monotonic growth only", async () => {
    const staff = await createAdmin();
    const player = await createUser();
    const character = await createCharacter({ ownerId: player.id });
    const { id } = await assignPuzzle(staff, character.id);

    // Not started yet → acknowledged but not accepted.
    const early = await reportProgress(player, id, [{ r: 0, c: 0 }]);
    expect(early.status).toBe(200);
    expect((early.body as { accepted: boolean }).accepted).toBe(false);

    await startPuzzle(player, id);

    const one = await reportProgress(player, id, [{ r: 0, c: 0 }]);
    expect((one.body as { accepted: boolean }).accepted).toBe(true);
    const two = await reportProgress(player, id, [{ r: 0, c: 0 }, { r: 1, c: 0 }]);
    expect((two.body as { accepted: boolean }).accepted).toBe(true);
    expect(await storedSelection(id)).toEqual([{ r: 0, c: 0 }, { r: 1, c: 0 }]);

    // A stale shorter report never overwrites a longer one.
    const stale = await reportProgress(player, id, [{ r: 2, c: 2 }]);
    expect((stale.body as { accepted: boolean }).accepted).toBe(false);
    expect(await storedSelection(id)).toEqual([{ r: 0, c: 0 }, { r: 1, c: 0 }]);
  });

  it("rejects malformed, empty, and over-buffer selections without erroring", async () => {
    const staff = await createAdmin();
    const player = await createUser();
    const character = await createCharacter({ ownerId: player.id });
    const { id, bufferSize } = await assignPuzzle(staff, character.id);
    await startPuzzle(player, id);

    for (const bad of [
      null,
      "nope",
      [],
      [{ r: "x", c: 0 }],
      [{ r: 0.5, c: 1 }],
      Array.from({ length: bufferSize + 1 }, (_, i) => ({ r: 0, c: i })),
    ]) {
      const res = await reportProgress(player, id, bad);
      expect(res.status).toBe(200);
      expect((res.body as { accepted: boolean }).accepted).toBe(false);
    }
    expect(await storedSelection(id)).toBeNull();
  });

  it("stops accepting after completion and after the time window", async () => {
    const staff = await createAdmin();
    const player = await createUser();
    const character = await createCharacter({ ownerId: player.id });
    const { id, solution } = await assignPuzzle(staff, character.id);
    await startPuzzle(player, id);

    const done = await submitResult(player, id, solution);
    expect(done.status).toBe(200);

    // Completed → no more progress writes (even longer ones).
    const after = await reportProgress(player, id, [...solution, { r: 0, c: 0 }].slice(0, solution.length));
    expect((after.body as { accepted: boolean }).accepted).toBe(false);

    // Timed-out run: backdate startedAt beyond the limit + grace.
    const { id: id2 } = await assignPuzzle(staff, character.id, 10);
    await startPuzzle(player, id2);
    await db
      .update(breachPuzzles)
      .set({ startedAt: new Date(Date.now() - 60_000) })
      .where(eq(breachPuzzles.id, id2));
    const late = await reportProgress(player, id2, [{ r: 0, c: 0 }]);
    expect(late.status).toBe(200);
    expect((late.body as { accepted: boolean }).accepted).toBe(false);
  });
});
