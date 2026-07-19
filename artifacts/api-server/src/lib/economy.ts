import { db, users, walletTransactions, botConfig } from "@workspace/db";
import { eq, and, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { isSystemLive } from "./liveMode";
import { getBalance, patchBalance } from "./unbelievaboat";

// ---------------------------------------------------------------------------
// Economy foundation: website-authoritative player wallets kept in sync with
// UnbelievaBoat (UB), plus website-only store/ripperdoc accounts.
//
// Processing mode is a TRI-STATE derived from two existing bot_config patterns:
//   - `economy_enabled` (kill switch, like AUTOBILL_FLAGS) — OFF => "disabled".
//   - the `economy` LiveSystem (master AND economy_live_mode) — decides
//     "test" (dry-run) vs "enabled" (live) once the kill switch is ON.
//
//   disabled  -> do nothing (no balance/UB/ledger writes)
//   test      -> compute + log proposed change, write nothing to UB or balances
//   enabled   -> live: reserve ledger row, call UB, finalize balance
//
// Every player money change goes through applyWalletDelta, which reserves a
// ledger row BEFORE the external UB call (so a crash cannot double-apply) and
// is idempotent on idempotencyKey (so a retry never applies twice).
// ---------------------------------------------------------------------------

export type EconomyMode = "disabled" | "test" | "enabled";

/** bot_config kill-switch key. OFF (default) => the economy system is disabled. */
export const ECONOMY_ENABLED_KEY = "economy_enabled";

// Wallet balances are stored as Postgres int4 columns, which top out at
// 2,147,483,647. A credit that would push a balance past this would overflow
// the column and throw at write time, so applyWalletDelta rejects it cleanly
// (status "exceeds_max") before any UB call or DB write.
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
  /** Discord id used for the UB call. */
  discordId: string;
  /** Signed delta in eddies (applied to UB cash). */
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

/**
 * The single idempotent entry point for every website-originated player wallet
 * change. See module header for the reserve-before-call + tri-state contract.
 */
export async function applyWalletDelta(input: ApplyWalletDeltaInput): Promise<WalletApplyResult> {
  const mode = await getEconomyMode();
  const prev = await readWalletBalance(input.userId);
  const proposed = prev + input.amount;

  // Idempotency: a prior row for this key short-circuits (synced => duplicate)
  // or is reused for retry (failed). Pending rows are left alone — they are
  // ambiguous (possible crash mid-UB) and reconciliation resolves them.
  let existing: typeof walletTransactions.$inferSelect | undefined;
  if (input.idempotencyKey) {
    [existing] = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, input.idempotencyKey));
    if (existing?.syncStatus === "synced") {
      return { ok: true, status: "duplicate", balance: prev, previousBalance: existing.previousBalance ?? prev, proposedBalance: prev, ledgerId: existing.id };
    }
    if (existing?.syncStatus === "pending") {
      return { ok: false, status: "pending", balance: prev, previousBalance: prev, proposedBalance: proposed, ledgerId: existing.id, error: "A previous attempt is still pending reconciliation." };
    }
  }

  // Overdraw protection (debits only) — checked before any write.
  if (!input.allowNegative && input.amount < 0 && proposed < 0) {
    return { ok: false, status: "insufficient_funds", balance: prev, previousBalance: prev, proposedBalance: proposed };
  }

  // Overflow protection (credits only) — a balance past the int4 ceiling would
  // throw at write time, so reject it cleanly before any UB call or DB write.
  if (input.amount > 0 && proposed > MAX_WALLET_BALANCE) {
    return {
      ok: false,
      status: "exceeds_max",
      balance: prev,
      previousBalance: prev,
      proposedBalance: proposed,
      error: `This would push the wallet past the maximum balance of ${MAX_WALLET_BALANCE.toLocaleString()} eddies.`,
    };
  }

  if (mode === "disabled") {
    return { ok: false, status: "disabled", balance: prev, previousBalance: prev, proposedBalance: proposed };
  }

  if (mode === "test") {
    logger.info(
      { userId: input.userId, amount: input.amount, source: input.source, kind: input.kind, prev, proposed },
      "economy dry-run (test mode): no UB/balance/ledger writes",
    );
    return { ok: true, status: "dry_run", balance: prev, previousBalance: prev, proposedBalance: proposed };
  }

  // ---- enabled (live) ----
  // 1) Reserve a pending ledger row BEFORE calling UB. Reuse the existing failed
  //    row on retry so a key never spawns duplicates.
  const reserveValues = {
    characterId: input.characterId ?? null,
    userId: input.userId,
    counterpartyCharacterId: input.counterpartyCharacterId ?? null,
    counterpartyName: input.counterpartyName ?? null,
    amount: input.amount,
    kind: input.kind,
    memo: input.memo ?? null,
    source: input.source,
    syncStatus: "pending" as const,
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
    await db
      .update(walletTransactions)
      .set({ ...reserveValues, createdAt: new Date() })
      .where(eq(walletTransactions.id, existing.id));
    ledgerId = existing.id;
  } else {
    const [row] = await db
      .insert(walletTransactions)
      .values(reserveValues)
      .returning({ id: walletTransactions.id });
    ledgerId = row.id;
  }

  // 2) External UB call (no DB lock held).
  const ub = await patchBalance(input.discordId, { cash: input.amount, reason: input.reason });

  // 3) Finalize atomically.
  if (!ub) {
    const errorMessage = "UnbelievaBoat update failed";
    await db.transaction(async (tx) => {
      await tx
        .update(walletTransactions)
        .set({ syncStatus: "failed", errorMessage })
        .where(eq(walletTransactions.id, ledgerId));
      await tx
        .update(users)
        .set({ lastSyncStatus: "failed", lastSyncError: errorMessage })
        .where(eq(users.id, input.userId));
    });
    return { ok: false, status: "failed", balance: prev, previousBalance: prev, proposedBalance: proposed, ledgerId, error: errorMessage };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(walletTransactions)
      .set({ syncStatus: "synced", errorMessage: null })
      .where(eq(walletTransactions.id, ledgerId));
    // Apply the wallet change as an atomic relative increment so concurrent
    // deltas for the same user can't clobber each other (lost update / minting).
    // lastSyncedUbBalance is best-effort here; reconciliation corrects any skew.
    await tx
      .update(users)
      .set({
        walletBalance: sql`${users.walletBalance} + ${input.amount}`,
        lastSyncedUbBalance: ub.total,
        lastSyncedAt: new Date(),
        lastSyncStatus: "synced",
        lastSyncError: null,
      })
      .where(eq(users.id, input.userId));
  });
  return { ok: true, status: "synced", balance: proposed, previousBalance: prev, proposedBalance: proposed, ledgerId };
}

export interface SettledWalletMovementInput {
  /** The website user whose wallet moved. */
  userId: string;
  /** Signed delta in eddies that was ALREADY applied to UB cash. */
  amount: number;
  /** The UB total reported immediately after the (already-completed) UB call. */
  ubTotalAfter: number;
  source: WalletSource;
  kind: string;
  memo?: string | null;
  characterId?: number | null;
  counterpartyCharacterId?: number | null;
  counterpartyName?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: number | null;
  storeId?: number | null;
  ripperdocId?: number | null;
  /** Idempotency key — a duplicate is a no-op that returns the existing row id. */
  idempotencyKey?: string | null;
}

/**
 * Record an ALREADY-SETTLED player wallet movement into the website ledger and
 * balance, idempotently. Use this for money paths that call UnbelievaBoat
 * DIRECTLY (e.g. mission payouts) and therefore bypass applyWalletDelta — those
 * paths are gated independently (mission live mode, not the economy kill-switch)
 * and would otherwise only ever surface in the website wallet as a generic
 * 'reconcile' entry on the next reconcile cycle.
 *
 * Unlike applyWalletDelta this makes NO UB call (the caller already did) — it
 * only writes the ledger row + advances the website balance. It advances
 * lastSyncedUbBalance to the post-call UB total so the reconcile cron does not
 * double-count this same delta. When the wallet has never been seeded
 * (lastSyncedUbBalance is null) it leaves the baseline null so the first
 * reconcile still seeds the full UB total (which already includes this payout).
 *
 * Returns the ledger row id, or null when the user no longer exists.
 */
export async function recordSettledWalletMovement(
  input: SettledWalletMovementInput,
): Promise<number | null> {
  return await db.transaction(async (tx) => {
    if (input.idempotencyKey) {
      const [dup] = await tx
        .select({ id: walletTransactions.id })
        .from(walletTransactions)
        .where(eq(walletTransactions.idempotencyKey, input.idempotencyKey));
      if (dup) return dup.id;
    }
    // Lock the user row so the read-modify-write of walletBalance is atomic
    // against concurrent applyWalletDelta / reconcile writers.
    const [u] = await tx
      .select({ balance: users.walletBalance, lastSyncedUbBalance: users.lastSyncedUbBalance })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!u) return null;
    const prev = u.balance ?? 0;
    const rawNext = prev + input.amount;
    // walletBalance / previous/newBalance are int4 columns. UB already settled
    // this movement (UB is source of truth); if the local mirror would exceed
    // the int4 range we clamp the stored value rather than letting the DB write
    // throw and drop the ledger row entirely. Reconcile corrects any drift.
    const next = clampInt4(rawNext);
    const prevStored = clampInt4(prev);
    if (next !== rawNext) {
      logger.warn(
        { userId: input.userId, prev, amount: input.amount, rawNext, clamped: next },
        "recordSettledWalletMovement: local balance clamped to int4 range; reconcile will correct",
      );
    }
    const inserted = await tx
      .insert(walletTransactions)
      .values({
        characterId: input.characterId ?? null,
        userId: input.userId,
        counterpartyCharacterId: input.counterpartyCharacterId ?? null,
        counterpartyName: input.counterpartyName ?? null,
        amount: input.amount,
        kind: input.kind,
        memo: input.memo ?? null,
        source: input.source,
        syncStatus: "synced",
        idempotencyKey: input.idempotencyKey ?? null,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        storeId: input.storeId ?? null,
        ripperdocId: input.ripperdocId ?? null,
        previousBalance: prevStored,
        newBalance: next,
      })
      .onConflictDoNothing({ target: walletTransactions.idempotencyKey })
      .returning({ id: walletTransactions.id });
    if (inserted.length === 0) {
      // A concurrent writer inserted this same key between the pre-check and
      // here. That writer owns the balance advance (we both serialize on the
      // user FOR UPDATE lock), so return its row id WITHOUT moving the balance
      // again. Only reachable when idempotencyKey is set (null keys never
      // conflict under the unique index).
      const [existing] = await tx
        .select({ id: walletTransactions.id })
        .from(walletTransactions)
        .where(eq(walletTransactions.idempotencyKey, input.idempotencyKey!));
      return existing?.id ?? null;
    }
    const row = inserted[0];
    await tx
      .update(users)
      .set({
        walletBalance: next,
        ...(u.lastSyncedUbBalance === null
          ? {}
          : {
              lastSyncedUbBalance: input.ubTotalAfter,
              lastSyncedAt: new Date(),
              lastSyncStatus: "synced" as const,
              lastSyncError: null,
            }),
      })
      .where(eq(users.id, input.userId));
    return row.id;
  });
}

/**
 * Advance ONLY the website wallet balance for an already-settled UB movement
 * whose ledger row the caller has ALREADY written itself (e.g. the autobill
 * cron, which reserves its own wallet_transactions row BEFORE the UB call for
 * crash safety). Mirrors the users-table update recordSettledWalletMovement
 * performs — so users.walletBalance and the UB baseline advance in lockstep
 * instead of drifting until the next reconcile — WITHOUT inserting a second
 * ledger row. Idempotency is the caller's responsibility (its reserved row +
 * billed-this-run guard already dedupes the charge).
 */
export async function advanceSettledWalletBalance(input: {
  userId: string;
  amount: number;
  ubTotalAfter: number;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [u] = await tx
      .select({ balance: users.walletBalance, lastSyncedUbBalance: users.lastSyncedUbBalance })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!u) return;
    const next = clampInt4((u.balance ?? 0) + input.amount);
    await tx
      .update(users)
      .set({
        walletBalance: next,
        ...(u.lastSyncedUbBalance === null
          ? {}
          : {
              lastSyncedUbBalance: input.ubTotalAfter,
              lastSyncedAt: new Date(),
              lastSyncStatus: "synced" as const,
              lastSyncError: null,
            }),
      })
      .where(eq(users.id, input.userId));
  });
}

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

/**
 * UB->website reconciliation. Fetches each linked user's UB balance, diffs it
 * against lastSyncedUbBalance, and folds any external (Discord-side) delta into
 * the website wallet with a 'reconciliation' ledger entry. NEVER touches
 * store/ripperdoc accounts. Respects the tri-state mode: disabled => no-op,
 * test => compute + log only, enabled => live writes.
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

    // First-ever sync: mirror UB into the website wallet.
    if (lastSynced === null || lastSynced === undefined) {
      result.seeded++;
      if (mode === "test") {
        logger.info({ userId: u.id, ubTotal }, "reconcile dry-run: would seed wallet from UB");
        continue;
      }
      await db.transaction(async (tx) => {
        // Guard on the still-null baseline so a concurrent applyWalletDelta (which
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
      // baseline we read, so a concurrent applyWalletDelta (also a relative
      // increment) or another reconcile can't be clobbered or double-applied. A
      // missed guard means another writer advanced the baseline; the residual
      // external delta is recomputed on the next reconcile cycle.
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
        memo: `Reconciled external UnbelievaBoat change (${delta > 0 ? "+" : ""}${delta})`,
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
  const isSeed = u.lastSyncedUbBalance === null;
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
      memo: `Admin retry: reconciled to UnbelievaBoat (${delta > 0 ? "+" : ""}${delta})`,
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
