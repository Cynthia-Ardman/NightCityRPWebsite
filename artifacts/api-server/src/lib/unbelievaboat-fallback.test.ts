import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, users } from "@workspace/db";
import { createUser } from "../test/testDb";

// The wallet-provider module reads its token + guild id at import time, and
// vitest.config blanks external tokens for safety. Stub the env FIRST, then
// dynamically import a fresh module instance per test (resetModules) so the
// stubbed values are seen and per-module caches don't leak across tests.
async function loadUb() {
  vi.stubEnv("UNBELIEVABOAT_TOKEN", "test-token");
  vi.stubEnv("DISCORD_GUILD_ID", "guild-1");
  vi.resetModules();
  return await import("./unbelievaboat");
}

describe("getBalance stale fallback (provider outage)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns the persisted cash/bank split when available — never a false bank=0", async () => {
    const u = await createUser();
    await db
      .update(users)
      .set({ lastSyncedUbBalance: 5000, lastSyncedUbCash: 1200, lastSyncedUbBank: 4300 })
      .where(eq(users.id, u.id));

    const ub = await loadUb();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("UB down")));

    const bal = await ub.getBalance(u.discordId!, { allowStale: true });
    expect(bal).toEqual({ cash: 1200, bank: 4300, total: 5500, source: "local" });
    expect(bal!.splitUnknown).toBeUndefined();
  });

  it("flags splitUnknown for legacy rows with only a total (no snapshot)", async () => {
    const u = await createUser();
    await db.update(users).set({ lastSyncedUbBalance: 7000 }).where(eq(users.id, u.id));

    const ub = await loadUb();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("UB down")));

    const bal = await ub.getBalance(u.discordId!, { allowStale: true });
    expect(bal).toMatchObject({ total: 7000, source: "local", splitUnknown: true });
  });

  it("returns null when the user has never been synced", async () => {
    const u = await createUser();
    const ub = await loadUb();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("UB down")));

    expect(await ub.getBalance(u.discordId!, { allowStale: true })).toBeNull();
  });

  it("still returns null without allowStale (strict money-movement callers)", async () => {
    const u = await createUser();
    await db
      .update(users)
      .set({ lastSyncedUbCash: 100, lastSyncedUbBank: 200 })
      .where(eq(users.id, u.id));

    const ub = await loadUb();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("UB down")));

    expect(await ub.getBalance(u.discordId!)).toBeNull();
  });

  it("persists the cash/bank snapshot after a successful live read", async () => {
    const u = await createUser();
    const ub = await loadUb();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ cash: 250, bank: 750, total: 1000 }),
      }),
    );

    const live = await ub.getBalance(u.discordId!);
    expect(live).toMatchObject({ cash: 250, bank: 750, total: 1000, source: "unbelievaboat" });

    // Snapshot write is fire-and-forget; a fixed sleep flakes under full-suite
    // load, so poll until it lands.
    await vi.waitFor(
      async () => {
        const [row] = await db
          .select({ cash: users.lastSyncedUbCash, bank: users.lastSyncedUbBank })
          .from(users)
          .where(eq(users.id, u.id));
        expect(row).toEqual({ cash: 250, bank: 750 });
      },
      { timeout: 10_000, interval: 50 },
    );
  });
});
