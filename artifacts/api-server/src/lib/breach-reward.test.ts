import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { db, breachPuzzles, walletTransactions, inventoryItems, users, botConfig } from "@workspace/db";
import { patchBalance } from "./unbelievaboat";
import { createUser, createAdmin, createCharacter } from "../test/testDb";
import { previewPuzzle, createPuzzle, startPuzzle, submitResult } from "./breach";

const mockPatch = vi.mocked(patchBalance);

beforeEach(() => {
  mockPatch.mockReset();
});

async function setFlag(key: string, value: boolean) {
  await db
    .insert(botConfig)
    .values({ key, value: String(value) })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: String(value) } });
}

async function enableEconomy() {
  await setFlag("economy_enabled", true);
  await setFlag("master_live_mode", true);
  await setFlag("economy_live_mode", true);
}

// Generate a real, solvable puzzle and assign it to the given character's owner.
// Returns the puzzle id and the worked solution path so the test can submit a
// genuine success.
async function assignSolvablePuzzle(
  staff: Awaited<ReturnType<typeof createAdmin>>,
  characterId: number,
  reward: { rewardEddies?: number; rewardItemName?: string | null; rewardItemCategory?: string | null },
) {
  const preview = previewPuzzle(staff, "easy");
  expect(preview.status).toBe(200);
  const body = preview.body as Extract<typeof preview.body, { grid: unknown }>;
  expect(body.solutionPath.length).toBeGreaterThan(0);

  const created = await createPuzzle(staff, {
    assignedCharacterId: characterId,
    difficulty: "easy",
    timeLimitSeconds: 600,
    rewardEddies: reward.rewardEddies,
    rewardItemName: reward.rewardItemName,
    rewardItemCategory: reward.rewardItemCategory,
    puzzle: { grid: body.grid, daemons: body.daemons, bufferSize: body.bufferSize },
  });
  expect(created.status).toBe(201);
  const view = created.body as Extract<typeof created.body, { id: number }>;
  return { id: view.id, solution: body.solutionPath };
}

describe("breach reward settlement (exactly-once with retry)", () => {
  it("does not mark the reward paid when the eddies payout fails, then settles on retry", async () => {
    await enableEconomy();
    const staff = await createAdmin();
    const player = await createUser();
    await db.update(users).set({ walletBalance: 0, lastSyncedUbBalance: 0 }).where(eq(users.id, player.id));
    const character = await createCharacter({ ownerId: player.id });

    const { id, solution } = await assignSolvablePuzzle(staff, character.id, { rewardEddies: 500 });
    await startPuzzle(player, id); // anchor the server-side timer

    // First submit: the UB call fails → success recorded, but reward NOT paid.
    mockPatch.mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof patchBalance>>);
    const first = await submitResult(player, id, solution);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ success: true, rewardPaid: false });

    let [row] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    expect(row.status).toBe("success");
    expect(row.completedAt).not.toBeNull();
    expect(row.rewardPaidAt).toBeNull(); // <- the blocking bug: must NOT be stamped

    const [p1] = await db.select().from(users).where(eq(users.id, player.id));
    expect(p1.walletBalance).toBe(0); // no eddies credited yet

    // Retry submit: UB now succeeds → reward settles exactly once.
    mockPatch.mockResolvedValue({ cash: 500, bank: 0, total: 500, source: "unbelievaboat" });
    const retry = await submitResult(player, id, solution);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ success: true, rewardPaid: true });

    [row] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    expect(row.rewardPaidAt).not.toBeNull();

    const [p2] = await db.select().from(users).where(eq(users.id, player.id));
    expect(p2.walletBalance).toBe(500); // credited exactly once

    // Exactly one synced ledger row for this reward (idempotency key holds).
    const ledger = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, `breach-reward-${id}`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].syncStatus).toBe("synced");

    // A third submit is a pure no-op (already fully paid).
    const third = await submitResult(player, id, solution);
    expect(third.body).toMatchObject({ rewardPaid: false });
    const [p3] = await db.select().from(users).where(eq(users.id, player.id));
    expect(p3.walletBalance).toBe(500);
  });

  it("never double-mints the item reward when only the eddies leg needs a retry", async () => {
    await enableEconomy();
    const staff = await createAdmin();
    const player = await createUser();
    await db.update(users).set({ walletBalance: 0, lastSyncedUbBalance: 0 }).where(eq(users.id, player.id));
    const character = await createCharacter({ ownerId: player.id });

    const { id, solution } = await assignSolvablePuzzle(staff, character.id, {
      rewardEddies: 250,
      rewardItemName: "Militech Falcon",
      rewardItemCategory: "weapon",
    });
    await startPuzzle(player, id);

    // First submit: eddies fail, but the item mints (so something was paid).
    // The reward as a whole stays unsettled because eddies did not land.
    mockPatch.mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof patchBalance>>);
    const first = await submitResult(player, id, solution);
    expect(first.body).toMatchObject({ success: true, rewardPaid: true });

    let [row] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    expect(row.rewardPaidAt).toBeNull();
    expect(row.rewardItemId).not.toBeNull(); // item already minted

    let items = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, character.id));
    expect(items).toHaveLength(1);

    // Retry: eddies succeed; the item must NOT be minted a second time.
    mockPatch.mockResolvedValue({ cash: 250, bank: 0, total: 250, source: "unbelievaboat" });
    const retry = await submitResult(player, id, solution);
    expect(retry.body).toMatchObject({ success: true, rewardPaid: true });

    [row] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    expect(row.rewardPaidAt).not.toBeNull();

    items = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, character.id));
    expect(items).toHaveLength(1); // still exactly one — no duplicate mint

    const [p] = await db.select().from(users).where(eq(users.id, player.id));
    expect(p.walletBalance).toBe(250);
  });
});
