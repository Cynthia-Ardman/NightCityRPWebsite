import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";

vi.mock("./unbelievaboat", () => ({
  patchBalance: vi.fn(),
  getBalance: vi.fn(),
}));

import {
  db, botConfig, housing, characterStatus, inventoryItems, walletTransactions,
  characters, shopOpens,
} from "@workspace/db";
import { patchBalance } from "./unbelievaboat";
import { runJob, isAutobillEnabled, AUTOBILL_FLAGS } from "./jobs";
import { LIVE_MODE_KEYS } from "./liveMode";
import { createUser, createCharacter } from "../test/testDb";

const mockPatch = vi.mocked(patchBalance);

// runJob's Test/Live gate skips all external/local effects unless the master
// switch AND the job's own system are Live — even for manual runs. These tests
// assert the real billing behavior, so flip every relevant flag Live up-front.
async function setLive(key: string): Promise<void> {
  await db
    .insert(botConfig)
    .values({ key, value: true as never })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: true as never } });
}

beforeEach(async () => {
  mockPatch.mockReset();
  await setLive(LIVE_MODE_KEYS.master);
  await setLive(LIVE_MODE_KEYS.housing);
  await setLive(LIVE_MODE_KEYS.cyberware);
  await setLive(LIVE_MODE_KEYS.evictions);
});

// Returns a YYYY-MM-DD date string for the given day-of-month in the current
// UTC month — used to seed shop_opens rows on distinct days (the table has a
// UNIQUE (characterId, openedOn) index).
function monthDay(day: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  return d.toISOString().slice(0, 10);
}

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

// The cyberware_humanity job treats a character's createdAt as an implicit
// initial ripperdoc checkup, so a brand-new chromed PC isn't billed for weeks
// it didn't exist. Tests that want to assert a real charge must age the
// character past the 7-day checkup window first.
async function backdateCreation(characterId: number, days = 30): Promise<void> {
  await db
    .update(characters)
    .set({ createdAt: new Date(Date.now() - days * 86_400_000) })
    .where(eq(characters.id, characterId));
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
    await backdateCreation(char.id);

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
    await backdateCreation(char.id);

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
    await backdateCreation(char.id);

    await runJob("cyberware_humanity");
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const meds = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "meds"));
    expect(meds).toHaveLength(0);
  });

  it("skips meds for a player whose character is on the self-service LOA toggle", async () => {
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await addChrome(char.id, owner.id, 8); // medium band — would normally bill
    await backdateCreation(char.id);
    // The player flipped LOA on the website (character_status.loa), but the
    // headline lifeStatus is still billable ("missing" / "active"). Meds must
    // still pause, matching how monthly_rent honors this flag.
    await db.insert(characterStatus).values({ characterId: char.id, loa: true });

    await runJob("cyberware_humanity");
    expect(mockPatch).not.toHaveBeenCalled();
    const meds = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "meds"));
    expect(meds).toHaveLength(0);
  });

  it("does not let an LOA household member inflate the multiplier for active members", async () => {
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    // Control: a player with a single active chromed character.
    const control = await createUser();
    const controlChar = await createCharacter({ ownerId: control.id });
    await addChrome(controlChar.id, control.id, 8);
    await backdateCreation(controlChar.id);
    // Subject: same active character PLUS a second chromed character on the
    // self-service LOA toggle. The LOA member must drop out of the household
    // multiplier, so the subject pays exactly the same as the control.
    const subject = await createUser();
    const activeChar = await createCharacter({ ownerId: subject.id });
    await addChrome(activeChar.id, subject.id, 8);
    await backdateCreation(activeChar.id);
    const loaChar = await createCharacter({ ownerId: subject.id });
    await addChrome(loaChar.id, subject.id, 8);
    await backdateCreation(loaChar.id);
    await db.insert(characterStatus).values({ characterId: loaChar.id, loa: true });

    await runJob("cyberware_humanity");

    const controlMeds = await db
      .select()
      .from(walletTransactions)
      .where(and(eq(walletTransactions.kind, "meds"), eq(walletTransactions.userId, control.id)));
    const subjectMeds = await db
      .select()
      .from(walletTransactions)
      .where(and(eq(walletTransactions.kind, "meds"), eq(walletTransactions.userId, subject.id)));
    expect(controlMeds).toHaveLength(1);
    expect(subjectMeds).toHaveLength(1);
    // Equal amounts ⇒ the LOA character did not add a +25% household member.
    expect(subjectMeds[0].amount).toBe(controlMeds[0].amount);
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

  it("charges a lease whose paidThrough is later the SAME UTC day (seconds-race regression), without double-charging on rerun", async () => {
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    // Last cycle stamped paid_through a few seconds AFTER the moment this run
    // reaches the lease — the old exact-instant compare skipped the whole month.
    const laterToday = new Date(Date.now() + 60_000);
    await db.insert(housing).values({
      characterId: char.id, address: "Megabuilding H10", monthlyRent: 500, kind: "residential",
      paidThrough: laterToday,
    });

    await runJob("monthly_rent");
    let rent = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "rent"));
    expect(rent).toHaveLength(1);

    // Rerun in the same period: paidThrough advanced a full month, so no re-charge.
    await runJob("monthly_rent");
    rent = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "rent"));
    expect(rent).toHaveLength(1);
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

// Crash-window race: the external UB debit can succeed, but if the process dies
// before the local idempotency guard (ledger row / paidThrough bump) commits, a
// manual rerun in the same period would historically re-debit the player. We
// reproduce that by having the FIRST run's patchBalance perform the debit and
// then throw — simulating the process dying right after the irreversible
// external mutation. The reserve-before-debit fix commits the guard BEFORE the
// debit, so a recovery rerun must NOT charge again.
describe("runJob('monthly_rent') crash-window: debit succeeded, ledger write missing", () => {
  it("does not double-charge rent on a rerun after a mid-run crash", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    await db.insert(housing).values({
      characterId: char.id, address: "Megabuilding H10", monthlyRent: 500, kind: "residential",
    });

    // First run: UB debit "succeeds" then the process crashes before the run
    // can finish.
    let debits = 0;
    mockPatch.mockImplementation(async () => {
      debits++;
      throw new Error("simulated crash after external debit succeeded");
    });
    const first = await runJob("monthly_rent");
    expect(first.status).toBe("failed");
    expect(debits).toBe(1);

    // The guard (ledger row + paidThrough) was reserved BEFORE the debit, so it
    // survived the crash.
    const afterCrash = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "rent"));
    expect(afterCrash).toHaveLength(1);
    const [leaseAfterCrash] = await db.select().from(housing).where(eq(housing.characterId, char.id));
    expect(leaseAfterCrash.paidThrough).not.toBeNull();
    expect(leaseAfterCrash.paidThrough!.getTime()).toBeGreaterThan(Date.now());

    // Recovery run with a healthy UB: rent must NOT be debited again. (Other
    // fees like the per-owner baseline cost may still fire on recovery — they
    // were never billed in the crashed run — so we assert specifically that the
    // rent debit is not repeated, not that UB is untouched entirely.)
    mockPatch.mockReset();
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    await runJob("monthly_rent");
    const recoveryReasons = mockPatch.mock.calls.map((c) => c[1]?.reason);
    expect(recoveryReasons).not.toContain("Rent: Megabuilding H10");

    const rent = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "rent"));
    expect(rent).toHaveLength(1);
  });

  it("never pays shop income from the monthly run (it is paid instantly on open shop)", async () => {
    // Shop income moved to an instant payout at OPEN SHOP time; the monthly
    // rent job must not credit it again, even when open-shop days exist for
    // the current period.
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    await db.insert(housing).values({
      characterId: char.id, address: "Afterlife Bar", monthlyRent: 500, kind: "business",
    });
    await db.insert(shopOpens).values([
      { characterId: char.id, openedOn: monthDay(1) },
      { characterId: char.id, openedOn: monthDay(2) },
    ]);

    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    await runJob("monthly_rent");

    const reasons = mockPatch.mock.calls.map((c) => c[1]?.reason ?? "");
    expect(reasons.some((r) => r.startsWith("Shop income:"))).toBe(false);
    const income = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "shop_income"));
    expect(income).toHaveLength(0);
  });

  it("does not double-charge a personal fee (baseline) on a rerun after a mid-run crash", async () => {
    const owner = await createUser();
    await createCharacter({ ownerId: owner.id, approved: true });

    // First run: the baseline debit "succeeds" then the process crashes. There
    // is no housing lease and no trauma/xanadu, so the per-owner baseline living
    // cost is the first (and only) debit attempted.
    let debits = 0;
    mockPatch.mockImplementation(async () => {
      debits++;
      throw new Error("simulated crash after external debit succeeded");
    });
    const first = await runJob("monthly_rent");
    expect(first.status).toBe("failed");
    expect(debits).toBe(1);

    // The baseline ledger row was reserved BEFORE the debit and survived.
    const afterCrash = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "baseline"));
    expect(afterCrash).toHaveLength(1);

    // Recovery run: the committed baseline ledger row trips the per-owner period
    // guard, so baseline is NOT re-debited.
    mockPatch.mockReset();
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    await runJob("monthly_rent");
    const recoveryReasons = mockPatch.mock.calls.map((c) => c[1]?.reason ?? "");
    expect(recoveryReasons.some((r) => r.startsWith("Baseline"))).toBe(false);

    const baseline = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "baseline"));
    expect(baseline).toHaveLength(1);
  });
});

// Same crash-window race as monthly_rent, but for the weekly cyberpsychosis-meds
// job. The external UB debit can succeed and then the process dies before the
// 'meds' ledger row commits — a manual rerun in the same week would historically
// re-debit. The reserve-before-debit fix commits the ledger guard BEFORE the
// debit, so a recovery rerun must NOT charge again.
describe("runJob('cyberware_humanity') crash-window: debit succeeded, ledger write missing", () => {
  it("does not double-charge meds on a rerun after a mid-run crash", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id });
    await addChrome(char.id, owner.id, 8); // medium band
    await backdateCreation(char.id);

    // First run: UB debit "succeeds" then the process crashes before the run
    // can finish.
    let debits = 0;
    mockPatch.mockImplementation(async () => {
      debits++;
      throw new Error("simulated crash after external debit succeeded");
    });
    const first = await runJob("cyberware_humanity");
    expect(first.status).toBe("failed");
    expect(debits).toBe(1);

    // The 'meds' ledger row was reserved BEFORE the debit, so it survived the
    // crash.
    const afterCrash = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "meds"));
    expect(afterCrash).toHaveLength(1);

    // Recovery run with a healthy UB: the committed ledger row trips the weekly
    // guard, so meds is NOT debited again.
    mockPatch.mockReset();
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });
    await runJob("cyberware_humanity");
    expect(mockPatch).not.toHaveBeenCalled();

    const meds = await db.select().from(walletTransactions).where(eq(walletTransactions.kind, "meds"));
    expect(meds).toHaveLength(1);
  });
});

// Proves the LOA boolean (set by the dashboard switch, see
// PlayerLoaControl.test.tsx) is actually honored by the billing job across
// EVERY per-character fee branch — not just residential rent. Each case runs an
// on-LOA character and a non-LOA character through the SAME monthly_rent run so
// we assert both halves of the contract at once: the on-leave character is
// exempt while the active character is still charged for that exact fee.
describe("runJob('monthly_rent') honors the per-character loa flag across all fee branches", () => {
  // Gives a character a Trauma Team subscription and Xanadu Gold so a single
  // monthly_rent run exercises rent + baseline + trauma_team + xanadu_gold for
  // them at once.
  async function setupBilledCharacter(opts: { loa: boolean }) {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    await db
      .update(characters)
      .set({ traumaTeamTier: "gold", xanaduGold: true })
      .where(eq(characters.id, char.id));
    await db.insert(housing).values({
      characterId: char.id, address: `Megabuilding for ${char.id}`, monthlyRent: 500, kind: "residential",
    });
    await db.insert(characterStatus).values({ characterId: char.id, loa: opts.loa });
    return { owner, char };
  }

  it("exempts an on-LOA character from rent and every personal fee while still charging a non-LOA character in the same run", async () => {
    mockPatch.mockResolvedValue({ cash: 0, bank: 0, total: 0, source: "unbelievaboat" });

    const onLeave = await setupBilledCharacter({ loa: true });
    const active = await setupBilledCharacter({ loa: false });

    await runJob("monthly_rent");

    // Helper: every wallet row tied to a specific character for a given kind.
    const rowsFor = async (characterId: number, kind: string) =>
      db
        .select()
        .from(walletTransactions)
        .where(and(eq(walletTransactions.characterId, characterId), eq(walletTransactions.kind, kind)));

    // The active character is charged for each per-character fee branch.
    expect(await rowsFor(active.char.id, "rent")).toHaveLength(1);
    expect(await rowsFor(active.char.id, "trauma_team")).toHaveLength(1);
    expect(await rowsFor(active.char.id, "xanadu_gold")).toHaveLength(1);

    // The on-LOA character is exempt from every one of those branches.
    expect(await rowsFor(onLeave.char.id, "rent")).toHaveLength(0);
    expect(await rowsFor(onLeave.char.id, "trauma_team")).toHaveLength(0);
    expect(await rowsFor(onLeave.char.id, "xanadu_gold")).toHaveLength(0);

    // Baseline living cost is billed per OWNER (characterId is NULL), so assert
    // it by userId: the active owner is charged, the on-leave owner is not.
    const baselineFor = async (userId: string) =>
      db
        .select()
        .from(walletTransactions)
        .where(and(eq(walletTransactions.userId, userId), eq(walletTransactions.kind, "baseline")));
    expect(await baselineFor(active.owner.id)).toHaveLength(1);
    expect(await baselineFor(onLeave.owner.id)).toHaveLength(0);
  });
});
