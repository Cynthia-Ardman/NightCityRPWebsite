import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, vrchatSessions, users, notifications } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  fetchGroupInstances,
  maintainVrchatSession,
  SESSION_EXPIRED_MSG,
  __resetAutoReconnectCooldownForTests,
  claimVrchatPollTick,
  isVrchatPollOwner,
} from "./vrchatClient";

// Unit-level coverage for the session-drop fix: a lone 401 must NOT wipe the
// stored auth cookie unless a confirming /auth/user call also says the cookie
// is dead, and rotated Set-Cookie values on successful responses must be
// persisted. The VRChat network is fully stubbed via global fetch.

const SESSION_ID = 1;

async function seedSession(auth = "cookie-A", twoFactor = "tfa-A"): Promise<void> {
  await db
    .insert(vrchatSessions)
    .values({
      id: SESSION_ID,
      authCookie: auth,
      twoFactorCookie: twoFactor,
      lastError: null,
      disconnectedSince: null,
      lastDisconnectNotifyAt: null,
    })
    .onConflictDoUpdate({
      target: vrchatSessions.id,
      set: {
        authCookie: auth,
        twoFactorCookie: twoFactor,
        lastError: null,
        disconnectedSince: null,
        lastDisconnectNotifyAt: null,
      },
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
const realEnv = {
  VRCHAT_USERNAME: process.env.VRCHAT_USERNAME,
  VRCHAT_PASSWORD: process.env.VRCHAT_PASSWORD,
};

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(realEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  await seedSession();
  await __resetAutoReconnectCooldownForTests();
  // Auto-reconnect requires credentials; default to none so 401 tests hit the
  // manual-reconnect fallback deterministically.
  delete process.env.VRCHAT_USERNAME;
  delete process.env.VRCHAT_PASSWORD;
});

describe("vrchatClient 401 handling", () => {
  it("keeps the session when the 401 is transient (confirm check says cookie is alive)", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
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
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes("/groups/")) return jsonResponse({}, { status: 401 });
      throw new Error("network down");
    }) as typeof fetch;

    await expect(fetchGroupInstances("grp_test")).rejects.toThrow(/transient 401/);
    expect((await readSession())?.authCookie).toBe("cookie-A");
  });

  it("expires the session only when the confirm check also returns 401, recording context", async () => {
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
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

  it("does not clobber a newer session when the 401 came from a stale cookie", async () => {
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (u.includes("/groups/")) return jsonResponse({}, { status: 401 });
      if (u.includes("/auth/user")) {
        // Simulate a concurrent reconnect landing while this request is in
        // flight: by the time the confirm check runs, the DB already holds a
        // fresh cookie that must survive.
        await db
          .update(vrchatSessions)
          .set({ authCookie: "cookie-FRESH" })
          .where(eq(vrchatSessions.id, SESSION_ID));
        return jsonResponse({}, { status: 401 });
      }
      return jsonResponse({}, { status: 500 });
    }) as typeof fetch;

    // The concurrent reconnect is detected before expiring anything: the call
    // reports the session as already restored rather than demanding a human.
    await expect(fetchGroupInstances("grp_test")).rejects.toThrow(/auto-reconnected/);

    const row = await readSession();
    expect(row?.authCookie).toBe("cookie-FRESH"); // NOT nulled by the stale 401
  });

  it("auto-reconnects with the remembered 2FA device when the cookie is confirmed dead", async () => {
    process.env.VRCHAT_USERNAME = "bot";
    process.env.VRCHAT_PASSWORD = "pw";
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/groups/")) return jsonResponse({}, { status: 401 });
      if (u.includes("/auth/user")) {
        const headers = new Headers(init?.headers as Record<string, string> | undefined);
        if (headers.get("Authorization")?.startsWith("Basic ")) {
          // Password login with remembered twoFactorAuth cookie: no challenge.
          return jsonResponse(
            { id: "usr_x", displayName: "Bot", requiresTwoFactorAuth: [] },
            { setCookies: ["auth=cookie-NEW; Path=/; HttpOnly"] },
          );
        }
        return jsonResponse({}, { status: 401 }); // confirm check: cookie dead
      }
      return jsonResponse({}, { status: 500 });
    }) as typeof fetch;

    await expect(fetchGroupInstances("grp_test")).rejects.toThrow(/auto-reconnected/);

    const row = await readSession();
    expect(row?.authCookie).toBe("cookie-NEW"); // fresh session, no staff action
    expect(row?.twoFactorCookie).toBe("tfa-A");
    expect(row?.lastError).toBeNull();
  });

  it("falls back to manual reconnect when the auto-reconnect login fails", async () => {
    process.env.VRCHAT_USERNAME = "bot";
    process.env.VRCHAT_PASSWORD = "pw";
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/groups/")) return jsonResponse({}, { status: 401 });
      if (u.includes("/auth/user")) {
        const headers = new Headers(init?.headers as Record<string, string> | undefined);
        if (headers.get("Authorization")?.startsWith("Basic ")) {
          return jsonResponse({ error: "too many attempts" }, { status: 429 });
        }
        return jsonResponse({}, { status: 401 });
      }
      return jsonResponse({}, { status: 500 });
    }) as typeof fetch;

    await expect(fetchGroupInstances("grp_test")).rejects.toThrow(SESSION_EXPIRED_MSG);

    const row = await readSession();
    expect(row?.authCookie).toBeNull();
    expect(row?.twoFactorCookie).toBe("tfa-A");
  });
});

describe("maintainVrchatSession", () => {
  const ADMIN_ID = "vrc-maint-admin";

  beforeEach(async () => {
    await db
      .insert(users)
      .values({ id: ADMIN_ID, discordId: "999000111", username: "admin-tester", roles: ["admin"] })
      .onConflictDoUpdate({ target: users.id, set: { roles: ["admin"] } });
    await db.delete(notifications).where(eq(notifications.userId, ADMIN_ID));
  });

  it("is a no-op (returns true) while the session is healthy", async () => {
    process.env.VRCHAT_USERNAME = "bot";
    process.env.VRCHAT_PASSWORD = "pw";
    const fetchSpy = vi.fn(async () => jsonResponse([])) as typeof fetch;
    global.fetch = fetchSpy;

    await expect(maintainVrchatSession()).resolves.toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("auto-reconnects with the remembered 2FA device when the cookie is gone", async () => {
    process.env.VRCHAT_USERNAME = "bot";
    process.env.VRCHAT_PASSWORD = "pw";
    await db
      .update(vrchatSessions)
      .set({ authCookie: null })
      .where(eq(vrchatSessions.id, SESSION_ID));
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/auth/user")) {
        const headers = new Headers(init?.headers as Record<string, string> | undefined);
        if (headers.get("Authorization")?.startsWith("Basic ")) {
          return jsonResponse(
            { id: "usr_x", displayName: "Bot", requiresTwoFactorAuth: [] },
            { setCookies: ["auth=cookie-CRON; Path=/; HttpOnly"] },
          );
        }
        return jsonResponse({ id: "usr_x", displayName: "Bot" });
      }
      return jsonResponse({}, { status: 500 });
    }) as typeof fetch;

    await expect(maintainVrchatSession()).resolves.toBe(true);
    const row = await readSession();
    expect(row?.authCookie).toBe("cookie-CRON");
    // Successful reconnect ends the disconnected episode.
    expect(row?.disconnectedSince).toBeNull();
    // Healthy reconnect: no admin notifications.
    const rows = await db.select().from(notifications).where(eq(notifications.userId, ADMIN_ID));
    expect(rows).toHaveLength(0);
  });

  it("only one login attempt per cooldown window, even across concurrent ticks (no stampede)", async () => {
    process.env.VRCHAT_USERNAME = "bot";
    process.env.VRCHAT_PASSWORD = "pw";
    await db
      .update(vrchatSessions)
      .set({ authCookie: null })
      .where(eq(vrchatSessions.id, SESSION_ID));
    let loginAttempts = 0;
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/auth/user")) {
        const headers = new Headers(init?.headers as Record<string, string> | undefined);
        if (headers.get("Authorization")?.startsWith("Basic ")) {
          loginAttempts += 1;
          // Login fails (e.g. VRChat demands an email code) so the session
          // stays down and later ticks WOULD retry if the cooldown let them.
          return jsonResponse({ requiresTwoFactorAuth: ["emailOtp"] });
        }
        return jsonResponse({}, { status: 401 });
      }
      return jsonResponse({}, { status: 500 });
    }) as typeof fetch;

    // Two "instances" tick concurrently, plus one more right after: only the
    // claim winner may log in — the persisted cooldown blocks the rest.
    await Promise.all([maintainVrchatSession(), maintainVrchatSession()]);
    await expect(maintainVrchatSession()).resolves.toBe(false);
    expect(loginAttempts).toBe(1);

    const row = await readSession();
    expect(row?.lastAutoReconnectAt).not.toBeNull();
  });

  it("notifies admins once per episode, but only after the grace window has elapsed", async () => {
    process.env.VRCHAT_USERNAME = "bot";
    process.env.VRCHAT_PASSWORD = "pw";
    await db
      .update(vrchatSessions)
      .set({ authCookie: null })
      .where(eq(vrchatSessions.id, SESSION_ID));
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/auth/user")) {
        const headers = new Headers(init?.headers as Record<string, string> | undefined);
        if (headers.get("Authorization")?.startsWith("Basic ")) {
          // Login answered with an email-code challenge → human required.
          return jsonResponse({ requiresTwoFactorAuth: ["emailOtp"] });
        }
        return jsonResponse({}, { status: 401 });
      }
      return jsonResponse({}, { status: 500 });
    }) as typeof fetch;

    // First tick: episode starts, still inside the grace window → NO alert yet.
    await expect(maintainVrchatSession()).resolves.toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    let rows = await db.select().from(notifications).where(eq(notifications.userId, ADMIN_ID));
    expect(rows).toHaveLength(0);
    const afterFirst = await readSession();
    expect(afterFirst?.disconnectedSince).not.toBeNull();

    // Backdate the episode start past the grace window: the next tick alerts.
    await db
      .update(vrchatSessions)
      .set({ disconnectedSince: new Date(Date.now() - 25 * 60 * 1000) })
      .where(eq(vrchatSessions.id, SESSION_ID));
    await __resetAutoReconnectCooldownForTests();
    await expect(maintainVrchatSession()).resolves.toBe(false);
    // notify runs fire-and-forget; give it a beat to land.
    await vi.waitFor(async () => {
      const got = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, ADMIN_ID));
      expect(got).toHaveLength(1);
      expect(got[0]?.type).toBe("vrchat_session");
    });

    // Another tick within the cooldown window: no duplicate notification.
    await __resetAutoReconnectCooldownForTests();
    await expect(maintainVrchatSession()).resolves.toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    rows = await db.select().from(notifications).where(eq(notifications.userId, ADMIN_ID));
    expect(rows).toHaveLength(1);
  });

  it("returns false without notifying when credentials are not configured", async () => {
    await db
      .update(vrchatSessions)
      .set({ authCookie: null })
      .where(eq(vrchatSessions.id, SESSION_ID));
    const fetchSpy = vi.fn(async () => jsonResponse([])) as typeof fetch;
    global.fetch = fetchSpy;

    await expect(maintainVrchatSession()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 100));
    const rows = await db.select().from(notifications).where(eq(notifications.userId, ADMIN_ID));
    expect(rows).toHaveLength(0);
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

describe("claimVrchatPollTick sticky ownership", () => {
  const setClaim = (pollOwner: string | null, ageMs: number | null) =>
    db
      .update(vrchatSessions)
      .set({
        pollOwner,
        lastPollTickAt: ageMs == null ? null : new Date(Date.now() - ageMs),
      })
      .where(eq(vrchatSessions.id, SESSION_ID));

  beforeEach(async () => {
    await seedSession();
  });

  it("claims when nobody has ticked yet (bootstrap) and records ownership", async () => {
    await setClaim(null, null);
    await expect(claimVrchatPollTick()).resolves.toBe(true);
    const [row] = await db.select().from(vrchatSessions).where(eq(vrchatSessions.id, SESSION_ID));
    expect(row?.pollOwner).toBeTruthy();
    // Immediate re-claim by the SAME instance is rejected (tick window).
    await expect(claimVrchatPollTick()).resolves.toBe(false);
  });

  it("owner renews after the tick window elapses", async () => {
    await setClaim(null, null);
    await expect(claimVrchatPollTick()).resolves.toBe(true);
    const [row] = await db.select().from(vrchatSessions).where(eq(vrchatSessions.id, SESSION_ID));
    // Backdate our own tick past the 100s window but well inside takeover.
    await setClaim(row!.pollOwner, 120 * 1000);
    await expect(claimVrchatPollTick()).resolves.toBe(true);
  });

  it("rejects a different instance while the owner is alive, even past the tick window", async () => {
    await setClaim("some-other-instance", 120 * 1000);
    await expect(claimVrchatPollTick()).resolves.toBe(false);
    await expect(isVrchatPollOwner()).resolves.toBe(false);
  });

  it("takes over from a dead owner after the takeover window", async () => {
    await setClaim("some-other-instance", 6 * 60 * 1000);
    await expect(isVrchatPollOwner()).resolves.toBe(true);
    await expect(claimVrchatPollTick()).resolves.toBe(true);
    const [row] = await db.select().from(vrchatSessions).where(eq(vrchatSessions.id, SESSION_ID));
    expect(row?.pollOwner).not.toBe("some-other-instance");
  });

  it("isVrchatPollOwner is true for the owning instance and non-consuming", async () => {
    await setClaim(null, null);
    await expect(claimVrchatPollTick()).resolves.toBe(true);
    await expect(isVrchatPollOwner()).resolves.toBe(true);
    await expect(isVrchatPollOwner()).resolves.toBe(true);
  });
});
