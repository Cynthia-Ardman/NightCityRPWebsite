import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";

import { db, users, walletTransactions } from "@workspace/db";
import { createUser } from "../test/testDb";
import { recordSettledWalletMovement } from "./economy";

async function ledgerFor(userId: string) {
  return db.select().from(walletTransactions).where(eq(walletTransactions.userId, userId));
}
async function userRow(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  return u;
}

describe("recordSettledWalletMovement", () => {
  it("writes a synced 'mission' ledger row and advances balance + UB baseline for a seeded wallet", async () => {
    const u = await createUser();
    await db
      .update(users)
      .set({ walletBalance: 1000, lastSyncedUbBalance: 1000 })
      .where(eq(users.id, u.id));

    const id = await recordSettledWalletMovement({
      userId: u.id,
      amount: 3000,
      ubTotalAfter: 4000,
      source: "mission",
      kind: "mission",
      memo: "Mission payout: No More Romeo",
      relatedEntityType: "mission",
      relatedEntityId: 5,
      idempotencyKey: "mission_payout:test-1",
    });
    expect(id).not.toBeNull();

    const rows = await ledgerFor(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount: 3000,
      kind: "mission",
      source: "mission",
      syncStatus: "synced",
      previousBalance: 1000,
      newBalance: 4000,
      relatedEntityType: "mission",
      relatedEntityId: 5,
    });

    const after = await userRow(u.id);
    expect(after.walletBalance).toBe(4000);
    expect(after.lastSyncedUbBalance).toBe(4000);
  });

  it("advances the balance but leaves the UB baseline null for an unseeded wallet (first reconcile still seeds the full total)", async () => {
    const u = await createUser();
    // createUser leaves lastSyncedUbBalance null (never synced).
    expect((await userRow(u.id)).lastSyncedUbBalance).toBeNull();

    await recordSettledWalletMovement({
      userId: u.id,
      amount: 3000,
      ubTotalAfter: 53000,
      source: "mission",
      kind: "mission",
      memo: "Mission payout: No More Romeo",
      idempotencyKey: "mission_payout:test-2",
    });

    const after = await userRow(u.id);
    expect(after.walletBalance).toBe(3000);
    expect(after.lastSyncedUbBalance).toBeNull();
  });

  it("is idempotent: a duplicate key writes no second row and does not move the balance again", async () => {
    const u = await createUser();
    await db
      .update(users)
      .set({ walletBalance: 0, lastSyncedUbBalance: 0 })
      .where(eq(users.id, u.id));

    const first = await recordSettledWalletMovement({
      userId: u.id,
      amount: 3000,
      ubTotalAfter: 3000,
      source: "mission",
      kind: "mission",
      idempotencyKey: "mission_payout:dup",
    });
    const second = await recordSettledWalletMovement({
      userId: u.id,
      amount: 3000,
      ubTotalAfter: 6000,
      source: "mission",
      kind: "mission",
      idempotencyKey: "mission_payout:dup",
    });

    expect(second).toBe(first);
    expect(await ledgerFor(u.id)).toHaveLength(1);
    expect((await userRow(u.id)).walletBalance).toBe(3000);
  });

  it("returns null when the user does not exist", async () => {
    const id = await recordSettledWalletMovement({
      userId: "does-not-exist",
      amount: 3000,
      ubTotalAfter: 3000,
      source: "mission",
      kind: "mission",
      idempotencyKey: "mission_payout:ghost",
    });
    expect(id).toBeNull();
  });
});
