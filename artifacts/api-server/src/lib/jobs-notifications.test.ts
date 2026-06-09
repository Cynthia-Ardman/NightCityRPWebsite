import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("./unbelievaboat", () => ({
  patchBalance: vi.fn(),
  getBalance: vi.fn(),
}));

// Keep the real discord module but spy on the DM sender. The real
// sendDirectMessage no-ops outside a deployment (no bot token), so spying lets
// us assert the auto-charge notification is wired without sending anything.
vi.mock("./discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discord")>();
  return { ...actual, sendDirectMessage: vi.fn(async () => "dm-channel-id") };
});

import { db, botConfig, inventoryItems, walletTransactions, characters } from "@workspace/db";
import { patchBalance } from "./unbelievaboat";
import { sendDirectMessage } from "./discord";
import { runJob } from "./jobs";
import { LIVE_MODE_KEYS } from "./liveMode";
import { createUser, createCharacter } from "../test/testDb";

const mockPatch = vi.mocked(patchBalance);
const mockDm = vi.mocked(sendDirectMessage);

async function setLive(key: string): Promise<void> {
  await db
    .insert(botConfig)
    .values({ key, value: true as never })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: true as never } });
}

beforeEach(async () => {
  mockPatch.mockReset();
  mockDm.mockReset();
  mockDm.mockResolvedValue("dm-channel-id");
  await setLive(LIVE_MODE_KEYS.master);
  await setLive(LIVE_MODE_KEYS.cyberware);
});

async function addChrome(characterId: number, ownerId: string, cwp: number) {
  await db.insert(inventoryItems).values({
    characterId,
    ownerId,
    name: "Sandevistan",
    category: "cyberware",
    quantity: 1,
    notes: `CWP ${cwp}`,
  });
}

// A character's createdAt counts as an implicit initial ripperdoc checkup, so a
// brand-new chromed PC is inside the grace window and skipped. Age it past the
// 7-day window so the meds charge (and its DM) actually fires.
async function backdateCreation(characterId: number, days = 30): Promise<void> {
  await db
    .update(characters)
    .set({ createdAt: new Date(Date.now() - days * 86_400_000) })
    .where(eq(characters.id, characterId));
}

describe("auto-charge DM notifications (cyberware_humanity meds)", () => {
  it("DMs the player after a successful meds charge", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await addChrome(char.id, owner.id, 8); // medium band -> a charge is due
    await backdateCreation(char.id);
    mockPatch.mockResolvedValue({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });

    await runJob("cyberware_humanity");

    // The charge landed...
    const meds = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.kind, "meds"));
    expect(meds).toHaveLength(1);

    // ...and the player was notified exactly once, addressed by their discordId.
    expect(mockDm).toHaveBeenCalledTimes(1);
    expect(mockDm.mock.calls[0][0]).toBe(owner.discordId);
    expect(String(mockDm.mock.calls[0][1])).toContain("Automatic charge");
  });

  it("does NOT DM when the wallet debit fails (no money moved)", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await addChrome(char.id, owner.id, 8);
    // Backdate past the grace window so a charge is actually ATTEMPTED — otherwise
    // the char is skipped and this test would pass vacuously (no charge, no DM)
    // without ever exercising the debit-failure path.
    await backdateCreation(char.id);
    mockPatch.mockResolvedValue(null); // UB debit fails

    await runJob("cyberware_humanity");

    // The debit was genuinely attempted (proving we hit the failure branch)...
    expect(mockPatch).toHaveBeenCalled();
    // ...but with no money moved there is no ledger row and, crucially, no
    // misleading "you were charged" DM.
    const meds = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.kind, "meds"));
    expect(meds).toHaveLength(0);
    expect(mockDm).not.toHaveBeenCalled();
  });

  it("does not block the billing job on DM delivery (fire-and-forget)", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await addChrome(char.id, owner.id, 8);
    await backdateCreation(char.id);
    mockPatch.mockResolvedValue({ cash: 1000, bank: 0, total: 1000, source: "unbelievaboat" });
    // DM delivery hangs forever. The charge must still commit and the job must
    // still return — if the job ever awaited the DM, this test would time out,
    // proving the notification is fire-and-forget (void notifyAutoCharge(...)).
    mockDm.mockReturnValue(new Promise<string>(() => {}));

    const result = await runJob("cyberware_humanity");

    expect(result.status).toBe("succeeded");
    const meds = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.kind, "meds"));
    expect(meds).toHaveLength(1);
    expect(mockDm).toHaveBeenCalledTimes(1);
  });
});
