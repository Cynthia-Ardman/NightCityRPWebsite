import type { IRouter } from "express";
import type { Request, Response } from "express";
import { eq, and, desc, sql, gte } from "drizzle-orm";
import { db, stores, ripperdocs, walletTransactions, auditLog, users } from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { hasRole } from "../../lib/discord";
import { logger } from "../../lib/logger";
import { applyWalletDelta, MAX_WALLET_BALANCE } from "../../lib/economy";
import { auditMeta, loadManageableStore, loadManageableRipperdoc } from "./venue-shared";

// ===== Venue accounts: deposit / withdraw / transaction history =====
// Stores and ripperdocs each have a website-only `balance`. The OWNER can move
// money between their personal wallet and the venue account:
//   - deposit  : personal wallet  -> venue   (personal leg syncs to UB)
//   - withdraw : venue            -> personal wallet (personal leg syncs to UB)
// The personal leg goes through the economy sync wrapper (UB + idempotency +
// tri-state mode). The venue leg is website-only. Two ledger rows are written:
// the personal-leg row (userId set, from the wrapper) and a venue-leg row
// (storeId/ripperdocId set, userId null) so the player history and the
// per-venue history stay cleanly separated. Reconciliation never touches venue
// balances.
type VenueKind = "store" | "ripperdoc";

async function venueDepositWithdraw(opts: {
  kind: VenueKind;
  venueId: number;
  direction: "deposit" | "withdraw";
  amount: number;
  idempotencyKey?: string;
  req: Request;
  res: Response;
}): Promise<void> {
  const { kind, venueId, direction, amount, req, res } = opts;
  if (!Number.isInteger(amount) || amount <= 0) {
    res.status(400).json({ error: "amount must be a positive whole number" });
    return;
  }
  const venueTable = kind === "store" ? stores : ripperdocs;
  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Owner-only: the personal leg is the owner's wallet. Staff/employees cannot
  // move money in/out of someone else's business account.
  if (venue.ownerId !== req.user!.id) {
    res.status(403).json({ error: "Only the owner can move money to or from this account." });
    return;
  }
  const [owner] = await db.select().from(users).where(eq(users.id, venue.ownerId));
  if (!owner) {
    res.status(400).json({ error: "Owner account is missing" });
    return;
  }

  const personalDelta = direction === "deposit" ? -amount : amount;
  const venueDelta = direction === "deposit" ? amount : -amount;

  // Venue-side overdraw guard (personal-side overdraw is enforced by the wrapper).
  if (direction === "withdraw" && venue.balance < amount) {
    res.status(400).json({ error: "Insufficient venue balance" });
    return;
  }

  // Require the client-supplied idempotency token (a UUID generated once per
  // submit and reused across React Query retries) so a network blip or
  // double-click can't double-debit/credit. The old Date.now() fallback minted
  // a fresh key per attempt, which silently defeated the dedupe on retries.
  const clientKey =
    typeof opts.idempotencyKey === "string" && opts.idempotencyKey.trim().length > 0
      ? opts.idempotencyKey.trim().slice(0, 100)
      : null;
  if (!clientKey) {
    res.status(400).json({ error: "idempotencyKey is required" });
    return;
  }
  const idempotencyKey = `venue-${kind}-${venueId}-${direction}-${clientKey}-${owner.id}`;
  const result = await applyWalletDelta({
    userId: owner.id,
    discordId: owner.discordId,
    amount: personalDelta,
    source: kind,
    kind: `${kind}_${direction}`,
    reason: `${direction === "deposit" ? "Deposit to" : "Withdrawal from"} ${venue.name}`,
    memo: `${direction} ${kind} "${venue.name}"`,
    storeId: kind === "store" ? venueId : null,
    ripperdocId: kind === "ripperdoc" ? venueId : null,
    relatedEntityType: kind,
    relatedEntityId: venueId,
    idempotencyKey,
  });

  if (result.status === "disabled") {
    res.status(409).json({ error: "The economy system is currently disabled." });
    return;
  }
  if (result.status === "insufficient_funds") {
    res.status(400).json({ error: "Insufficient personal wallet balance" });
    return;
  }
  if (result.status === "exceeds_max") {
    res.status(400).json({ error: result.error ?? "This would exceed the maximum wallet balance." });
    return;
  }
  if (result.status === "dry_run") {
    res.json({
      ok: true,
      dryRun: true,
      venueBalance: venue.balance,
      proposedVenueBalance: venue.balance + venueDelta,
      walletBalance: result.balance,
      proposedWalletBalance: result.proposedBalance,
    });
    return;
  }
  if (!result.ok) {
    res.status(502).json({ error: result.error ?? "Wallet sync failed; no money moved." });
    return;
  }

  // Personal leg is live-synced. Move the venue side (website-only) + write the
  // venue-leg ledger row and audit, atomically. For withdrawals the venue debit
  // is guarded (balance >= amount) in the same statement so concurrent
  // withdrawals cannot drive the venue negative; if the guard loses the race we
  // reverse the already-applied personal credit below so no money is minted.
  // The venue leg gets its OWN idempotency key (mirroring venueGive): a retry
  // whose personal leg resolved as "duplicate" must not increment the venue a
  // second time. Short-circuit inside the tx when the venue-leg row exists.
  const venueIdempotencyKey = `${idempotencyKey}-venue`;
  const { ip, ua } = auditMeta(req);
  let finalVenueBalance = venue.balance + venueDelta;
  let venueGuardFailed = false;
  await db.transaction(async (tx) => {
    const [existingVenueLeg] = await tx
      .select({ newBalance: walletTransactions.newBalance })
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, venueIdempotencyKey));
    if (existingVenueLeg) {
      finalVenueBalance = existingVenueLeg.newBalance ?? venue.balance;
      return;
    }
    const updated = await tx
      .update(venueTable)
      .set({ balance: sql`${venueTable.balance} + ${venueDelta}` })
      .where(
        direction === "withdraw"
          ? and(eq(venueTable.id, venueId), gte(venueTable.balance, amount))
          : eq(venueTable.id, venueId),
      )
      .returning({ balance: venueTable.balance });
    if (updated.length === 0) {
      // Withdraw lost the concurrency race: venue dropped below `amount`.
      venueGuardFailed = true;
      return;
    }
    finalVenueBalance = updated[0].balance;
    await tx.insert(walletTransactions).values({
      amount: venueDelta,
      kind: `${kind}_${direction}`,
      source: kind,
      syncStatus: "synced",
      idempotencyKey: venueIdempotencyKey,
      memo: `${direction === "deposit" ? "Owner deposit" : "Owner withdrawal"} — ${venue.name}`,
      previousBalance: finalVenueBalance - venueDelta,
      newBalance: finalVenueBalance,
      storeId: kind === "store" ? venueId : null,
      ripperdocId: kind === "ripperdoc" ? venueId : null,
      relatedEntityType: kind,
      relatedEntityId: venueId,
    });
    await tx.insert(auditLog).values({
      category: "shop",
      action: `${kind}_${direction}`,
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: kind,
      targetId: String(venueId),
      message: `${direction === "deposit" ? "Deposited" : "Withdrew"} ${amount} eddies ${direction === "deposit" ? "to" : "from"} ${venue.name}`,
    });
  });

  if (venueGuardFailed) {
    // The personal leg already credited the owner via UB, so reverse it to keep
    // the books balanced. Derived idempotency key keeps the reversal retry-safe;
    // allowNegative bypasses overdraw protection (we are undoing our own credit).
    const reversal = await applyWalletDelta({
      userId: owner.id,
      discordId: owner.discordId,
      amount: -personalDelta,
      source: kind,
      kind: `${kind}_${direction}_reversal`,
      reason: `Reversed ${direction} — insufficient ${kind} balance: ${venue.name}`,
      memo: `reversal of ${direction} ${kind} "${venue.name}"`,
      storeId: kind === "store" ? venueId : null,
      ripperdocId: kind === "ripperdoc" ? venueId : null,
      relatedEntityType: kind,
      relatedEntityId: venueId,
      idempotencyKey: `${idempotencyKey}-reversal`,
      allowNegative: true,
    });
    // Only a confirmed reversal (synced now or already applied) means no money
    // was minted. A failed/pending reversal leaves the owner credited without a
    // venue debit — surface it loudly and write a high-severity audit marker so
    // it is discoverable and can be retried; do NOT report a clean 400.
    if (reversal.status === "synced" || reversal.status === "duplicate") {
      res.status(400).json({ error: "Insufficient venue balance" });
      return;
    }
    const { ip: rip, ua: rua } = auditMeta(req);
    logger.error(
      { venueKind: kind, venueId, ownerId: owner.id, amount, reversalStatus: reversal.status, reversalError: reversal.error, ledgerId: reversal.ledgerId },
      "venue withdraw reversal NOT confirmed — owner credited without venue debit; manual reconciliation required",
    );
    await db.insert(auditLog).values({
      category: "shop",
      action: `${kind}_${direction}_reversal_failed`,
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: rip,
      actorUa: rua,
      targetType: kind,
      targetId: String(venueId),
      message: `Reversal of ${amount} eddies ${direction} on ${venue.name} did not confirm (${reversal.status}). Owner ${owner.id} may have been credited without a venue debit — needs manual reconciliation.`,
    });
    res.status(502).json({ error: "Withdrawal could not be completed and the reversal did not confirm. This has been flagged for review; please do not retry." });
    return;
  }

  res.json({ ok: true, venueBalance: finalVenueBalance, walletBalance: result.balance });
}

// Any player may gift eddies from their personal wallet into a business
// (store or ripperdoc clinic) account. One-directional (personal debit ->
// venue credit); mirrors the deposit leg of venueDepositWithdraw but is NOT
// owner-restricted. Shared by /stores/:id/give and /ripperdocs/:id/give-eddies.
async function venueGive(kind: VenueKind, req: Request, res: Response): Promise<void> {
  const venueId = parseInt(String(req.params.id), 10);
  const amount = Number(req.body?.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    res.status(400).json({ error: "amount must be a positive whole number" });
    return;
  }
  const venueTable = kind === "store" ? stores : ripperdocs;
  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const venueNoun = kind === "store" ? "store" : "clinic";
  if (venue.balance + amount > MAX_WALLET_BALANCE) {
    res.status(400).json({ error: `This would push the ${venueNoun} balance past the maximum of ${MAX_WALLET_BALANCE.toLocaleString()} eddies.` });
    return;
  }
  const giver = req.user!;
  const note = typeof req.body?.memo === "string" ? req.body.memo.trim().slice(0, 200) : "";
  const clientKey =
    typeof req.body?.idempotencyKey === "string" && req.body.idempotencyKey.trim().length > 0
      ? req.body.idempotencyKey.trim().slice(0, 100)
      : String(Date.now());
  // Keep the historical "store-give-" key prefix for stores so pre-refactor
  // retries still dedupe; ripperdocs get their own prefix.
  const idempotencyKey = `${kind === "store" ? "store-give" : "ripperdoc-give"}-${venueId}-${clientKey}-${giver.id}`;
  const txKind = kind === "store" ? "store_give" : "ripperdoc_give";
  const venueRef = kind === "store" ? { storeId: venueId } : { ripperdocId: venueId };
  const result = await applyWalletDelta({
    userId: giver.id,
    discordId: giver.discordId,
    amount: -amount,
    source: kind,
    kind: txKind,
    reason: `Payment to ${venue.name}`,
    memo: note ? `payment to ${venueNoun} "${venue.name}": ${note}` : `payment to ${venueNoun} "${venue.name}"`,
    ...venueRef,
    relatedEntityType: kind,
    relatedEntityId: venueId,
    idempotencyKey,
  });
  if (result.status === "disabled") {
    res.status(409).json({ error: "The economy system is currently disabled." });
    return;
  }
  if (result.status === "insufficient_funds") {
    res.status(400).json({ error: "Insufficient personal wallet balance" });
    return;
  }
  if (result.status === "exceeds_max") {
    res.status(400).json({ error: result.error ?? "This would exceed the maximum wallet balance." });
    return;
  }
  if (result.status === "dry_run") {
    res.json({
      ok: true,
      dryRun: true,
      venueBalance: venue.balance,
      proposedVenueBalance: venue.balance + amount,
      walletBalance: result.balance,
      proposedWalletBalance: result.proposedBalance,
    });
    return;
  }
  if (!result.ok) {
    res.status(502).json({ error: result.error ?? "Wallet sync failed; no money moved." });
    return;
  }
  // Personal leg is live-synced (status "synced") or was already applied on a
  // prior attempt (status "duplicate"). Either way the store-credit leg must be
  // independently idempotent: applyWalletDelta dedupes the personal debit, but a
  // replayed/duplicate request must NOT credit the store a second time, and a
  // retry after a crash between the two legs must still credit it exactly once.
  // We key the venue-leg ledger row on its own idempotency key and short-circuit
  // inside the transaction if it already exists. A credit increment has no guard
  // race (unlike a withdraw), so no reversal path is needed.
  const venueIdempotencyKey = `${idempotencyKey}-venue`;
  const { ip, ua } = auditMeta(req);
  let finalVenueBalance = venue.balance + amount;
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ newBalance: walletTransactions.newBalance })
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, venueIdempotencyKey));
    if (existing) {
      finalVenueBalance = existing.newBalance ?? venue.balance;
      return;
    }
    const [u] = await tx
      .update(venueTable)
      .set({ balance: sql`${venueTable.balance} + ${amount}` })
      .where(eq(venueTable.id, venueId))
      .returning({ balance: venueTable.balance });
    finalVenueBalance = u.balance;
    await tx.insert(walletTransactions).values({
      amount,
      kind: txKind,
      source: kind,
      syncStatus: "synced",
      memo: `Payment from ${giver.username} — ${venue.name}${note ? `: ${note}` : ""}`,
      previousBalance: finalVenueBalance - amount,
      newBalance: finalVenueBalance,
      ...venueRef,
      relatedEntityType: kind,
      relatedEntityId: venueId,
      idempotencyKey: venueIdempotencyKey,
    });
    await tx.insert(auditLog).values({
      category: "shop",
      action: txKind,
      actorId: giver.id,
      actorName: giver.username,
      actorIp: ip,
      actorUa: ua,
      targetType: kind,
      targetId: String(venueId),
      message: `${giver.username} paid ${amount} eddies to ${venue.name}`,
    });
  });
  res.json({ ok: true, venueBalance: finalVenueBalance, walletBalance: result.balance });
}

export function registerVenueAccounts(router: IRouter): void {
  router.post("/stores/:id/deposit", requireAuth, async (req, res): Promise<void> => {
    await venueDepositWithdraw({ kind: "store", venueId: parseInt(String(req.params.id), 10), direction: "deposit", amount: Number(req.body?.amount), idempotencyKey: req.body?.idempotencyKey, req, res });
  });
  router.post("/stores/:id/withdraw", requireAuth, async (req, res): Promise<void> => {
    await venueDepositWithdraw({ kind: "store", venueId: parseInt(String(req.params.id), 10), direction: "withdraw", amount: Number(req.body?.amount), idempotencyKey: req.body?.idempotencyKey, req, res });
  });
  router.post("/ripperdocs/:id/deposit", requireAuth, async (req, res): Promise<void> => {
    await venueDepositWithdraw({ kind: "ripperdoc", venueId: parseInt(String(req.params.id), 10), direction: "deposit", amount: Number(req.body?.amount), idempotencyKey: req.body?.idempotencyKey, req, res });
  });
  router.post("/ripperdocs/:id/withdraw", requireAuth, async (req, res): Promise<void> => {
    await venueDepositWithdraw({ kind: "ripperdoc", venueId: parseInt(String(req.params.id), 10), direction: "withdraw", amount: Number(req.body?.amount), idempotencyKey: req.body?.idempotencyKey, req, res });
  });

  // Admin-only: inject eddies straight into a store's account balance. There is
  // no personal-wallet leg — this credits website-side balance (seeding a store,
  // corrections, rewards). Writes a synced ledger row + audit, idempotent on the
  // client key so a double-submit can't credit twice.
  router.post("/stores/:id/grant", requireAuth, async (req, res): Promise<void> => {
    if (!hasRole(req.user!.roles, "ADMIN")) {
      res.status(403).json({ error: "Only admins can grant funds to a store." });
      return;
    }
    const venueId = parseInt(String(req.params.id), 10);
    const amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be a positive whole number" });
      return;
    }
    const [store] = await db.select().from(stores).where(eq(stores.id, venueId));
    if (!store) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (store.balance + amount > MAX_WALLET_BALANCE) {
      res.status(400).json({ error: `This would push the store balance past the maximum of ${MAX_WALLET_BALANCE.toLocaleString()} eddies.` });
      return;
    }
    const clientKey =
      typeof req.body?.idempotencyKey === "string" && req.body.idempotencyKey.trim().length > 0
        ? req.body.idempotencyKey.trim().slice(0, 100)
        : String(Date.now());
    const idempotencyKey = `store-grant-${venueId}-${clientKey}`;
    const { ip, ua } = auditMeta(req);
    const finalBalance = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ newBalance: walletTransactions.newBalance })
        .from(walletTransactions)
        .where(eq(walletTransactions.idempotencyKey, idempotencyKey));
      if (existing) return existing.newBalance ?? store.balance;
      const [u] = await tx
        .update(stores)
        .set({ balance: sql`${stores.balance} + ${amount}` })
        .where(eq(stores.id, venueId))
        .returning({ balance: stores.balance });
      const newBalance = u.balance;
      await tx.insert(walletTransactions).values({
        amount,
        kind: "store_grant",
        source: "store",
        syncStatus: "synced",
        memo: `Admin grant — ${store.name}`,
        previousBalance: newBalance - amount,
        newBalance,
        storeId: venueId,
        relatedEntityType: "store",
        relatedEntityId: venueId,
        idempotencyKey,
      });
      await tx.insert(auditLog).values({
        category: "shop",
        action: "store_grant",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "store",
        targetId: String(venueId),
        message: `Granted ${amount} eddies to ${store.name}`,
      });
      return newBalance;
    });
    res.json({ ok: true, venueBalance: finalBalance, walletBalance: 0 });
  });

  router.post("/stores/:id/give", requireAuth, async (req, res): Promise<void> => {
    await venueGive("store", req, res);
  });
  // "/ripperdocs/:id/give" is already taken by the item-gift flow, so the money
  // path gets an explicit "-eddies" suffix.
  router.post("/ripperdocs/:id/give-eddies", requireAuth, async (req, res): Promise<void> => {
    await venueGive("ripperdoc", req, res);
  });

  // Per-venue transaction history (owner or staff only).
  router.get("/stores/:id/transactions", requireAuth, async (req, res): Promise<void> => {
    const s = await loadManageableStore(req, res);
    if (!s) return;
    const rows = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.storeId, s.id))
      .orderBy(desc(walletTransactions.createdAt))
      .limit(100);
    res.json(rows);
  });
  router.get("/ripperdocs/:id/transactions", requireAuth, async (req, res): Promise<void> => {
    const r = await loadManageableRipperdoc(req, res);
    if (!r) return;
    const rows = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.ripperdocId, r.id))
      .orderBy(desc(walletTransactions.createdAt))
      .limit(100);
    res.json(rows);
  });
}
