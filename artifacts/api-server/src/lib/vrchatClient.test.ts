import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, vrchatSessions } from "@workspace/db";
import { eq } from "drizzle-orm";
import { fetchGroupInstances, SESSION_EXPIRED_MSG } from "./vrchatClient";

// Unit-level coverage for the session-drop fix: a lone 401 must NOT wipe the
// stored auth cookie unless a confirming /auth/user call also says the cookie
// is dead, and rotated Set-Cookie values on successful responses must be
// persisted. The VRChat network is fully stubbed via global fetch.

const SESSION_ID = 1;

async function seedSession(auth = "cookie-A", twoFactor = "tfa-A"): Promise<void> {
  await db
    .insert(vrchatSessions)
    .values({ id: SESSION_ID, authCookie: auth, twoFactorCookie: twoFactor, lastError: null })
    .onConflictDoUpdate({
      target: vrchatSessions.id,
      set: { authCookie: auth, twoFactorCookie: twoFactor, lastError: null },
    });
}

async function readSession() {
  const [row] = await db.select().from(vrchatSessions).where(eq(vrchatSessions.id, SESSION_ID));
  return row;
}

function jsonResponse(body: unknown, init: { status?: number; setCookies?: string[] } = {}): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  const res = new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
  if (init.setCookies) {
    // Response headers are immutable-ish for set-cookie via Headers in some
    // runtimes; emulate getSetCookie explicitly.
    Object.defineProperty(res.headers, "getSetCookie", {
      value: () => init.setCookies,
    });
  }
  return res;
}

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await seedSession();
});

describe("vrchatClient 401 handling", () => {
  it("keeps the session when the 401 is transient (confirm check says cookie is alive)", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/groups/")) return jsonResponse({ error: "unauthorized" }, { status: 401 });
      if (u.includes("/auth/user")) return jsonResponse({ id: "usr_x", displayName: "Bot" });
      return jsonResponse({}, { status: 500 });
    }) as typeof fetch;

    await expect(fetchGroupInstances("grp_test")).rejects.toThrow(/transient 401/);

    const row = await readSession();
    expect(row?.authCookie).toBe("cookie-A"); // NOT wiped
    expect(calls.some((u) => u.includes("/auth/user"))).toBe(true);
  });

  it("keeps the session when the confirm check itself fails (network error = inconclusive)", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/groups/")) return jsonResponse({}, { status: 401 });
      throw new Error("network down");
    }) as typeof fetch;

    await expect(fetchGroupInstances("grp_test")).rejects.toThrow(/transient 401/);
    expect((await readSession())?.authCookie).toBe("cookie-A");
  });

  it("expires the session only when the confirm check also returns 401, recording context", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/groups/")) return jsonResponse({}, { status: 401 });
      if (u.includes("/auth/user")) return jsonResponse({}, { status: 401 });
      return jsonResponse({}, { status: 500 });
    }) as typeof fetch;

    await expect(fetchGroupInstances("grp_test")).rejects.toThrow(SESSION_EXPIRED_MSG);

    const row = await readSession();
    expect(row?.authCookie).toBeNull(); // cookie cleared
    expect(row?.twoFactorCookie).toBe("tfa-A"); // 2FA device memory kept
    expect(row?.lastError).toContain("401 on GET /groups/grp_test/instances");
  });
});

describe("vrchatClient cookie rotation", () => {
  it("persists rotated auth/twoFactorAuth cookies from successful responses", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse([], {
        setCookies: ["auth=cookie-B; Path=/; HttpOnly", "twoFactorAuth=tfa-B; Path=/; HttpOnly"],
      }),
    ) as typeof fetch;

    await fetchGroupInstances("grp_test");

    const row = await readSession();
    expect(row?.authCookie).toBe("cookie-B");
    expect(row?.twoFactorCookie).toBe("tfa-B");
    expect(row?.lastError).toBeNull();
  });

  it("leaves stored cookies untouched when no Set-Cookie arrives", async () => {
    global.fetch = vi.fn(async () => jsonResponse([])) as typeof fetch;

    await fetchGroupInstances("grp_test");

    const row = await readSession();
    expect(row?.authCookie).toBe("cookie-A");
    expect(row?.twoFactorCookie).toBe("tfa-A");
  });
});
