import { eq } from "drizzle-orm";
import { db, users } from "@workspace/db";
import { logger } from "./logger";
import { DISCORD_GUILD_ID, externalWritesAllowed } from "./discord";

const TOKEN = process.env.UNBELIEVABOAT_TOKEN ?? process.env.UNBELIEVABOAT_API_TOKEN ?? "";
const API = "https://unbelievaboat.com/api/v1";
// Cap every UB round-trip so a slow/hung external API can't tie up a request
// worker indefinitely. The catch blocks below treat an AbortError like any
// other failure, so callers fall through their normal failure paths.
const UB_TIMEOUT_MS = 10_000;

// Short-lived in-memory cache so a single page load (dashboard summary + wallet
// all asking for the same player) doesn't fan out into multiple upstream calls,
// and a hung UB API doesn't stall every concurrent request.
//
// TTL is deliberately short: balances also change via Discord-side economy
// commands (!work, !crime, ...) that we never observe here, so a longer TTL
// would show stale numbers after those. Website-side writes go through
// patchBalance(), which refreshes/invalidates the entry immediately.
const BALANCE_CACHE_TTL_MS = 30_000;
const balanceCache = new Map<string, { value: UbBalance; expires: number }>();
// In-flight live fetches, so concurrent cache misses collapse into ONE upstream
// request (single-flight) instead of N parallel calls each waiting out the
// 10s timeout.
const inflight = new Map<string, Promise<UbBalance | null>>();
// Monotonic per-user counter bumped on every write. A live read captures the
// generation when it starts; if a write lands before the read resolves, the
// read refuses to overwrite the (newer, authoritative) cache entry.
const generation = new Map<string, number>();

function bumpGeneration(discordUserId: string): void {
  generation.set(discordUserId, (generation.get(discordUserId) ?? 0) + 1);
}

export interface UbBalance {
  cash: number;
  bank: number;
  total: number;
  source: "unbelievaboat" | "local";
}

// Last value we successfully synced from UB, persisted on the user row. Used as
// a degraded fallback (only when the caller opts in via allowStale) when the
// live API is down. We only persist the total, so the split is unknown — surface
// it all as `cash` (the spendable figure) and mark source:"local" so callers/UI
// can flag it as an estimate.
async function localBalanceFallback(discordUserId: string): Promise<UbBalance | null> {
  try {
    const [u] = await db
      .select({ lastSynced: users.lastSyncedUbBalance })
      .from(users)
      .where(eq(users.discordId, discordUserId));
    if (!u || u.lastSynced == null) return null;
    return { cash: u.lastSynced, bank: 0, total: u.lastSynced, source: "local" };
  } catch (err) {
    logger.error({ err }, "UB local balance fallback error");
    return null;
  }
}

// One live UB fetch. Returns null on any failure (caller decides whether to fall
// back). On success, populates the cache unless a write bumped the generation
// while this fetch was in flight (avoids clobbering a newer post-write value).
async function fetchLiveBalance(discordUserId: string): Promise<UbBalance | null> {
  const gen = generation.get(discordUserId) ?? 0;
  try {
    const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/users/${discordUserId}`, {
      headers: { Authorization: TOKEN },
      signal: AbortSignal.timeout(UB_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "UB balance fetch failed");
      return null;
    }
    const data = (await res.json()) as { cash: number; bank: number; total: number };
    const value: UbBalance = { cash: data.cash, bank: data.bank, total: data.total, source: "unbelievaboat" };
    if ((generation.get(discordUserId) ?? 0) === gen) {
      balanceCache.set(discordUserId, { value, expires: Date.now() + BALANCE_CACHE_TTL_MS });
    }
    return value;
  } catch (err) {
    logger.error({ err }, "UB getBalance error");
    return null;
  }
}

/**
 * Read a player's UnbelievaBoat balance.
 *
 * Serves a fresh cached value if present, otherwise performs a single-flight
 * live fetch. On live-fetch failure it returns `null` by default — preserving
 * the strict behavior money-movement and sync callers rely on. Pure display
 * callers may pass `allowStale: true` to instead receive the last-known DB value
 * (`source: "local"`); they should surface that source so the UI can flag it.
 */
export async function getBalance(
  discordUserId: string,
  opts?: { allowStale?: boolean },
): Promise<UbBalance | null> {
  if (!TOKEN || !DISCORD_GUILD_ID) return null;

  const cached = balanceCache.get(discordUserId);
  if (cached && cached.expires > Date.now()) return cached.value;

  let p = inflight.get(discordUserId);
  if (!p) {
    p = fetchLiveBalance(discordUserId).finally(() => {
      inflight.delete(discordUserId);
    });
    inflight.set(discordUserId, p);
  }
  const live = await p;
  if (live) return live;

  // Live fetch failed. Don't cache the failure (retry the API next call); only
  // degrade to the DB value when the caller explicitly accepts a stale read.
  return opts?.allowStale ? await localBalanceFallback(discordUserId) : null;
}

export async function patchBalance(
  discordUserId: string,
  delta: { cash?: number; bank?: number; reason?: string },
): Promise<UbBalance | null> {
  if (!TOKEN || !DISCORD_GUILD_ID) return null;
  if (!externalWritesAllowed()) {
    logger.info(
      { discordUserId },
      "UB write suppressed (non-deployment env); skipping balance patch",
    );
    return null;
  }
  try {
    const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/users/${discordUserId}`, {
      method: "PATCH",
      headers: { Authorization: TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(delta),
      signal: AbortSignal.timeout(UB_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, body: await res.text() }, "UB patch failed");
      // The write may have partially applied (or its result is unknown): bump +
      // drop any cached value so the next read re-fetches the truth and no
      // in-flight read repopulates a pre-write balance.
      bumpGeneration(discordUserId);
      balanceCache.delete(discordUserId);
      return null;
    }
    const data = (await res.json()) as { cash: number; bank: number; total: number };
    const value: UbBalance = { cash: data.cash, bank: data.bank, total: data.total, source: "unbelievaboat" };
    // We just changed the balance: bump the generation (so any concurrent
    // in-flight read can't repopulate the cache with a pre-write value) and
    // refresh the cache with the authoritative post-write figure.
    bumpGeneration(discordUserId);
    balanceCache.set(discordUserId, { value, expires: Date.now() + BALANCE_CACHE_TTL_MS });
    return value;
  } catch (err) {
    logger.error({ err }, "UB patchBalance error");
    // The write may have partially applied; bump + drop any cached value so the
    // next read re-fetches the truth and no in-flight read repopulates stale.
    bumpGeneration(discordUserId);
    balanceCache.delete(discordUserId);
    return null;
  }
}
