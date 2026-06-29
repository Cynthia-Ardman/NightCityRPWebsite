import { db, botConfig, stores, ripperdocs } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  BUSINESS_OWNER_CHANNEL_ID,
  grantChannelViewAccess,
  revokeChannelViewAccess,
} from "./discord";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Business-owner Discord channel access.
//
// Owners (NOT employees) of a store or ripperdoc clinic get a per-member VIEW
// permission overwrite on the private business-owners channel. A user who owns
// more than one business keeps access until they own none; they lose access
// when they sell/transfer/delete their last business.
//
// `reconcileBusinessChannelAccess` is the single source of truth: it diffs the
// DESIRED set (everyone who currently owns at least one business) against the
// MANAGED set we persist in bot_config, then grants the newcomers and revokes
// the ones who no longer qualify. It is called fire-and-forget after every
// ownership-changing event (business approved, ownership transferred, business
// deleted) AND hourly from the role_sync cron, so a single failed Discord write
// self-heals on the next pass.
//
// We track the managed set in bot_config (rather than reading the channel's
// live overwrites) so reconcile only ever touches overwrites WE created — it
// can never clobber an overwrite an admin added by hand. The set only mutates
// after a Discord write actually succeeds, so off-deployment runs (where
// externalWritesAllowed() is false and every write no-ops) leave it untouched
// and retry once live.
// ---------------------------------------------------------------------------

const MANAGED_SET_KEY = "business_channel_access_granted";

// Discord snowflakes are 17-20 digit numeric strings. users.id IS the Discord
// snowflake for real members, but legacy/stub owner rows can carry a non-
// snowflake id — skip those so we never PUT a garbage member id to Discord.
function isSnowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

async function readManagedSet(): Promise<Set<string>> {
  try {
    const [row] = await db.select().from(botConfig).where(eq(botConfig.key, MANAGED_SET_KEY));
    const value = row?.value;
    if (Array.isArray(value)) {
      return new Set(value.filter((v): v is string => typeof v === "string"));
    }
    return new Set();
  } catch (err) {
    logger.warn({ err }, "business channel access: failed to read managed set");
    return new Set();
  }
}

async function writeManagedSet(set: Set<string>): Promise<void> {
  const value = [...set] as never;
  await db
    .insert(botConfig)
    .values({ key: MANAGED_SET_KEY, value })
    .onConflictDoUpdate({ target: botConfig.key, set: { value } });
}

/** Distinct, valid-snowflake owner ids across both business tables. */
async function currentBusinessOwnerIds(): Promise<Set<string>> {
  const [storeOwners, docOwners] = await Promise.all([
    db.selectDistinct({ ownerId: stores.ownerId }).from(stores),
    db.selectDistinct({ ownerId: ripperdocs.ownerId }).from(ripperdocs),
  ]);
  const owners = new Set<string>();
  for (const { ownerId } of [...storeOwners, ...docOwners]) {
    if (ownerId && isSnowflake(ownerId)) owners.add(ownerId);
  }
  return owners;
}

/**
 * Reconcile the business-owners channel overwrites with the current set of
 * business owners. Idempotent; steady-state makes zero Discord calls. Returns
 * how many grants + revokes were applied (0 off-deployment, where writes no-op).
 *
 * Runs are serialized in-process (see the chain below): the bot_config managed
 * set is read-modify-written, so two overlapping fire-and-forget reconciles
 * could otherwise lose an update or double-call Discord. Each queued call still
 * executes (no coalescing) so a change that lands mid-run is never skipped.
 */
let reconcileChain: Promise<unknown> = Promise.resolve();
export function reconcileBusinessChannelAccess(): Promise<{ granted: number; revoked: number }> {
  const run = reconcileChain.then(doReconcile, doReconcile);
  // Swallow rejections on the chain itself so one failed run can't poison the
  // queue; the returned promise still surfaces the real result/rejection.
  reconcileChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function doReconcile(): Promise<{ granted: number; revoked: number }> {
  const desired = await currentBusinessOwnerIds();
  const managed = await readManagedSet();

  const toGrant = [...desired].filter((id) => !managed.has(id));
  const toRevoke = [...managed].filter((id) => !desired.has(id));

  if (toGrant.length === 0 && toRevoke.length === 0) {
    return { granted: 0, revoked: 0 };
  }

  let granted = 0;
  let revoked = 0;
  let changed = false;

  for (const discordId of toGrant) {
    const res = await grantChannelViewAccess(discordId, BUSINESS_OWNER_CHANNEL_ID);
    if (res.ok) {
      managed.add(discordId);
      granted++;
      changed = true;
    } else {
      // Left out of the managed set so the next reconcile retries it.
      logger.warn({ discordId, error: res.error }, "business channel access: grant did not apply; will retry");
    }
  }

  for (const discordId of toRevoke) {
    const res = await revokeChannelViewAccess(discordId, BUSINESS_OWNER_CHANNEL_ID);
    if (res.ok) {
      managed.delete(discordId);
      revoked++;
      changed = true;
    } else {
      // Kept in the managed set so the next reconcile retries the revoke.
      logger.warn({ discordId, error: res.error }, "business channel access: revoke did not apply; will retry");
    }
  }

  if (changed) {
    try {
      await writeManagedSet(managed);
    } catch (err) {
      logger.error({ err }, "business channel access: failed to persist managed set");
    }
  }

  return { granted, revoked };
}
