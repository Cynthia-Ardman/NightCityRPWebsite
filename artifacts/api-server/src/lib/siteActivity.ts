import { db, siteActivityDaily } from "@workspace/db";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Website activity tracking. Every authenticated API request counts as a
// "hit" toward that user's daily row, but writing per request would double
// the DB load — so hits accumulate in memory and flush in bulk every 30s
// (and on process shutdown, best-effort). Losing a partial batch on a crash
// is acceptable for trend analytics. Logins are rare and written directly.
// ---------------------------------------------------------------------------

const FLUSH_MS = 30_000;

// key = `${day}|${userId}`
const pending = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function recordHit(userId: string): void {
  const key = `${todayUtc()}|${userId}`;
  pending.set(key, (pending.get(key) ?? 0) + 1);
  if (!timer) {
    timer = setInterval(() => void flushSiteActivity(), FLUSH_MS);
    // Never keep the process alive just for the flusher (tests, scripts).
    timer.unref();
  }
}

export async function flushSiteActivity(): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();
  const rows = batch.map(([key, hits]) => {
    const [day, userId] = key.split("|");
    return { day, userId, hits };
  });
  try {
    await db
      .insert(siteActivityDaily)
      .values(rows)
      .onConflictDoUpdate({
        target: [siteActivityDaily.day, siteActivityDaily.userId],
        set: { hits: sql`${siteActivityDaily.hits} + excluded.hits` },
      });
  } catch {
    // Re-queue so a transient DB hiccup doesn't drop the batch entirely.
    for (const [key, hits] of batch) pending.set(key, (pending.get(key) ?? 0) + hits);
  }
}

export async function recordLogin(userId: string): Promise<void> {
  try {
    await db
      .insert(siteActivityDaily)
      .values({ day: todayUtc(), userId, logins: 1 })
      .onConflictDoUpdate({
        target: [siteActivityDaily.day, siteActivityDaily.userId],
        set: { logins: sql`${siteActivityDaily.logins} + 1` },
      });
  } catch {
    // Analytics only — never let tracking break login.
  }
}
