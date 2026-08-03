import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("./discord", async (importActual) => {
  const actual = await importActual<typeof import("./discord")>();
  return {
    ...actual,
    externalWritesAllowed: vi.fn(() => true),
    addGuildMemberRole: vi.fn(async () => ({ ok: true as const })),
    fetchGuildMemberRoleIdsViaBot: vi.fn(async () => [] as string[] | null),
    postToChannel: vi.fn(async () => "msg-1"),
  };
});

import { db, pendingRoleGrants } from "@workspace/db";
import {
  addGuildMemberRole,
  externalWritesAllowed,
  fetchGuildMemberRoleIdsViaBot,
  postToChannel,
} from "./discord";
import { grantRoleDurable, retryPendingRoleGrants } from "./roleGrants";
import { truncateAll } from "../test/testDb";

const mockAdd = vi.mocked(addGuildMemberRole);
const mockAllowed = vi.mocked(externalWritesAllowed);
const mockPost = vi.mocked(postToChannel);
const mockHeld = vi.mocked(fetchGuildMemberRoleIdsViaBot);

const USER = "100000000000000001";
const ROLE = "200000000000000001";

async function rows() {
  return db.select().from(pendingRoleGrants).where(eq(pendingRoleGrants.userId, USER));
}

beforeEach(async () => {
  await truncateAll();
  mockAdd.mockReset().mockResolvedValue({ ok: true });
  mockAllowed.mockReset().mockReturnValue(true);
  mockPost.mockReset().mockResolvedValue("msg-1");
  mockHeld.mockReset().mockResolvedValue([]);
});

describe("grantRoleDurable", () => {
  it("marks the row granted when the immediate grant succeeds", async () => {
    await grantRoleDurable(USER, ROLE, "test grant");
    const [r] = await rows();
    expect(r.status).toBe("granted");
    expect(r.grantedAt).toBeTruthy();
    expect(mockAdd).toHaveBeenCalledWith(USER, ROLE, "test grant");
  });

  it("leaves a pending row (attempts=1, lastError set) when the grant fails", async () => {
    mockAdd.mockResolvedValue({ ok: false, error: "boom" });
    await grantRoleDurable(USER, ROLE, "test grant");
    const [r] = await rows();
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(1);
    expect(r.lastError).toBe("boom");
  });

  it("finalizes without a Discord write when the member already holds the role", async () => {
    mockHeld.mockResolvedValue([ROLE]);
    await grantRoleDurable(USER, ROLE, "test grant");
    const [r] = await rows();
    expect(r.status).toBe("granted");
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("falls through to a normal grant attempt when the role read fails", async () => {
    mockHeld.mockResolvedValue(null);
    await grantRoleDurable(USER, ROLE, "test grant");
    const [r] = await rows();
    expect(r.status).toBe("granted");
    expect(mockAdd).toHaveBeenCalledWith(USER, ROLE, "test grant");
  });

  it("does not burn an attempt when external writes are suppressed", async () => {
    mockAllowed.mockReturnValue(false);
    await grantRoleDurable(USER, ROLE, "test grant");
    const [r] = await rows();
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("dedupes: repeated requests while one is pending keep a single pending row", async () => {
    mockAdd.mockResolvedValue({ ok: false, error: "boom" });
    await grantRoleDurable(USER, ROLE, "first");
    await grantRoleDurable(USER, ROLE, "second");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].attempts).toBe(2);
  });

  it("a new pending row is allowed after a previous one was granted", async () => {
    await grantRoleDurable(USER, ROLE, "first"); // granted
    mockAdd.mockResolvedValue({ ok: false, error: "boom" });
    await grantRoleDurable(USER, ROLE, "second"); // new pending row
    const all = await rows();
    expect(all.map((r) => r.status).sort()).toEqual(["granted", "pending"]);
  });
});

describe("retryPendingRoleGrants", () => {
  it("retries pending rows until granted, then never touches them again", async () => {
    mockAdd.mockResolvedValue({ ok: false, error: "boom" });
    await grantRoleDurable(USER, ROLE, "test grant");

    mockAdd.mockResolvedValue({ ok: true });
    const res = await retryPendingRoleGrants();
    expect(res).toMatchObject({ retried: 1, granted: 1 });
    const [r] = await rows();
    expect(r.status).toBe("granted");

    // Granted rows are excluded from later sweeps — a manual removal in
    // Discord is respected (we never re-grant).
    mockAdd.mockClear();
    const res2 = await retryPendingRoleGrants();
    expect(res2.retried).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("alerts staff ONCE after repeated failures and keeps retrying", async () => {
    mockAdd.mockResolvedValue({ ok: false, error: "boom" });
    await grantRoleDurable(USER, ROLE, "test grant"); // attempt 1
    await retryPendingRoleGrants(); // attempt 2 — no alert yet
    expect(mockPost).not.toHaveBeenCalled();
    const res3 = await retryPendingRoleGrants(); // attempt 3 — alert
    expect(res3.alerted).toBe(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const res4 = await retryPendingRoleGrants(); // attempt 4 — still retrying, no re-alert
    expect(res4.retried).toBe(1);
    expect(res4.alerted).toBe(0);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [r] = await rows();
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(4);
    expect(r.alertedAt).toBeTruthy();
  });

  it("does nothing off-deployment", async () => {
    mockAdd.mockResolvedValue({ ok: false, error: "boom" });
    await grantRoleDurable(USER, ROLE, "test grant");
    mockAllowed.mockReturnValue(false);
    const res = await retryPendingRoleGrants();
    expect(res.retried).toBe(0);
  });
});
