import type { IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, users, characters } from "@workspace/db";
import { recordAudit } from "../../lib/audit";
import { getBalance } from "../../lib/unbelievaboat";
import { getEconomyMode, reconcileOneUser } from "../../lib/economy";
import { adminOnly } from "./shared";

export function registerEconomy(router: IRouter): void {
  router.get("/admin/stats", adminOnly, async (_req, res): Promise<void> => {
    const [{ count: userCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
    const [{ count: charCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(characters);
    res.json({ userCount, charCount });
  });

  // ─── Economy sync dashboard ───────────────────────────────────────────────
  // Surface players whose website wallet has drifted from their live UB balance
  // (or whose last sync failed / whose UB balance can't be fetched) so an admin
  // can investigate and trigger a safe per-user re-sync.
  router.get("/admin/economy/out-of-sync", adminOnly, async (_req, res): Promise<void> => {
    const mode = await getEconomyMode();
    const rows = await db.select().from(users);
    const entries = [];
    for (const u of rows) {
      const ub = await getBalance(u.discordId);
      const ubBalance = ub ? ub.total : null;
      const diff = ubBalance === null ? null : ubBalance - u.walletBalance;
      const drift = diff !== null && diff !== 0;
      const failed = u.lastSyncStatus === "failed";
      const unreachable = ubBalance === null;
      if (!drift && !failed && !unreachable) continue;
      entries.push({
        userId: u.id,
        discordId: u.discordId,
        username: u.username,
        globalName: u.globalName,
        walletBalance: u.walletBalance,
        ubBalance,
        lastSyncedUbBalance: u.lastSyncedUbBalance,
        diff,
        lastSyncedAt: u.lastSyncedAt,
        lastSyncStatus: u.lastSyncStatus,
        lastSyncError: u.lastSyncError,
      });
    }
    res.json({ mode, entries });
  });

  router.post("/admin/economy/retry/:userId", adminOnly, async (req, res): Promise<void> => {
    const userId = String(req.params.userId);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u) {
      res.status(404).json({ error: "Unknown user" });
      return;
    }
    const result = await reconcileOneUser(userId);
    if (result.status === "disabled") {
      res.status(409).json({ ok: false, status: "disabled", balance: result.balance, error: "The economy system is currently disabled." });
      return;
    }
    await recordAudit({
      req,
      category: "wallet",
      action: "economy_retry",
      targetType: "user",
      targetId: userId,
      message: `${req.user!.username} re-synced ${u.username}'s wallet (status: ${result.status}, delta: ${result.delta >= 0 ? "+" : ""}${result.delta})`,
      after: { status: result.status, delta: result.delta, balance: result.balance },
    });
    res.json({ ok: result.ok, status: result.status, balance: result.balance, error: result.error ?? null });
  });
}
