import { describe, it, expect, vi } from "vitest";
import { asc, eq } from "drizzle-orm";

// UB is fully mocked; this file exercises the outbox mechanics, not UB itself.
vi.mock("./unbelievaboat", () => ({
  patchBalance: vi.fn(),
  getBalance: vi.fn(),
}));

import { db, users, ubPushOutbox } from "@workspace/db";
import { applyWalletDelta, drainUbPushOutbox } from "./economy";
import { createUser } from "../test/testDb";

describe("UB push outbox", () => {
  it("wallet writes enqueue per-user ordered pending rows", async () => {
    const user = await createUser();
    await db.update(users).set({ walletBalance: 1000, lastSyncedUbBalance: 1000 }).where(eq(users.id, user.id));

    const a = await applyWalletDelta({ userId: user.id, discordId: user.discordId, amount: -100, source: "admin", kind: "adjust", reason: "Outbox test", idempotencyKey: "outbox-a", gate: "none" });
    const b = await applyWalletDelta({ userId: user.id, discordId: user.discordId, amount: 40, source: "admin", kind: "adjust", reason: "Outbox test", idempotencyKey: "outbox-b", gate: "none" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    // The fire-and-forget drain kicked by applyWalletDelta may be mid-consume
    // (rows transiently sit at "inflight" while claimed) — poll until every
    // row settles. What matters is that nothing EVER reaches "pushed" in the
    // test env (external pushes are suppressed).
    let rows: (typeof ubPushOutbox.$inferSelect)[] = [];
    await vi.waitFor(
      async () => {
        rows = await db
          .select()
          .from(ubPushOutbox)
          .where(eq(ubPushOutbox.userId, user.id))
          .orderBy(asc(ubPushOutbox.id));
        expect(rows.every((r) => r.status === "pending" || r.status === "suppressed")).toBe(true);
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(rows.map((r) => r.amount)).toEqual([-100, 40]);
    expect(rows.some((r) => r.status === "pushed")).toBe(false);
    // Each row points at the ledger row it mirrors.
    expect(rows.every((r) => r.ledgerId !== null)).toBe(true);
  });

  it("drain marks rows suppressed (not pushed) when external writes are disallowed", async () => {
    // The test app runs with external writes disabled, exactly like local dev:
    // drain must consume the queue WITHOUT advancing the UB baseline.
    const user = await createUser();
    await db.update(users).set({ walletBalance: 500, lastSyncedUbBalance: 500 }).where(eq(users.id, user.id));
    const r = await applyWalletDelta({ userId: user.id, discordId: user.discordId, amount: -50, source: "admin", kind: "adjust", reason: "Outbox test", idempotencyKey: "outbox-drain", gate: "none" });
    expect(r.ok).toBe(true);

    // The fire-and-forget drain kicked by applyWalletDelta may have consumed
    // the row already; either way an explicit drain must push NOTHING.
    const out = await drainUbPushOutbox({ userId: user.id });
    expect(out.pushed).toBe(0);

    // The fire-and-forget drain may still be finishing; poll briefly.
    let rows: (typeof ubPushOutbox.$inferSelect)[] = [];
    for (let i = 0; i < 20; i++) {
      rows = await db.select().from(ubPushOutbox).where(eq(ubPushOutbox.userId, user.id));
      if (rows.length > 0 && rows.every((row) => row.status === "suppressed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(rows.every((row) => row.status === "suppressed")).toBe(true);
    // Baseline untouched: the mirror was never actually written.
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u.lastSyncedUbBalance).toBe(500);
    expect(u.walletBalance).toBe(450);
  });

  it("a duplicate idempotency key does not enqueue a second push", async () => {
    const user = await createUser();
    await db.update(users).set({ walletBalance: 1000, lastSyncedUbBalance: 1000 }).where(eq(users.id, user.id));
    const first = await applyWalletDelta({ userId: user.id, discordId: user.discordId, amount: -100, source: "admin", kind: "adjust", reason: "Outbox test", idempotencyKey: "outbox-dup", gate: "none" });
    const second = await applyWalletDelta({ userId: user.id, discordId: user.discordId, amount: -100, source: "admin", kind: "adjust", reason: "Outbox test", idempotencyKey: "outbox-dup", gate: "none" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.status).toBe("duplicate");

    const rows = await db.select().from(ubPushOutbox).where(eq(ubPushOutbox.userId, user.id));
    expect(rows).toHaveLength(1);
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u.walletBalance).toBe(900);
  });
});
