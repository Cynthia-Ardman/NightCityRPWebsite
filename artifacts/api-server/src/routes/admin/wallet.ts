import type { IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, users, characters } from "@workspace/db";
import { recordAudit } from "../../lib/audit";
import {
  applyWalletDelta,
  websiteWalletPayload,
  getMirrorHealth,
  drainUbPushOutbox,
} from "../../lib/economy";
import { adminOnly, adminOrFixer } from "./shared";

export function registerWallet(router: IRouter): void {
  // Admin OR fixer: fixers adjust player wallets from the Fixer Hub player
  // lookup. Accepts either a characterId (ledger attributed to that character)
  // or a bare userId (players with no approved character — account-level row).
  router.post("/admin/wallet/adjust", adminOrFixer, async (req, res): Promise<void> => {
    const { characterId, userId, amount, memo, reason } = req.body ?? {};
    // The portal sends `reason`; older callers may send `memo`. Accept either.
    const note =
      typeof memo === "string" && memo.trim()
        ? memo.trim()
        : typeof reason === "string" && reason.trim()
          ? reason.trim()
          : null;
    if (typeof amount !== "number" || (!characterId && !userId) || (characterId && userId)) {
      res.status(400).json({ error: "amount and exactly one of characterId / userId required" });
      return;
    }
    let c: typeof characters.$inferSelect | null = null;
    let owner: typeof users.$inferSelect | undefined;
    if (characterId) {
      const [row] = await db.select().from(characters).where(eq(characters.id, characterId));
      if (!row) {
        res.status(404).json({ error: "Character not found" });
        return;
      }
      if (!row.ownerId) {
        res.status(400).json({ error: "Character has no owner (unclaimed)" });
        return;
      }
      c = row;
      [owner] = await db.select().from(users).where(eq(users.id, row.ownerId));
    } else {
      [owner] = await db.select().from(users).where(eq(users.id, String(userId)));
    }
    if (!owner) {
      res.status(404).json({ error: "Target account not found" });
      return;
    }
    // Optional client idempotencyKey dedupes accidental double-submits of the
    // same adjustment (enforced inside applyWalletDelta).
    const idempotencyKey =
      typeof req.body?.idempotencyKey === "string" && req.body.idempotencyKey.trim()
        ? `admin_adjust:${req.body.idempotencyKey.trim().slice(0, 80)}`
        : null;
    // Website-first: the adjustment commits locally and mirrors to UB via the
    // outbox. Admin adjustments may force a wallet negative (that's the
    // documented escape hatch vs the sink's balance check).
    const applied = await applyWalletDelta({
      userId: owner.id,
      discordId: owner.discordId,
      amount,
      source: "admin",
      kind: "admin",
      reason: note ?? "Admin adjustment",
      memo: note,
      characterId: c?.id ?? null,
      counterpartyName: req.user!.username,
      idempotencyKey,
      allowNegative: true,
      gate: "none",
    });
    if (!applied.ok) {
      res.status(502).json({ error: applied.error ?? "Wallet adjustment failed" });
      return;
    }
    const targetLabel = c ? c.name : owner.globalName || owner.username;
    await recordAudit({
      req,
      category: "wallet",
      action: "admin_adjust",
      targetType: c ? "character" : "user",
      targetId: c?.id ?? null,
      message: `${req.user!.username} adjusted ${targetLabel} by ${amount >= 0 ? "+" : ""}${amount}`,
      after: { amount, memo: note, ownerDiscordId: owner.discordId, userId: owner.id },
    });
    res.json({ success: true });
  });

  // Staff money sink: burn eddies from any character by "paying Night City Bot".
  // A debit-only movement (no counterparty account credited) recorded with kind
  // "sink" so it reads clearly in the ledger. Requires the character to have the
  // cash on hand — for forcible removal beyond balance, use /admin/wallet/adjust.
  router.post("/admin/wallet/sink", adminOnly, async (req, res): Promise<void> => {
    const { characterId, amount, memo } = req.body ?? {};
    const note = typeof memo === "string" && memo.trim() ? memo.trim() : null;
    if (!characterId || typeof amount !== "number" || amount <= 0) {
      res.status(400).json({ error: "characterId and positive amount required" });
      return;
    }
    const [c] = await db.select().from(characters).where(eq(characters.id, characterId));
    if (!c) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    if (!c.ownerId) {
      res.status(400).json({ error: "Character has no owner (unclaimed)" });
      return;
    }
    const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
    if (!owner) {
      res.status(404).json({ error: "Character owner not found" });
      return;
    }
    const sinkKey =
      typeof req.body?.idempotencyKey === "string" && req.body.idempotencyKey.trim()
        ? `sink:${req.body.idempotencyKey.trim().slice(0, 80)}`
        : null;
    // Website-first debit, authorized against the website balance (the source of
    // truth). Keyed idempotency + the overdraw check live inside applyWalletDelta.
    const debited = await applyWalletDelta({
      userId: owner.id,
      discordId: owner.discordId,
      amount: -amount,
      source: "admin",
      kind: "sink",
      reason: note ?? "Paid Night City Bot",
      memo: note,
      characterId,
      counterpartyName: "Night City Bot",
      idempotencyKey: sinkKey,
      gate: "none",
    });
    if (!debited.ok) {
      if (debited.status === "insufficient_funds") {
        res.status(400).json({
          error: `Insufficient funds — ${c.name}'s owner has ${debited.balance.toLocaleString()} €$. Use Manual Wallet Adjustment to force-remove beyond balance.`,
        });
        return;
      }
      res.status(502).json({ error: debited.error ?? "Wallet debit failed" });
      return;
    }
    await recordAudit({
      req,
      category: "wallet",
      action: "sink",
      targetType: "character",
      targetId: characterId,
      message: `${req.user!.username} burned ${amount} from ${c.name} (paid Night City Bot)`,
      after: { characterId, amount, memo: note, ownerDiscordId: owner.discordId },
    });
    res.json({ characterId, ...(await websiteWalletPayload(owner.id, owner.discordId)) });
  });

  // ---- UB mirror health (System Admin panel) --------------------------------
  // The website wallet is the source of truth; these endpoints surface the
  // health of the UnbelievaBoat mirror: queued/inflight pushes, last successful
  // push, recent push failures, and per-user queue depth vs the expected UB
  // total, plus manual "push now" / "reconcile now" triggers.
  router.get("/admin/wallet/mirror-health", adminOnly, async (_req, res): Promise<void> => {
    res.json(await getMirrorHealth());
  });

  router.post("/admin/wallet/mirror-push", adminOnly, async (req, res): Promise<void> => {
    const userId = typeof req.body?.userId === "string" && req.body.userId.trim() ? req.body.userId.trim() : undefined;
    const result = await drainUbPushOutbox({ userId });
    await recordAudit({
      req,
      category: "wallet",
      action: "mirror_push",
      targetType: userId ? "user" : "system",
      targetId: null,
      message: `Manual UB mirror push${userId ? ` for user ${userId}` : ""}: pushed ${result.pushed}, failed ${result.failed}, suppressed ${result.suppressed}`,
      after: { userId: userId ?? null, ...result },
    });
    res.json(result);
  });
}
