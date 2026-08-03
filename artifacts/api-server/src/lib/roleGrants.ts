import { and, eq, sql } from "drizzle-orm";
import { db, pendingRoleGrants } from "@workspace/db";
import {
  addGuildMemberRole,
  externalWritesAllowed,
  fetchGuildMemberRoleIdsViaBot,
  postToChannel,
} from "./discord";
import { logger } from "./logger";

const CS_CHANNEL_ID = process.env.CS_APPROVAL_CHANNEL_ID ?? "";

// Alert staff once a grant has failed this many REAL attempts (an immediate
// attempt at approval time + hourly role_sync retries). Retrying continues
// after the alert until the grant finally lands.
const ALERT_AFTER_ATTEMPTS = 3;

/**
 * Durable, at-least-once Discord role grant.
 *
 * Persists a `pending_role_grants` row FIRST (so the intent survives a crash
 * or a Discord outage), then attempts the grant immediately. On failure the
 * row stays pending and the hourly role_sync cron retries it until it lands
 * (`retryPendingRoleGrants`). Once granted we never touch the role again —
 * staff manually removing it later is respected.
 *
 * Suppressed writes (dev/test, `externalWritesAllowed()` false) leave the row
 * pending WITHOUT counting an attempt, so test environments never alert.
 *
 * Callers may `void` this — it never throws.
 */
export async function grantRoleDurable(userId: string, roleId: string, reason: string): Promise<void> {
  try {
    await db
      .insert(pendingRoleGrants)
      .values({ userId, roleId, reason })
      .onConflictDoNothing({
        target: [pendingRoleGrants.userId, pendingRoleGrants.roleId],
        where: sql`status = 'pending'`,
      });
    await attemptPendingGrant(userId, roleId, reason);
  } catch (err) {
    // The pending row (if it got in) will be retried by role_sync.
    logger.warn({ err, userId, roleId }, "grantRoleDurable failed; role_sync will retry");
  }
}

/** One grant attempt against Discord + bookkeeping on the pending row. */
async function attemptPendingGrant(userId: string, roleId: string, reason: string): Promise<boolean> {
  if (!externalWritesAllowed()) {
    // Off-deployment: don't burn attempts or alert; the row simply waits.
    logger.info({ userId, roleId }, "role grant deferred (external writes suppressed)");
    return false;
  }
  // Read-before-write: if the member ALREADY holds the role, finalize without
  // a Discord write. This heals the crash window where a previous grant
  // succeeded but the row wasn't flipped, and guarantees we never re-grant a
  // role a staff member could have removed in the meantime. A failed read
  // (null) falls through to the normal grant attempt.
  const held = await fetchGuildMemberRoleIdsViaBot(userId);
  const r = held?.includes(roleId)
    ? ({ ok: true } as const)
    : await addGuildMemberRole(userId, roleId, reason);
  if (r.ok) {
    await db
      .update(pendingRoleGrants)
      .set({ status: "granted", grantedAt: new Date(), lastAttemptAt: new Date(), lastError: null })
      .where(
        and(
          eq(pendingRoleGrants.userId, userId),
          eq(pendingRoleGrants.roleId, roleId),
          eq(pendingRoleGrants.status, "pending"),
        ),
      );
    return true;
  }
  await db
    .update(pendingRoleGrants)
    .set({
      attempts: sql`${pendingRoleGrants.attempts} + 1`,
      lastError: r.error.slice(0, 500),
      lastAttemptAt: new Date(),
    })
    .where(
      and(
        eq(pendingRoleGrants.userId, userId),
        eq(pendingRoleGrants.roleId, roleId),
        eq(pendingRoleGrants.status, "pending"),
      ),
    );
  logger.warn({ userId, roleId, error: r.error }, "role grant attempt failed; will retry");
  return false;
}

/**
 * Hourly role_sync sweep: retry every pending grant; after
 * ALERT_AFTER_ATTEMPTS real failures post ONE staff alert to the CS approval
 * channel (and keep retrying). Returns counts for the job summary line.
 */
export async function retryPendingRoleGrants(): Promise<{ retried: number; granted: number; alerted: number }> {
  const out = { retried: 0, granted: 0, alerted: 0 };
  if (!externalWritesAllowed()) return out;
  const rows = await db.select().from(pendingRoleGrants).where(eq(pendingRoleGrants.status, "pending"));
  for (const row of rows) {
    out.retried++;
    const ok = await attemptPendingGrant(row.userId, row.roleId, row.reason);
    if (ok) {
      out.granted++;
      continue;
    }
    if (!CS_CHANNEL_ID) continue;
    // Atomically CLAIM the alert (alerted_at IS NULL guard) before posting so
    // two overlapping sweeps can never double-post; if the post then fails,
    // release the claim so a later sweep alerts instead.
    const claimed = await db
      .update(pendingRoleGrants)
      .set({ alertedAt: new Date() })
      .where(
        and(
          eq(pendingRoleGrants.id, row.id),
          eq(pendingRoleGrants.status, "pending"),
          sql`${pendingRoleGrants.alertedAt} IS NULL`,
          sql`${pendingRoleGrants.attempts} >= ${ALERT_AFTER_ATTEMPTS}`,
        ),
      )
      .returning({ id: pendingRoleGrants.id, attempts: pendingRoleGrants.attempts, lastError: pendingRoleGrants.lastError });
    if (!claimed.length) continue;
    const cur = claimed[0];
    const msg =
      `⚠️ **Role grant keeps failing** — could not grant role <@&${row.roleId}> to <@${row.userId}> ` +
      `after ${cur.attempts} attempts.\nContext: ${row.reason || "(none)"}\n` +
      `Last error: ${cur.lastError ?? "unknown"}\n` +
      `The system keeps retrying hourly. Granting the role manually also resolves it.`;
    const posted = await postToChannel(CS_CHANNEL_ID, msg);
    if (posted) {
      out.alerted++;
    } else {
      await db
        .update(pendingRoleGrants)
        .set({ alertedAt: null })
        .where(eq(pendingRoleGrants.id, row.id));
    }
  }
  return out;
}
