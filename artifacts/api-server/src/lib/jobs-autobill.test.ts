import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";

vi.mock("./unbelievaboat", () => ({
  patchBalance: vi.fn(),
  getBalance: vi.fn(),
}));

import {
  db, botConfig, housing, characterStatus, inventoryItems, walletTransactions,
} from "@workspace/db";
import { patchBalance } from "./unbelievaboat";
import { runJob, isAutobillEnabled, AUTOBILL_FLAGS } from "./jobs";
import { createUser, createCharacter } from "../test/testDb";

const mockPatch = vi.mocked(patchBalance);

beforeEach(() => {
  mockPatch.mockReset();
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

describe("isAutobillEnabled", () => {
  it("returns false when the config row is missing (fail-safe default OFF)", async () => {
    expect(await isAutobillEnabled(AUTOBILL_FLAGS.cyberware)).toBe(false);
  });

  it("returns false when the flag is explicitly false", async () => {
    await db.insert(botConfig).values({ key: AUTOBILL_FLAGS.housing, value: false });
    expect(await isAutobillEnabled(AUTOBILL_FLAGS.housing)).toBe(false);
  });

  it("returns true only when the flag is the literal boolean true", async () => {
    await db.insert(botConfig).values({ key: AUTOBILL_FLAGS.cyberware, value: true });
    expect(await isAutobillEnabled(AUTOBILL_FLAGS.cyberware)).toBe(true);
  });
});

describe("runJob('cyberware_humanity')", () => {
  it("charges a player whose chrome crosses the band threshold", async () => {
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await addChrome(char.id, owner.id, 8); // medium band

    const result = await runJob("cyberware_humanity");
    expect(result.status).toBe("succeeded");
    expect(mockPatch).toHaveBeenCalledTimes(1);

    const meds = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "meds"));
    expect(meds).toHaveLength(1);
    expect(meds[0].userId).toBe(owner.id);
    expect(meds[0].amount).toBeLessThan(0);
  });

  it("does not charge a player below the chrome threshold", async () => {
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await addChrome(char.id, owner.id, 3); // below band (need 7+)

    await runJob("cyberware_humanity");
    expect(mockPatch).not.toHaveBeenCalled();
    const meds = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "meds"));
    expect(meds).toHaveLength(0);
  });

  it("is idempotent within the weekly window (no double charge on rerun)", async () => {
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await addChrome(char.id, owner.id, 8);

    await runJob("cyberware_humanity");
    await runJob("cyberware_humanity");
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const meds = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "meds"));
    expect(meds).toHaveLength(1);
  });

  it("does not write a ledger row when the wallet debit fails", async () => {
    mockPatch.mockResolvedValue(null);
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await addChrome(char.id, owner.id, 8);

    await runJob("cyberware_humanity");
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const meds = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "meds"));
    expect(meds).toHaveLength(0);
  });
});

describe("runJob('monthly_rent')", () => {
  it("debits residential rent, writes a ledger row, and rolls paidThrough forward", async () => {
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    await db.insert(housing).values({
      characterId: char.id, address: "Megabuilding H10", monthlyRent: 500, kind: "residential",
    });

    await runJob("monthly_rent");

    const rent = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "rent"));
    expect(rent).toHaveLength(1);
    expect(rent[0].amount).toBe(-500);

    const [lease] = await db.select().from(housing).where(eq(housing.characterId, char.id));
    expect(lease.paidThrough).not.toBeNull();
    expect(lease.paidThrough!.getTime()).toBeGreaterThan(Date.now());
  });

  it("skips a residential lease whose tenant is on LOA", async () => {
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    await db.insert(housing).values({
      characterId: char.id, address: "Megabuilding H10", monthlyRent: 500, kind: "residential",
    });
    await db.insert(characterStatus).values({ characterId: char.id, loa: true });

    await runJob("monthly_rent");
    const rent = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "rent"));
    expect(rent).toHaveLength(0);
  });

  it("is idempotent: a lease already paid past now is not charged again", async () => {
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    const future = new Date(Date.now() + 20 * 86400000);
    await db.insert(housing).values({
      characterId: char.id, address: "Megabuilding H10", monthlyRent: 500, kind: "residential",
      paidThrough: future,
    });

    await runJob("monthly_rent");
    const rent = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "rent"));
    expect(rent).toHaveLength(0);
  });

  it("stamps the lease delinquent (no ledger row) when the debit fails", async () => {
    mockPatch.mockResolvedValue(null);
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    await db.insert(housing).values({
      characterId: char.id, address: "Megabuilding H10", monthlyRent: 500, kind: "residential",
    });

    await runJob("monthly_rent");
    const rent = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "rent"));
    expect(rent).toHaveLength(0);
    const [lease] = await db.select().from(housing).where(eq(housing.characterId, char.id));
    expect(lease.delinquentSince).not.toBeNull();
  });
});
