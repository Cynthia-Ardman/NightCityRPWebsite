import { db, users, walletTransactions, botConfig, ubPushOutbox } from "@workspace/db";
import { eq, and, isNull, sql, inArray, asc, desc } from "drizzle-orm";
import { logger } from "./logger";
import { isSystemLive } from "./liveMode";
import { externalWritesAllowed } from "./discord";
import { getBalance, patchBalance } from "./unbelievaboat";

// ---------------------------------------------------------------------------
// Economy foundation: the WEBSITE wallet is the source of truth.
//
// Every website-side player money change commits atomically against
// users.walletBalance + the wallet_transactions ledger FIRST (no external call
// in the critical path), and enqueues a ub_push_outbox row in the SAME
// transaction. A background drain mirrors those deltas into UnbelievaBoat
// (per-user ordered, retried with backoff, drains on recovery), so money on
// the site keeps working even while the UB bot is down.
//
// UnbelievaBoat-side activity (blackjack, !work/!crime, moderator commands)
// still flows back INTO the website wallet via the reconcile cron: a user's
// lastSyncedUbBalance is the "expected UB total" baseline — it advances ONLY
// when a push lands (or reconcile folds an external delta), so any UB reading
// beyond it is a genuinely external Discord-side change, imported as a
// clearly-labeled reconciliation ledger row. Pending pushes do NOT move the
// baseline, which is exactly what keeps "our push hasn't landed yet" and
// "someone gambled on Discord" from double-counting each other.
//
// Processing mode is a TRI-STATE derived from two existing bot_config patterns:
//   - `economy_enabled` (kill switch, like AUTOBILL_FLAGS) — OFF => "disabled".
//   - the `economy` LiveSystem (master AND economy_live_mode) — decides
//     "test" (dry-run) vs "enabled" (live) once the kill switch is ON.
//
//   disabled  -> do nothing (no balance/ledger/outbox writes)
//   test      -> compute + log proposed change, write nothing
//   enabled   -> live: commit balance + ledger + outbox atomically
//
// Paths that carry their OWN Test/Live gates (mission payouts, autobill crons,
// admin actions) pass gate: "none" so the economy kill-switch keeps its
// original scope (portal economy commands) and their gates keep theirs.
// ---------------------------------------------------------------------------

export type EconomyMode = "disabled" | "test" | "enabled";

/** bot_config kill-switch key. OFF (default) => the economy system is disabled. */
export const ECONOMY_ENABLED_KEY = "economy_enabled";

// Wallet balances are stored as Postgres int4 columns, which top out at
// 2,147,483,647. A credit that would push a balance past this would overflow
// the column and throw at write time, so applyWalletDelta rejects it cleanly
// (status "exceeds_max") before any write.
export const MAX_WALLET_BALANCE = 2_147_483_647;
// Signed int4 minimum — the floor for the same wallet columns.
export const MIN_WALLET_BALANCE = -2_147_483_648;

// Clamp a balance to the int4 range so a write can never overflow the column.
function clampInt4(n: number): number {
  return Math.max(MIN_WALLET_BALANCE, Math.min(MAX_WALLET_BALANCE, Math.trunc(n)));
}

async function readBool(key: string): Promise<boolean> {
  try {
    const [row] = await db.select().from(botConfig).where(eq(botConfig.key, key));
    return row?.value === true;
  } catch (err) {
    logger.warn({ err, key }, "economy flag read failed; treating as OFF");
    return false;
  }
}

/** Resolve the current tri-state economy processing mode. */
export async function getEconomyMode(): Promise<EconomyMode> {
  const enabled = await readBool(ECONOMY_ENABLED_KEY);
  if (!enabled) return "disabled";
  const live = await isSystemLive("economy");
  return live ? "enabled" : "test";
}

export type WalletSource =
  | "website"
  | "ub"
  | "reconciliation"
  | "mission"
  | "store"
  | "ripperdoc"
  | "commission"
  | "admin";

export interface ApplyWalletDeltaInput {
  /** The website user whose wallet moves. */
  userId: string;
  /** Discord id used for the UB mirror push. */
  discordId: string;
  /** Signed delta in eddies (mirrored to UB cash). */
  amount: number;
  source: WalletSource;
  /** Ledger `kind` label, e.g. "store_deposit". */
  kind: string;
  /** Human-readable reason shown in UB. */
  reason: string;
  memo?: string | null;
  characterId?: number | null;
  counterpartyCharacterId?: number | null;
  counterpartyName?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: number | null;
  storeId?: number | null;
  ripperdocId?: number | null;
  /** Idempotency key — a retry with the same key never applies twice. */
  idempotencyKey?: string | null;
  /** When false (default) a debit that would overdraw the wallet is rejected. */
  allowNegative?: boolean;
  /**
   * Which processing gate applies. "economy" (default) honors the economy
   * kill-switch + Test/Live tri-state. "none" always commits live — for paths
   * that carry their OWN gates (mission live mode, autobill kill switches,
   * admin actions) and would otherwise be double-gated.
   */
  gate?: "economy" | "none";
}

export type WalletApplyStatus =
  | "synced"
  | "failed"
  | "disabled"
  | "dry_run"
  | "duplicate"
  | "pending"
  | "insufficient_funds"
  | "exceeds_max";

export interface WalletApplyResult {
  ok: boolean;
  status: WalletApplyStatus;
  /** Current website balance after the call (unchanged unless status==="synced"). */
  balance: number;
  previousBalance: number;
  /** The balance the change WOULD produce (useful for dry-run / failure UIs). */
  proposedBalance: number;
  ledgerId?: number;
  error?: string;
}

async function readWalletBalance(userId: string): Promise<number> {
  const [u] = await db
    .select({ balance: users.walletBalance })
    .from(users)
    .where(eq(users.id, userId));
  return u?.balance ?? 0;
}

// Enqueue a UB mirror push inside the caller's transaction. Zero-amount rows
// are skipped (nothing to mirror).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function enqueueUbPush(
  tx: Tx,
  row: { userId: string; discordId: string; amount: number; reason: string | null; ledgerId: number | null },
): Promise<void> {
  if (row.amount === 0) return;
  await tx.insert(ubPushOutbox).values({
    userId: row.userId,
    discordId: row.discordId,
    amount: row.amount,
    reason: row.reason,
    ledgerId: row.ledgerId,
  });
}

type CommitOutcome =
  | { kind: "ok"; prev: number; proposed: number; ledgerId: number }
  | { kind: "duplicate"; prev: number; ledgerId: number; prevBalance: number }
  | { kind: "legacy_pending"; prev: number; ledgerId: number }
  | { kind: "insufficient"; prev: number }
  | { kind: "exceeds"; prev: number }
  | { kind: "no_user" };

/**
 * The single idempotent entry point for every website-originated player wallet
 * change. Commits website balance + ledger + UB outbox atomically; the UB
 * mirror push happens out-of-band (see drainUbPushOutbox). See module header.
 */
export async function applyWalletDelta(input: ApplyWalletDeltaInput): Promise<WalletApplyResult> {
  const mode = input.gate === "none" ? "enabled" : await getEconomyMode();

  if (mode === "disabled" || mode === "test") {
    const prev = await readWalletBalance(input.userId);
    const proposed = prev + input.amount;
    if (mode === "disabled") {
      return { ok: false, status: "disabled", balance: prev, previousBalance: prev, proposedBalance: proposed };
    }
    logger.info(
      { userId: input.userId, amount: input.amount, source: input.source, kind: input.kind, prev, proposed },
      "economy dry-run (test mode): no balance/ledger/outbox writes",
    );
    return { ok: true, status: "dry_run", balance: prev, previousBalance: prev, proposedBalance: proposed };
  }

  // ---- enabled (live): one atomic website-first transaction ----
  const commit = (): Promise<CommitOutcome> =>
    db.transaction(async (tx): Promise<CommitOutcome> => {
      // Idempotency: a prior settled row for this key short-circuits; a prior
      // FAILED row (legacy UB-first flow) is reused for the retry. Legacy
      // 'pending' rows (reserved pre-cutover, UB outcome unknown) stay ambiguous.
      let existing: typeof walletTransactions.$inferSelect | undefined;
      if (input.idempotencyKey) {
        [existing] = await tx
          .select()
          .from(walletTransactions)
          .where(eq(walletTransactions.idempotencyKey, input.idempotencyKey));
        if (existing && existing.syncStatus !== "failed") {
          if (existing.syncStatus === "pending") {
            const bal = await readWalletBalance(input.userId);
            return { kind: "legacy_pending", prev: bal, ledgerId: existing.id };
          }
          const bal = await readWalletBalance(input.userId);
          return { kind: "duplicate", prev: bal, ledgerId: existing.id, prevBalance: existing.previousBalance ?? bal };
        }
      }

      // Lock the user row so the balance check + relative increment are atomic
      // against concurrent deltas / reconcile for the same user.
      const [u] = await tx
        .select({ balance: users.walletBalance })
        .from(users)
        .where(eq(users.id, input.userId))
        .for("update");
      if (!u) return { kind: "no_user" };
      const prev = u.balance ?? 0;
      const proposed = prev + input.amount;

      // Overdraw protection (debits only) — authorized against the WEBSITE
      // balance, the source of truth. (A live-UB self-heal retry happens in the
      // caller below, outside this transaction.)
      if (!input.allowNegative && input.amount < 0 && proposed < 0) {
        return { kind: "insufficient", prev };
      }
      // Overflow protection (credits only) — int4 ceiling.
      if (input.amount > 0 && proposed > MAX_WALLET_BALANCE) {
        return { kind: "exceeds", prev };
      }

      const values = {
        characterId: input.characterId ?? null,
        userId: input.userId,
        counterpartyCharacterId: input.counterpartyCharacterId ?? null,
        counterpartyName: input.counterpartyName ?? null,
        amount: input.amount,
        kind: input.kind,
        memo: input.memo ?? null,
        source: input.source,
        // The website wallet settled this change; UB mirroring is tracked in
        // the outbox, not here.
        syncStatus: "synced" as const,
        idempotencyKey: input.idempotencyKey ?? null,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        previousBalance: prev,
        newBalance: proposed,
        errorMessage: null as string | null,
        storeId: input.storeId ?? null,
        ripperdocId: input.ripperdocId ?? null,
      };

      let ledgerId: number;
      if (existing) {
        // Reuse the failed row so a key never spawns duplicates.
        await tx
          .update(walletTransactions)
          .set({ ...values, createdAt: new Date() })
          .where(eq(walletTransactions.id, existing.id));
        ledgerId = existing.id;
      } else {
        const inserted = await tx
          .insert(walletTransactions)
          .values(values)
          .onConflictDoNothing({ target: walletTransactions.idempotencyKey })
          .returning({ id: walletTransactions.id });
        if (inserted.length === 0) {
          // A concurrent writer landed this same key first; it owns the change.
          const [dup] = await tx
            .select()
            .from(walletTransactions)
            .where(eq(walletTransactions.idempotencyKey, input.idempotencyKey!));
          return { kind: "duplicate", prev, ledgerId: dup?.id ?? 0, prevBalance: dup?.previousBalance ?? prev };
        }
        ledgerId = inserted[0].id;
      }

      await tx
        .update(users)
        .set({ walletBalance: sql`${users.walletBalance} + ${input.amount}` })
        .where(eq(users.id, input.userId));

      await enqueueUbPush(tx, {
        userId: input.userId,
        discordId: input.discordId,
        amount: input.amount,
        reason: input.reason ?? null,
        ledgerId,
      });

      return { kind: "ok", prev, proposed, ledgerId };
    });

  let out = await commit();

  // Insufficient by the website's number: the mirror can briefly lag genuinely
  // external Discord-side earnings (up to one reconcile interval). Before
  // refusing, check live UB — if live cash covers the debit, fold the external
  // delta in via the same guarded per-user reconcile the cron uses, then retry
  // ONCE. If UB is unreachable we keep the conservative website-based refusal.
  if (out.kind === "insufficient") {
    const live = await getBalance(input.discordId);
    if (live && live.cash + input.amount >= 0) {
      logger.info(
        { userId: input.userId, amount: input.amount, website: out.prev, liveCash: live.cash, source: input.source },
        "wallet debit covered by live UB cash despite lagging website balance; reconciling then retrying once",
      );
      const rec = await reconcileOneUser(input.userId);
      if (rec.ok && rec.status !== "dry_run") out = await commit();
    }
  }

  switch (out.kind) {
    case "no_user":
      return { ok: false, status: "failed", balance: 0, previousBalance: 0, proposedBalance: input.amount, error: "Unknown user" };
    case "insufficient":
      return { ok: false, status: "insufficient_funds", balance: out.prev, previousBalance: out.prev, proposedBalance: out.prev + input.amount };
    case "exceeds":
      return {
        ok: false,
        status: "exceeds_max",
        balance: out.prev,
        previousBalance: out.prev,
        proposedBalance: out.prev + input.amount,
        error: `This would push the wallet past the maximum balance of ${MAX_WALLET_BALANCE.toLocaleString()} eddies.`,
      };
    case "legacy_pending":
      return { ok: false, status: "pending", balance: out.prev, previousBalance: out.prev, proposedBalance: out.prev + input.amount, ledgerId: out.ledgerId, error: "A previous attempt is still pending reconciliation." };
    case "duplicate":
      return { ok: true, status: "duplicate", balance: out.prev, previousBalance: out.prevBalance, proposedBalance: out.prev, ledgerId: out.ledgerId };
    case "ok": {
      // Mirror to UB shortly (fire-and-forget; the cron drain is the safety net).
      kickUbPushDrain(input.userId);
      return { ok: true, status: "synced", balance: out.proposed, previousBalance: out.prev, proposedBalance: out.proposed, ledgerId: out.ledgerId };
    }
  }
}

/**
 * Settle a charge whose wallet_transactions ledger row the caller ALREADY
 * reserved itself (the autobill crons write their row first as the period
 * guard). Advances the website balance atomically, stamps the reserved row's
 * previous/new balance, and enqueues the UB mirror push — all in one
 * transaction. Bills may overdraw (parity with the old UB behavior of letting
 * cash go negative). Idempotency is the caller's responsibility (its reserved
 * row + billed-this-run guard already dedupe the charge).
 */
export async function settleReservedCharge(input: {
  userId: string;
  discordId: string;
  /** Signed delta (bills pass a negative amount). */
  amount: number;
  reason: string;
  ledgerId: number;
}): Promise<{ balance: number }> {
  const balance = await db.transaction(async (tx) => {
    const [u] = await tx
      .select({ balance: users.walletBalance })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!u) return null;
    const prev = u.balance ?? 0;
    const next = clampInt4(prev + input.amount);
    await tx.update(users).set({ walletBalance: next }).where(eq(users.id, input.userId));
    await tx
      .update(walletTransactions)
      .set({ previousBalance: prev, newBalance: next, syncStatus: "synced" })
      .where(eq(walletTransactions.id, input.ledgerId));
    await enqueueUbPush(tx, {
      userId: input.userId,
      discordId: input.discordId,
      amount: input.amount,
      reason: input.reason,
      ledgerId: input.ledgerId,
    });
    return next;
  });
  if (balance === null) return { balance: 0 };
  kickUbPushDrain(input.userId);
  return { balance };
}

/**
 * The documented Wallet payload shape shared by the wallet read/response
 * endpoints. `balance` is the WEBSITE wallet (source of truth). cash/bank are
 * a best-effort UB mirror snapshot for the breakdown UI: the site tracks only
 * a total, so `cash` is presented as balance − bank (bank moves remain a
 * UB-side convenience). If the mirror is unreachable everything reads as cash.
 */
export async function websiteWalletPayload(
  userId: string,
  discordId: string,
): Promise<{ balance: number; cash: number; bank: number; source: string }> {
  const balance = await readWalletBalance(userId);
  const ub = await getBalance(discordId, { allowStale: true });
  const bank = ub?.bank ?? 0;
  return { balance, cash: balance - bank, bank, source: "website" };
}

// ---------------------------------------------------------------------------
// UB push outbox drain: mirrors website-origin deltas into UnbelievaBoat.
// ---------------------------------------------------------------------------

// An inflight claim older than this is presumed crashed and reclaimed. Note the
// unavoidable at-least-once window: a crash between a successful UB PATCH and
// the pushed-mark commits the delta to UB twice on reclaim; reconcile then
// reads the extra as an external delta. This mirrors the legacy flow's crash
// window and is rare enough to accept (UB has no idempotent write API).
const UB_PUSH_STALE_CLAIM_MS = 3 * 60_000;
const UB_PUSH_MAX_ATTEMPT_BACKOFF_MS = 10 * 60_000;

function pushBackoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.min(attempts, 7), UB_PUSH_MAX_ATTEMPT_BACKOFF_MS);
}

export interface UbPushDrainResult {
  pushed: number;
  suppressed: number;
  failed: number;
}

// Claim the next actionable outbox row. Per-user ordering is enforced by the
// NOT EXISTS: a row is claimable only when no EARLIER unfinished row exists
// for the same user (a failing push therefore blocks that user's later rows).
// FOR UPDATE SKIP LOCKED makes concurrent drains (multiple autoscale
// instances) pick disjoint rows.
async function claimNextUbPush(userId?: string): Promise<
  { id: number; userId: string; discordId: string; amount: number; reason: string | null; attempts: number } | null
> {
  const userFilter = userId ? sql` AND o.user_id = ${userId}` : sql``;
  const res = await db.execute(sql`
    UPDATE ub_push_outbox SET status = 'inflight', claimed_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT o.id FROM ub_push_outbox o
      WHERE o.status = 'pending' AND o.next_attempt_at <= now()${userFilter}
        AND NOT EXISTS (
          SELECT 1 FROM ub_push_outbox p
          WHERE p.user_id = o.user_id AND p.id < o.id AND p.status IN ('pending', 'inflight')
        )
      ORDER BY o.id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, user_id, discord_id, amount, reason, attempts
  `);
  const rows = (res.rows ?? []) as Array<{ id: number; user_id: string; discord_id: string; amount: number; reason: string | null; attempts: number }>;
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, userId: r.user_id, discordId: r.discord_id, amount: r.amount, reason: r.reason, attempts: r.attempts };
}

/**
 * Drain pending UB mirror pushes (optionally for one user). Called
 * fire-and-forget after every wallet write and on a cron cadence, so pushes
 * normally land within seconds and queue up + drain automatically across a UB
 * outage. Safe to run concurrently across instances.
 */
export async function drainUbPushOutbox(opts?: { userId?: string; max?: number }): Promise<UbPushDrainResult> {
  const result: UbPushDrainResult = { pushed: 0, suppressed: 0, failed: 0 };
  // Reclaim stale inflight claims from crashed workers.
  await db.execute(sql`
    UPDATE ub_push_outbox SET status = 'pending', claimed_at = NULL
    WHERE status = 'inflight' AND claimed_at < now() - make_interval(secs => ${UB_PUSH_STALE_CLAIM_MS / 1000})
  `);
  const max = opts?.max ?? 200;
  for (let i = 0; i < max; i++) {
    const row = await claimNextUbPush(opts?.userId);
    if (!row) break;

    // Outside the deployed environment UB writes are suppressed entirely —
    // mark the row so it doesn't queue forever (the baseline is NOT advanced;
    // dev UB simply stays behind, which reconcile treats as zero external
    // delta because the baseline didn't move either).
    if (!externalWritesAllowed()) {
      await db
        .update(ubPushOutbox)
        .set({ status: "suppressed", lastError: "external writes disabled in this environment" })
        .where(eq(ubPushOutbox.id, row.id));
      result.suppressed++;
      continue;
    }

    const ub = await patchBalance(row.discordId, { cash: row.amount, reason: row.reason ?? "NCRP portal" });
    if (!ub) {
      await db
        .update(ubPushOutbox)
        .set({
          status: "pending",
          claimedAt: null,
          lastError: "UnbelievaBoat update failed",
          nextAttemptAt: new Date(Date.now() + pushBackoffMs(row.attempts)),
        })
        .where(eq(ubPushOutbox.id, row.id));
      result.failed++;
      // Ordering: this user's later rows are blocked by the NOT EXISTS until
      // this row lands; other users keep draining.
      if (opts?.userId) break;
      continue;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(ubPushOutbox)
        .set({ status: "pushed", pushedAt: new Date(), lastError: null })
        .where(eq(ubPushOutbox.id, row.id));
      // Advance the pushed-baseline (expected UB total) in lockstep. Relative
      // increment so a concurrent reconcile fold (guarded absolute set) can't
      // be clobbered — if reconcile committed first, our increment lands on
      // the new baseline, which is still correct. A never-seeded user adopts
      // the observed post-push total.
      await tx
        .update(users)
        .set({
          lastSyncedUbBalance: sql`COALESCE(${users.lastSyncedUbBalance} + ${row.amount}, ${ub.total})`,
          lastSyncedAt: new Date(),
          lastSyncStatus: "synced",
          lastSyncError: null,
        })
        .where(eq(users.id, row.userId));
    });
    result.pushed++;
  }
  return result;
}

/** Fire-and-forget drain kick (used right after enqueue so pushes land fast). */
export function kickUbPushDrain(userId?: string): void {
  void drainUbPushOutbox({ userId }).catch((err) => logger.warn({ err }, "ub push drain kick failed"));
}

// ---------------------------------------------------------------------------
// Reconcile: import external (Discord-side) UB deltas into the website wallet.
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  mode: EconomyMode;
  scanned: number;
  /** Users whose website balance changed (or would, in a dry-run). */
  changed: number;
  /** Users first-synced (no prior lastSyncedUbBalance). */
  seeded: number;
  /** Users skipped because their UB balance could not be fetched. */
  failed: number;
  dryRun: boolean;
}

// Users with unfinished pushes queued — their UB total is transiently behind
// by design. The baseline math stays correct regardless (pending pushes never
// move the baseline), but the SEED path writes an absolute balance and must
// never run while website-authoritative money is still queued.
async function hasUnfinishedPushes(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: ubPushOutbox.id })
    .from(ubPushOutbox)
    .where(and(eq(ubPushOutbox.userId, userId), inArray(ubPushOutbox.status, ["pending", "inflight"])))
    .limit(1);
  return !!row;
}

/**
 * UB->website reconciliation. Fetches each linked user's UB balance, diffs it
 * against the pushed-baseline (lastSyncedUbBalance), and folds any external
 * (Discord-side) delta into the website wallet with a clearly-labeled
 * 'reconciliation' ledger entry. NEVER touches store/ripperdoc accounts.
 * Respects the tri-state mode: disabled => no-op, test => compute + log only,
 * enabled => live writes.
 */
export async function runEconomyReconcile(): Promise<ReconcileResult> {
  const mode = await getEconomyMode();
  const result: ReconcileResult = {
    mode,
    scanned: 0,
    changed: 0,
    seeded: 0,
    failed: 0,
    dryRun: mode === "test",
  };
  if (mode === "disabled") {
    logger.info("economy reconcile skipped (disabled)");
    return result;
  }

  const allUsers = await db.select().from(users);
  for (const u of allUsers) {
    result.scanned++;
    const ub = await getBalance(u.discordId);
    if (!ub) {
      result.failed++;
      continue;
    }
    const ubTotal = ub.total;
    const lastSynced = u.lastSyncedUbBalance;

    // First-ever sync: mirror UB into the website wallet. Skipped while pushes
    // are queued — the absolute seed would clobber website-authoritative money.
    if (lastSynced === null || lastSynced === undefined) {
      if (await hasUnfinishedPushes(u.id)) continue;
      result.seeded++;
      if (mode === "test") {
        logger.info({ userId: u.id, ubTotal }, "reconcile dry-run: would seed wallet from UB");
        continue;
      }
      await db.transaction(async (tx) => {
        // Guard on the still-null baseline so a concurrent push/fold (which
        // sets lastSyncedUbBalance) can't be clobbered by this absolute seed.
        const seeded = await tx
          .update(users)
          .set({
            walletBalance: ubTotal,
            lastSyncedUbBalance: ubTotal,
            lastSyncedAt: new Date(),
            lastSyncStatus: "synced",
            lastSyncError: null,
          })
          .where(and(eq(users.id, u.id), isNull(users.lastSyncedUbBalance)))
          .returning({ balance: users.walletBalance });
        if (seeded.length === 0) return; // a concurrent writer already synced this user
        await tx.insert(walletTransactions).values({
          userId: u.id,
          amount: ubTotal - u.walletBalance,
          kind: "reconcile_seed",
          source: "reconciliation",
          syncStatus: "reconciled",
          memo: "Initial wallet sync from UnbelievaBoat",
          previousBalance: u.walletBalance,
          newBalance: ubTotal,
        });
      });
      continue;
    }

    const delta = ubTotal - lastSynced;
    if (delta === 0) continue;

    result.changed++;
    const newBalance = u.walletBalance + delta;
    if (mode === "test") {
      logger.info(
        { userId: u.id, delta, from: u.walletBalance, to: newBalance },
        "reconcile dry-run: would fold external UB change into wallet",
      );
      continue;
    }
    await db.transaction(async (tx) => {
      // Fold the external delta in as an atomic relative increment, guarded on the
      // baseline we read, so a concurrent push (also a relative increment) or
      // another reconcile can't be clobbered or double-applied. A missed guard
      // means another writer advanced the baseline; the residual external delta
      // is recomputed on the next reconcile cycle.
      const updated = await tx
        .update(users)
        .set({
          walletBalance: sql`${users.walletBalance} + ${delta}`,
          lastSyncedUbBalance: ubTotal,
          lastSyncedAt: new Date(),
          lastSyncStatus: "synced",
          lastSyncError: null,
        })
        .where(and(eq(users.id, u.id), eq(users.lastSyncedUbBalance, lastSynced)))
        .returning({ balance: users.walletBalance });
      if (updated.length === 0) return;
      await tx.insert(walletTransactions).values({
        userId: u.id,
        amount: delta,
        kind: "reconcile",
        source: "reconciliation",
        syncStatus: "reconciled",
        memo: `External UnbelievaBoat change (Discord-side activity, ${delta > 0 ? "+" : ""}${delta})`,
        previousBalance: updated[0].balance - delta,
        newBalance: updated[0].balance,
      });
    });
  }

  logger.info({ ...result }, "economy reconcile complete");
  return result;
}

export interface ReconcileUserResult {
  ok: boolean;
  status: "synced" | "disabled" | "dry_run" | "ub_unavailable" | "no_change";
  balance: number;
  delta: number;
  error?: string;
}

/**
 * Admin "safe retry" for a single player: re-pull the live UB balance and fold
 * any external (Discord-side) delta into the website wallet, writing a
 * reconciliation ledger row. No-op when already in sync. Respects the tri-state
 * mode (disabled => no-op, test => dry-run, enabled => live).
 */
// `onApplied` (optional) runs INSIDE the wallet-write transaction, after the
// guarded balance update + ledger insert succeed — used by the admin
// maintenance endpoint to commit its audit row atomically with the fold.
export async function reconcileOneUser(
  userId: string,
  onApplied?: (tx: Pick<typeof db, "insert">) => Promise<void>,
): Promise<ReconcileUserResult> {
  const mode = await getEconomyMode();
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) {
    return { ok: false, status: "ub_unavailable", balance: 0, delta: 0, error: "Unknown user" };
  }
  if (mode === "disabled") {
    return { ok: false, status: "disabled", balance: u.walletBalance, delta: 0 };
  }
  const ub = await getBalance(u.discordId);
  if (!ub) {
    return { ok: false, status: "ub_unavailable", balance: u.walletBalance, delta: 0, error: "Could not reach UnbelievaBoat" };
  }
  const ubTotal = ub.total;
  const isSeed = u.lastSyncedUbBalance === null;
  if (isSeed && (await hasUnfinishedPushes(userId))) {
    // Never absolute-seed over website-authoritative money still queued to push.
    return { ok: true, status: "no_change", balance: u.walletBalance, delta: 0 };
  }
  const baseline = u.lastSyncedUbBalance ?? u.walletBalance;
  const delta = ubTotal - baseline;
  const newBalance = u.walletBalance + delta;

  if (mode === "test") {
    logger.info({ userId, delta, from: u.walletBalance, to: newBalance }, "admin retry dry-run: would fold UB delta");
    return { ok: true, status: "dry_run", balance: u.walletBalance, delta };
  }

  if (delta === 0 && u.lastSyncedUbBalance !== null) {
    // Already in sync; just refresh sync metadata.
    await db
      .update(users)
      .set({ lastSyncedUbBalance: ubTotal, lastSyncedAt: new Date(), lastSyncStatus: "synced", lastSyncError: null })
      .where(eq(users.id, userId));
    return { ok: true, status: "no_change", balance: u.walletBalance, delta: 0 };
  }

  // Apply with the same guarded, concurrency-safe strategy as the cron reconcile:
  // seed uses an absolute write guarded on a still-null baseline; a normal fold
  // uses an atomic relative increment guarded on the baseline we read. If a
  // concurrent writer advanced the baseline first, we skip and report the live
  // state rather than clobbering it.
  let appliedBalance = newBalance;
  let raced = false;
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({
        walletBalance: isSeed ? ubTotal : sql`${users.walletBalance} + ${delta}`,
        lastSyncedUbBalance: ubTotal,
        lastSyncedAt: new Date(),
        lastSyncStatus: "synced",
        lastSyncError: null,
      })
      .where(and(eq(users.id, userId), isSeed ? isNull(users.lastSyncedUbBalance) : eq(users.lastSyncedUbBalance, baseline)))
      .returning({ balance: users.walletBalance });
    if (updated.length === 0) {
      raced = true;
      return;
    }
    appliedBalance = updated[0].balance;
    await tx.insert(walletTransactions).values({
      userId,
      amount: delta,
      kind: isSeed ? "reconcile_seed" : "reconcile",
      source: "reconciliation",
      syncStatus: "reconciled",
      memo: isSeed
        ? "Initial wallet sync from UnbelievaBoat"
        : `External UnbelievaBoat change (Discord-side activity, ${delta > 0 ? "+" : ""}${delta})`,
      previousBalance: appliedBalance - delta,
      newBalance: appliedBalance,
    });
    if (onApplied) await onApplied(tx);
  });
  if (raced) {
    // Another writer synced this user between our read and write. Report the
    // current live balance with no applied delta instead of overwriting.
    const [fresh] = await db.select({ balance: users.walletBalance }).from(users).where(eq(users.id, userId));
    return { ok: true, status: "no_change", balance: fresh?.balance ?? u.walletBalance, delta: 0 };
  }
  return { ok: true, status: "synced", balance: appliedBalance, delta };
}

// ---------------------------------------------------------------------------
// Mirror health (admin System Admin panel).
// ---------------------------------------------------------------------------

export interface MirrorHealth {
  counts: { pending: number; inflight: number; pushed24h: number; suppressed: number };
  oldestPendingAt: string | null;
  lastPushedAt: string | null;
  recentFailures: Array<{ id: number; userId: string; amount: number; attempts: number; lastError: string | null; nextAttemptAt: string }>;
  /** Users with queued pushes or non-zero drift vs the expected UB total. */
  users: Array<{
    userId: string;
    username: string;
    websiteBalance: number;
    expectedUbTotal: number | null;
    queuedAmount: number;
    queuedCount: number;
    lastSyncedAt: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Mirror repair policy for negative website wallets.
//
// Investigation (2026-08-15) found 68 users with negative wallet_balance, all
// from legitimate paths (autobill overdraw + reconcile folds of external UB
// gambling losses). No bugs or corrections were needed. See:
//   src/lib/docs/negative-wallet-investigation-2026-08-15.md
//
// POLICY: when implementing any fleet-wide UB mirror repair (push UB to match
// website balance for users whose UB drifted ahead), NEVER push a negative
// target to UnbelievaBoat:
//
//   if (targetUbBalance < 0) {
//     // skip — keep the website-side debt website-only.
//     // UB may reject sub-zero totals; pushing a player from e.g. +41,486
//     // to −53,164 in one shot is severely disruptive.
//     continue;
//   }
//
// Users with wallet_balance < 0 and last_synced_ub_balance > 0 have a real
// website debt that UB hasn't mirrored yet — skip them in repair and let
// future earnings (reconcile folds + mission payouts) close the gap organically.
// Users with wallet_balance < 0 and last_synced_ub_balance <= 0 are already
// in bilateral debt — no push needed.
// ---------------------------------------------------------------------------

export async function getMirrorHealth(): Promise<MirrorHealth> {
  const countsRes = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending')  AS pending,
      count(*) FILTER (WHERE status = 'inflight') AS inflight,
      count(*) FILTER (WHERE status = 'pushed' AND pushed_at > now() - interval '24 hours') AS pushed24h,
      count(*) FILTER (WHERE status = 'suppressed') AS suppressed,
      min(created_at) FILTER (WHERE status IN ('pending', 'inflight')) AS oldest_pending_at,
      max(pushed_at) AS last_pushed_at
    FROM ub_push_outbox
  `);
  const c = (countsRes.rows?.[0] ?? {}) as Record<string, unknown>;

  const failures = await db
    .select({
      id: ubPushOutbox.id,
      userId: ubPushOutbox.userId,
      amount: ubPushOutbox.amount,
      attempts: ubPushOutbox.attempts,
      lastError: ubPushOutbox.lastError,
      nextAttemptAt: ubPushOutbox.nextAttemptAt,
    })
    .from(ubPushOutbox)
    .where(and(inArray(ubPushOutbox.status, ["pending", "inflight"]), sql`${ubPushOutbox.attempts} > 0`))
    .orderBy(desc(ubPushOutbox.attempts))
    .limit(20);

  const queuedRes = await db.execute(sql`
    SELECT o.user_id, u.username, u.wallet_balance, u.last_synced_ub_balance, u.last_synced_at,
           sum(o.amount)::int AS queued_amount, count(*)::int AS queued_count
    FROM ub_push_outbox o
    JOIN users u ON u.id = o.user_id
    WHERE o.status IN ('pending', 'inflight')
    GROUP BY o.user_id, u.username, u.wallet_balance, u.last_synced_ub_balance, u.last_synced_at
    ORDER BY count(*) DESC
    LIMIT 50
  `);
  const usersOut = ((queuedRes.rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    userId: String(r.user_id),
    username: String(r.username ?? ""),
    websiteBalance: Number(r.wallet_balance ?? 0),
    expectedUbTotal: r.last_synced_ub_balance == null ? null : Number(r.last_synced_ub_balance),
    queuedAmount: Number(r.queued_amount ?? 0),
    queuedCount: Number(r.queued_count ?? 0),
    lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at as string | Date).toISOString() : null,
  }));

  return {
    counts: {
      pending: Number(c.pending ?? 0),
      inflight: Number(c.inflight ?? 0),
      pushed24h: Number(c.pushed24h ?? 0),
      suppressed: Number(c.suppressed ?? 0),
    },
    oldestPendingAt: c.oldest_pending_at ? new Date(c.oldest_pending_at as string | Date).toISOString() : null,
    lastPushedAt: c.last_pushed_at ? new Date(c.last_pushed_at as string | Date).toISOString() : null,
    recentFailures: failures.map((f) => ({
      id: f.id,
      userId: f.userId,
      amount: f.amount,
      attempts: f.attempts,
      lastError: f.lastError,
      nextAttemptAt: f.nextAttemptAt.toISOString(),
    })),
    users: usersOut,
  };
}
