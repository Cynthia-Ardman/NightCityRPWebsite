import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("./discord", async (importActual) => {
  const actual = await importActual<typeof import("./discord")>();
  return {
    ...actual,
    grantChannelViewAccess: vi.fn(async () => ({ ok: true as const })),
    revokeChannelViewAccess: vi.fn(async () => ({ ok: true as const })),
  };
});

import { db, botConfig, stores, ripperdocs } from "@workspace/db";
import {
  grantChannelViewAccess,
  revokeChannelViewAccess,
  BUSINESS_OWNER_CHANNEL_ID,
} from "./discord";
import { reconcileBusinessChannelAccess } from "./businessChannelAccess";
import { truncateAll, createUser } from "../test/testDb";

const mockGrant = vi.mocked(grantChannelViewAccess);
const mockRevoke = vi.mocked(revokeChannelViewAccess);

// Valid 18-digit Discord snowflakes. createUser()'s auto ids are NOT snowflakes
// (the reconcile deliberately skips those), so owners must use explicit ids.
const SNOWFLAKE_A = "100000000000000001";
const SNOWFLAKE_B = "100000000000000002";
const MANAGED_KEY = "business_channel_access_granted";

async function readManaged(): Promise<string[]> {
  const [row] = await db.select().from(botConfig).where(eq(botConfig.key, MANAGED_KEY));
  return (row?.value as string[] | undefined) ?? [];
}

beforeEach(async () => {
  await truncateAll();
  mockGrant.mockReset();
  mockRevoke.mockReset();
  mockGrant.mockResolvedValue({ ok: true });
  mockRevoke.mockResolvedValue({ ok: true });
});

describe("reconcileBusinessChannelAccess", () => {
  it("grants channel access to store and ripperdoc owners, skips non-snowflake owners", async () => {
    const a = await createUser({ id: SNOWFLAKE_A });
    const b = await createUser({ id: SNOWFLAKE_B });
    const legacy = await createUser(); // non-snowflake auto id
    await db.insert(stores).values({ ownerId: a.id, name: "Store A" });
    await db.insert(ripperdocs).values({ ownerId: b.id, name: "Clinic B" });
    await db.insert(stores).values({ ownerId: legacy.id, name: "Legacy Store" });

    const res = await reconcileBusinessChannelAccess();

    expect(res.granted).toBe(2);
    expect(res.revoked).toBe(0);
    expect(mockGrant).toHaveBeenCalledTimes(2);
    const grantedIds = mockGrant.mock.calls.map((c) => c[0]).sort();
    expect(grantedIds).toEqual([SNOWFLAKE_A, SNOWFLAKE_B]);
    expect(mockGrant).toHaveBeenCalledWith(SNOWFLAKE_A, BUSINESS_OWNER_CHANNEL_ID);
    // legacy (non-snowflake) owner never gets a Discord call.
    expect(mockGrant).not.toHaveBeenCalledWith(legacy.id, BUSINESS_OWNER_CHANNEL_ID);
    expect((await readManaged()).sort()).toEqual([SNOWFLAKE_A, SNOWFLAKE_B]);
  });

  it("is idempotent — a second run makes no Discord calls", async () => {
    const a = await createUser({ id: SNOWFLAKE_A });
    await db.insert(stores).values({ ownerId: a.id, name: "Store A" });

    await reconcileBusinessChannelAccess();
    mockGrant.mockClear();
    mockRevoke.mockClear();

    const res = await reconcileBusinessChannelAccess();
    expect(res).toEqual({ granted: 0, revoked: 0 });
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("revokes access once an owner no longer owns any business", async () => {
    const a = await createUser({ id: SNOWFLAKE_A });
    await db.insert(stores).values({ ownerId: a.id, name: "Store A" });
    await reconcileBusinessChannelAccess();
    expect(await readManaged()).toEqual([SNOWFLAKE_A]);

    // Owner sells/deletes their only business.
    await db.delete(stores).where(eq(stores.ownerId, a.id));
    const res = await reconcileBusinessChannelAccess();

    expect(res).toEqual({ granted: 0, revoked: 1 });
    expect(mockRevoke).toHaveBeenCalledWith(SNOWFLAKE_A, BUSINESS_OWNER_CHANNEL_ID);
    expect(await readManaged()).toEqual([]);
  });

  it("keeps access while the owner still owns another business", async () => {
    const a = await createUser({ id: SNOWFLAKE_A });
    await db.insert(stores).values({ ownerId: a.id, name: "Store A" });
    await db.insert(ripperdocs).values({ ownerId: a.id, name: "Clinic A" });
    await reconcileBusinessChannelAccess();
    mockRevoke.mockClear();

    // Delete one of the two businesses — access must remain.
    await db.delete(stores).where(eq(stores.ownerId, a.id));
    const res = await reconcileBusinessChannelAccess();

    expect(res).toEqual({ granted: 0, revoked: 0 });
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(await readManaged()).toEqual([SNOWFLAKE_A]);
  });

  it("does not persist a grant that failed (retries next run)", async () => {
    const a = await createUser({ id: SNOWFLAKE_A });
    await db.insert(stores).values({ ownerId: a.id, name: "Store A" });
    mockGrant.mockResolvedValueOnce({ ok: false, error: "boom" });

    const first = await reconcileBusinessChannelAccess();
    expect(first.granted).toBe(0);
    expect(await readManaged()).toEqual([]);

    // Next run retries and succeeds.
    const second = await reconcileBusinessChannelAccess();
    expect(second.granted).toBe(1);
    expect(await readManaged()).toEqual([SNOWFLAKE_A]);
  });
});
