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
// UnbelievaBoat is never called synchronously on the reward path under the
// website-first model — mocked defensively so any regression that reintroduces
// a synchronous call fails loudly instead of hitting the network.
vi.mock("./unbelievaboat", () => ({
  getBalance: vi.fn(),
  patchBalance: vi.fn(),
}));

import {
  db,
  breachPuzzles,
  walletTransactions,
  inventoryItems,
  users,
  botConfig,
  ubPushOutbox,
} from "@workspace/db";
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

// Website-first economy: the wallet is the source of truth. applyWalletDelta
// commits the credit locally (ledger row syncStatus "synced") and enqueues the
// UnbelievaBoat mirror push onto ub_push_outbox — it never calls patchBalance
// synchronously, so a reward settles on the FIRST successful submit.
describe("breach reward settlement (exactly-once)", () => {
  it("settles the eddies reward locally on first submit and never double-credits", async () => {
    await enableEconomy();
    const staff = await createAdmin();
    const player = await createUser();
    await db.update(users).set({ walletBalance: 0, lastSyncedUbBalance: 0 }).where(eq(users.id, player.id));
    const character = await createCharacter({ ownerId: player.id });

    const { id, solution } = await assignSolvablePuzzle(staff, character.id, { rewardEddies: 500 });
    await startPuzzle(player, id); // anchor the server-side timer

    // First submit: reward settles locally, immediately.
    const first = await submitResult(player, id, solution);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ success: true, rewardPaid: true });

    let [row] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    expect(row.status).toBe("success");
    expect(row.completedAt).not.toBeNull();
    expect(row.rewardPaidAt).not.toBeNull(); // settled on first submit
    expect(row.rewardLedgerId).not.toBeNull();

    const [p1] = await db.select().from(users).where(eq(users.id, player.id));
    expect(p1.walletBalance).toBe(500); // credited exactly once, locally

    // Exactly one synced ledger row for this reward (idempotency key holds).
    const ledger = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, `breach-reward-${id}`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].syncStatus).toBe("synced");

    // UB mirroring happens via the outbox, not a synchronous patchBalance call.
    const outbox = await db.select().from(ubPushOutbox).where(eq(ubPushOutbox.userId, player.id));
    expect(outbox.length).toBeGreaterThanOrEqual(1);
    expect(mockPatch).not.toHaveBeenCalled();

    // A second submit is a pure no-op (already fully paid): no new payout, no
    // second credit, still exactly one ledger row.
    const second = await submitResult(player, id, solution);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ rewardPaid: false });

    [row] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    expect(row.rewardPaidAt).not.toBeNull();

    const [p2] = await db.select().from(users).where(eq(users.id, player.id));
    expect(p2.walletBalance).toBe(500);

    const ledgerAfter = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, `breach-reward-${id}`));
    expect(ledgerAfter).toHaveLength(1);
  });

  it("mints the item reward exactly once alongside the eddies", async () => {
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

    // First submit: both legs (eddies + item) settle immediately.
    const first = await submitResult(player, id, solution);
    expect(first.body).toMatchObject({ success: true, rewardPaid: true });

    let [row] = await db.select().from(breachPuzzles).where(eq(breachPuzzles.id, id));
    expect(row.rewardPaidAt).not.toBeNull();
    expect(row.rewardItemId).not.toBeNull();
    expect(row.rewardLedgerId).not.toBeNull();

    let items = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, character.id));
    expect(items).toHaveLength(1);

    // Re-submit: the item must NOT be minted a second time, and no second
    // credit lands.
    const second = await submitResult(player, id, solution);
    expect(second.body).toMatchObject({ rewardPaid: false });

    items = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, character.id));
    expect(items).toHaveLength(1); // still exactly one — no duplicate mint

    const [p] = await db.select().from(users).where(eq(users.id, player.id));
    expect(p.walletBalance).toBe(250);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
