import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("./unbelievaboat", () => ({
  patchBalance: vi.fn(),
  getBalance: vi.fn(),
}));

import { db, botConfig, housing, walletTransactions, inventoryItems } from "@workspace/db";
import { patchBalance } from "./unbelievaboat";
import {
  isMasterLive,
  isSystemLive,
  getLiveModeState,
  LIVE_MODE_KEYS,
  LIVE_SYSTEMS,
} from "./liveMode";
import { runJob } from "./jobs";
import { createUser, createCharacter } from "../test/testDb";

const mockPatch = vi.mocked(patchBalance);

async function setFlag(key: string, value: boolean): Promise<void> {
  await db
    .insert(botConfig)
    .values({ key, value: value as never })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: value as never } });
}

beforeEach(() => {
  mockPatch.mockReset();
  mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
});

describe("isMasterLive / isSystemLive", () => {
  it("default to OFF (Test) when no config rows exist", async () => {
    expect(await isMasterLive()).toBe(false);
    for (const sys of LIVE_SYSTEMS) {
      expect(await isSystemLive(sys)).toBe(false);
    }
  });

  it("requires BOTH the master switch and the per-system override to be Live", async () => {
    // Master only → still Test for every system.
    await setFlag(LIVE_MODE_KEYS.master, true);
    expect(await isMasterLive()).toBe(true);
    expect(await isSystemLive("housing")).toBe(false);

    // System only (master off) → still Test.
    await setFlag(LIVE_MODE_KEYS.master, false);
    await setFlag(LIVE_MODE_KEYS.housing, true);
    expect(await isSystemLive("housing")).toBe(false);

    // Both Live → effective Live, and only for that system.
    await setFlag(LIVE_MODE_KEYS.master, true);
    expect(await isSystemLive("housing")).toBe(true);
    expect(await isSystemLive("cyberware")).toBe(false);
  });

  it("treats any non-true stored value as OFF (fail-safe)", async () => {
    await setFlag(LIVE_MODE_KEYS.master, true);
    await setFlag(LIVE_MODE_KEYS.evictions, false);
    expect(await isSystemLive("evictions")).toBe(false);
  });
});

describe("getLiveModeState", () => {
  it("reports configured vs effective per system", async () => {
    await setFlag(LIVE_MODE_KEYS.missions, true);
    // Master off: missions configured Live but not effective.
    let state = await getLiveModeState();
    expect(state.master).toBe(false);
    expect(state.systems.missions.configured).toBe(true);
    expect(state.systems.missions.effective).toBe(false);

    // Master on: now effective.
    await setFlag(LIVE_MODE_KEYS.master, true);
    state = await getLiveModeState();
    expect(state.master).toBe(true);
    expect(state.systems.missions.configured).toBe(true);
    expect(state.systems.missions.effective).toBe(true);
    // Untouched systems stay Test.
    expect(state.systems.cyberware.effective).toBe(false);
  });
});

describe("runJob Test/Live gate", () => {
  async function seedRentDue() {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    await db.insert(housing).values({
      characterId: char.id,
      address: "Megabuilding H10",
      monthlyRent: 500,
      kind: "residential",
    });
    return char;
  }

  it("monthly_rent makes NO charges in Test mode (default)", async () => {
    const char = await seedRentDue();
    const result = await runJob("monthly_rent");
    expect(result.status).toBe("succeeded");
    expect(mockPatch).not.toHaveBeenCalled();
    const rent = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "rent"));
    expect(rent).toHaveLength(0);
    const [lease] = await db.select().from(housing).where(eq(housing.characterId, char.id));
    expect(lease.paidThrough).toBeNull(); // not rolled forward
  });

  it("monthly_rent stays Test when the master is on but housing is off", async () => {
    await setFlag(LIVE_MODE_KEYS.master, true);
    await seedRentDue();
    await runJob("monthly_rent");
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("monthly_rent charges only when master AND housing are both Live", async () => {
    await setFlag(LIVE_MODE_KEYS.master, true);
    await setFlag(LIVE_MODE_KEYS.housing, true);
    await seedRentDue();
    await runJob("monthly_rent");
    // monthly_rent runs several bill types; the key property is that real
    // debits now happen and a rent ledger row is written.
    expect(mockPatch).toHaveBeenCalled();
    const rent = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "rent"));
    expect(rent).toHaveLength(1);
  });

  it("cyberware_humanity makes NO charges in Test mode (default)", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await db.insert(inventoryItems).values({
      characterId: char.id,
      ownerId: owner.id,
      name: "Sandevistan",
      category: "cyberware",
      quantity: 1,
      notes: "CWP 8", // medium band — would charge if Live
    });

    const result = await runJob("cyberware_humanity");
    expect(result.status).toBe("succeeded");
    expect(mockPatch).not.toHaveBeenCalled();
    const meds = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "meds"));
    expect(meds).toHaveLength(0);
  });

  it("eviction_sweep does NOT delete a delinquent lease in Test mode (default)", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    const longAgo = new Date(Date.now() - 365 * 86400000); // well past any grace period
    await db.insert(housing).values({
      characterId: char.id,
      address: "Megabuilding H10",
      monthlyRent: 500,
      kind: "residential",
      delinquentSince: longAgo,
    });

    const result = await runJob("eviction_sweep");
    expect(result.status).toBe("succeeded");
    const leases = await db.select().from(housing).where(eq(housing.characterId, char.id));
    expect(leases).toHaveLength(1); // lease survives in Test mode
  });
});
