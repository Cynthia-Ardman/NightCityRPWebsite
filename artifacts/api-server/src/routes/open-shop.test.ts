import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";

// Open-shop is gated to the Sunday session window; force it open so the
// payout schedule (the subject under test) is reachable any day.
vi.mock("../lib/sessionWindow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sessionWindow")>();
  return { ...actual, isSessionWindowOpen: () => true };
});

import { db, housing, shopOpens, stores, walletTransactions, botConfig, catalogRent } from "@workspace/db";
import { buildTestApp } from "../test/app";
import { createUser, createCharacter } from "../test/testDb";

const app = buildTestApp();

async function setFlag(key: string, value: boolean) {
  await db.insert(botConfig).values({ key, value }).onConflictDoUpdate({ target: botConfig.key, set: { value } });
}

beforeEach(async () => {
  // economy on, not live → applyWalletDelta commits the local ledger row.
  await setFlag("economy_enabled", true);
  await setFlag("master_live_mode", false);
});

// Seed a prior open N days ago (outside the 8h same-session lookback but
// inside the current month) so the ordinal advances without tripping the
// session guard. Callers pick days that stay within the current UTC month.
async function seedOpen(characterId: number, daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * 86400000);
  await db.insert(shopOpens).values({
    characterId,
    openedOn: at.toISOString().slice(0, 10),
    openedAt: at,
  });
}

// Anchor "earlier this month" seeds safely: tests below seed 1-2 prior opens,
// so they only run meaningfully when the month is at least a few days old;
// on the 1st-3rd the seeds fall into last month and the open is the first of
// the month, which the assertions account for by computing expectations from
// the actual in-month count.
async function opensThisMonth(characterId: number): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await db.select().from(shopOpens).where(eq(shopOpens.characterId, characterId));
  return rows.filter((r) => r.openedAt >= monthStart).length;
}

const T0 = [0, 150, 250, 350, 500];
const MULT = [0, 0.25, 0.4, 0.6, 0.8];

describe("open-shop tiered instant income", () => {
  it("tier-1+ lease pays the marginal % of rent for this month's ordinal", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    await db.insert(housing).values({
      characterId: char.id, address: "The Atomic Heart — Beastside", monthlyRent: 4000, kind: "business",
      tier: "Business Tier 3",
    });
    await seedOpen(char.id, 2); // a prior open earlier this week/month

    const prior = await opensThisMonth(char.id);
    const r = await request(app).post(`/api/characters/${char.id}/open-shop`).set("x-test-user", owner.id);
    expect(r.status).toBe(200);
    const n = Math.min(prior + 1, 4);
    const expected = Math.floor(4000 * (MULT[n] - MULT[Math.min(prior, 4)]));
    expect(r.body.payout).toBe(expected);
    expect(r.body.opensThisMonth).toBe(prior + 1);

    const [tx] = await db
      .select()
      .from(walletTransactions)
      .where(and(eq(walletTransactions.userId, owner.id), eq(walletTransactions.kind, "shop_income")));
    expect(tx.amount).toBe(expected);
  });

  it("tier-0 lease and venue-only owners use the flat table", async () => {
    // tier-0 lease
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    await db.insert(housing).values({
      // tier column is authoritative; address deliberately says nothing about
      // the tier to prove classification doesn't depend on address text.
      characterId: char.id, address: "Night City Law", monthlyRent: 500, kind: "business", tier: "T0",
    });
    const prior = await opensThisMonth(char.id);
    const r = await request(app).post(`/api/characters/${char.id}/open-shop`).set("x-test-user", owner.id);
    expect(r.status).toBe(200);
    expect(r.body.payout).toBe(T0[Math.min(prior + 1, 4)] - T0[Math.min(prior, 4)]);

    // venue-only owner (no lease)
    const owner2 = await createUser();
    const char2 = await createCharacter({ ownerId: owner2.id, approved: true });
    await db.insert(stores).values({ name: "The Dragon's Den", ownerId: owner2.id, ownerCharacterId: char2.id });
    const prior2 = await opensThisMonth(char2.id);
    const r2 = await request(app).post(`/api/characters/${char2.id}/open-shop`).set("x-test-user", owner2.id);
    expect(r2.status).toBe(200);
    expect(r2.body.payout).toBe(T0[Math.min(prior2 + 1, 4)] - T0[Math.min(prior2, 4)]);
  });

  it("opens beyond the monthly cap record but pay zero", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    await db.insert(housing).values({
      characterId: char.id, address: "Tier 2 club", monthlyRent: 3000, kind: "business",
    });
    // Seed 4 paid opens this month (if the month is <5 days old some fall
    // into last month; the assertion recomputes from the actual count).
    for (const d of [1, 2, 3, 4]) await seedOpen(char.id, d);
    const prior = await opensThisMonth(char.id);

    const r = await request(app).post(`/api/characters/${char.id}/open-shop`).set("x-test-user", owner.id);
    if (prior >= 4) {
      expect(r.status).toBe(200);
      expect(r.body.payout).toBe(0);
      // no ledger row when nothing was paid
      const txs = await db
        .select()
        .from(walletTransactions)
        .where(and(eq(walletTransactions.userId, owner.id), eq(walletTransactions.kind, "shop_income")));
      expect(txs).toHaveLength(0);
    } else {
      // early-month run: it still pays the correct marginal step
      const expected = Math.floor(3000 * (MULT[Math.min(prior + 1, 4)] - MULT[Math.min(prior, 4)]));
      expect(r.body.payout).toBe(expected);
    }
  });

  it("address text cannot alter tier treatment; catalog tier wins over lease tier", async () => {
    // Lease whose ADDRESS screams tier-0 but whose linked catalog listing is
    // Business Tier 1 → must pay the rent percentage, not the flat table.
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    const [listing] = await db
      .insert(catalogRent)
      .values({ name: "T0 micro stall", tier: "Business Tier 1", monthlyRent: 2001, kind: "business" })
      .returning();
    await db.insert(housing).values({
      characterId: char.id, listingId: listing.id, address: "T0 micro stall",
      monthlyRent: 2001, kind: "business",
    });
    const prior = await opensThisMonth(char.id);
    const r = await request(app).post(`/api/characters/${char.id}/open-shop`).set("x-test-user", owner.id);
    expect(r.status).toBe(200);
    // odd rent: marginal step floors (2001 * 0.25 = 500.25 → 500 on a first open)
    const expected = Math.floor(2001 * (MULT[Math.min(prior + 1, 4)] - MULT[Math.min(prior, 4)]));
    expect(r.body.payout).toBe(expected);
  });

  it("still rejects a second open in the same session (409)", async () => {
    const owner = await createUser();
    const char = await createCharacter({ ownerId: owner.id, approved: true });
    await db.insert(housing).values({
      characterId: char.id, address: "Bar", monthlyRent: 1000, kind: "business",
    });
    const r1 = await request(app).post(`/api/characters/${char.id}/open-shop`).set("x-test-user", owner.id);
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/api/characters/${char.id}/open-shop`).set("x-test-user", owner.id);
    expect(r2.status).toBe(409);
  });
});
