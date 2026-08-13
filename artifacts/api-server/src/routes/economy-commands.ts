import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, incomeCommandUses, users } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { applyWalletDelta } from "../lib/economy";
import { fetchGuildMemberRoleIdsViaBot } from "../lib/discord";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// --- Income command tuning -------------------------------------------------
// These are OUR portal-side mechanics (a separate cooldown ledger + random
// payout), NOT a passthrough to UnbelievaBoat's own !work/!slut — UB does not
// expose its cooldown/config via API. Payouts still move real eddies through
// applyWalletDelta (the single idempotent wallet entry point).
const COOLDOWN_HOURS = 20;
const COOLDOWN_MS = COOLDOWN_HOURS * 60 * 60 * 1000;

const WORK = { command: "work", min: 100, max: 200 } as const;
const SLUT = { command: "slut", min: 100, max: 500 } as const;

// Joytoy-only gate for the SLUT command (exact Discord role id).
const JOYTOY_ROLE_ID = "1380299658387128340";
// On a SLUT run there is a 20% chance of a fine instead of a payout; the fine
// is 1%–3% of the player's total balance.
const SLUT_FINE_CHANCE = 0.2;
const SLUT_FINE_MIN_PCT = 0.01;
const SLUT_FINE_MAX_PCT = 0.03;

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function cooldownEndsAt(lastUsedAt: Date): Date {
  return new Date(lastUsedAt.getTime() + COOLDOWN_MS);
}

// Atomically reserve the cooldown slot. A single INSERT ... ON CONFLICT DO
// UPDATE ... WHERE statement is the whole concurrency guard: it only writes
// (and RETURNs a row) when there is no existing row OR the prior one is past
// its cooldown. Two racing clicks therefore can't both reserve. Returns the
// reserved timestamp on success, or null when still on cooldown.
async function reserveCooldown(userId: string, command: string): Promise<Date | null> {
  const result = await db.execute(sql`
    INSERT INTO income_command_uses (user_id, command, last_used_at)
    VALUES (${userId}, ${command}, now())
    ON CONFLICT (user_id, command)
    DO UPDATE SET last_used_at = now()
    WHERE income_command_uses.last_used_at <= now() - make_interval(hours => ${COOLDOWN_HOURS})
    RETURNING last_used_at
  `);
  const rows =
    (result as unknown as { rows?: Array<{ last_used_at: string | Date }> }).rows ??
    (result as unknown as Array<{ last_used_at: string | Date }>);
  const row = rows?.[0];
  return row ? new Date(row.last_used_at) : null;
}

// Undo a reservation when the wallet move could not be completed, so the player
// is not charged a 20h cooldown for a command that never paid out.
async function releaseCooldown(userId: string, command: string): Promise<void> {
  await db
    .delete(incomeCommandUses)
    .where(and(eq(incomeCommandUses.userId, userId), eq(incomeCommandUses.command, command)));
}

async function isJoytoy(discordId: string): Promise<boolean | null> {
  const roleIds = await fetchGuildMemberRoleIdsViaBot(discordId);
  if (roleIds === null) return null; // couldn't determine
  return roleIds.includes(JOYTOY_ROLE_ID);
}

// GET /economy/income — current balance + per-command availability so the
// dashboard card can render the buttons, countdowns, and eligibility.
router.get("/economy/income", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const uid = req.user!.id;
  const [[me], rows, joytoy] = await Promise.all([
    db.select({ balance: users.walletBalance }).from(users).where(eq(users.id, uid)),
    db.select().from(incomeCommandUses).where(eq(incomeCommandUses.userId, uid)),
    isJoytoy(req.user!.discordId),
  ]);
  const now = Date.now();
  const byCommand = new Map(rows.map((r) => [r.command, r]));
  const status = (command: string) => {
    const row = byCommand.get(command);
    if (!row) return { available: true, cooldownEndsAt: null as string | null };
    const ends = cooldownEndsAt(row.lastUsedAt);
    return { available: now >= ends.getTime(), cooldownEndsAt: ends.toISOString() };
  };
  const work = status(WORK.command);
  const slut = status(SLUT.command);
  res.json({
    balance: me?.balance ?? null,
    work,
    slut: { eligible: joytoy === true, ...slut },
  });
});

// POST /economy/income/work — anyone; pays a random 100–200 eddies, 20h cd.
router.post("/economy/income/work", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const uid = req.user!.id;
  const reservedAt = await reserveCooldown(uid, WORK.command);
  if (!reservedAt) {
    const [row] = await db
      .select()
      .from(incomeCommandUses)
      .where(and(eq(incomeCommandUses.userId, uid), eq(incomeCommandUses.command, WORK.command)));
    res.status(429).json({
      error: "WORK is on cooldown.",
      cooldownEndsAt: row ? cooldownEndsAt(row.lastUsedAt).toISOString() : null,
    });
    return;
  }

  const amount = randInt(WORK.min, WORK.max);
  const result = await applyWalletDelta({
    userId: uid,
    discordId: req.user!.discordId,
    amount,
    source: "commission",
    kind: "work",
    reason: "Portal WORK command",
    idempotencyKey: `work:${uid}:${reservedAt.toISOString()}`,
  });
  if (!result.ok && result.status !== "dry_run") {
    await releaseCooldown(uid, WORK.command);
    if (result.status === "disabled") {
      res.status(503).json({ error: "The economy is currently disabled. An admin must enable the Economy System before WORK can pay out." });
      return;
    }
    res.status(502).json({ error: "Could not complete WORK right now. Try again shortly." });
    return;
  }

  res.json({
    command: "work",
    outcome: "earned",
    amount,
    balance: result.balance,
    cooldownEndsAt: cooldownEndsAt(reservedAt).toISOString(),
  });
});

// POST /economy/income/slut — joytoy role only; 80% chance to earn 100–500,
// 20% chance of a fine worth 1–3% of total balance. 20h cd.
router.post("/economy/income/slut", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const uid = req.user!.id;

  const joytoy = await isJoytoy(req.user!.discordId);
  if (joytoy === null) {
    res.status(502).json({ error: "Could not verify your roles. Try again shortly." });
    return;
  }
  if (!joytoy) {
    res.status(403).json({ error: "The SLUT command is available to joytoys only." });
    return;
  }

  // Need the current total up front to size a potential fine. Website wallet
  // is the source of truth.
  const [me] = await db.select({ balance: users.walletBalance }).from(users).where(eq(users.id, uid));
  const totalForFine = Math.max(0, me?.balance ?? 0);

  const reservedAt = await reserveCooldown(uid, SLUT.command);
  if (!reservedAt) {
    const [row] = await db
      .select()
      .from(incomeCommandUses)
      .where(and(eq(incomeCommandUses.userId, uid), eq(incomeCommandUses.command, SLUT.command)));
    res.status(429).json({
      error: "SLUT is on cooldown.",
      cooldownEndsAt: row ? cooldownEndsAt(row.lastUsedAt).toISOString() : null,
    });
    return;
  }

  const fined = Math.random() < SLUT_FINE_CHANCE;
  let amount: number;
  if (fined) {
    const pct = SLUT_FINE_MIN_PCT + Math.random() * (SLUT_FINE_MAX_PCT - SLUT_FINE_MIN_PCT);
    const fine = Math.max(0, Math.round(totalForFine * pct));
    amount = -fine;
  } else {
    amount = randInt(SLUT.min, SLUT.max);
  }

  const result = await applyWalletDelta({
    userId: uid,
    discordId: req.user!.discordId,
    amount,
    source: "commission",
    kind: "slut",
    reason: fined ? "Portal SLUT command (fine)" : "Portal SLUT command",
    idempotencyKey: `slut:${uid}:${reservedAt.toISOString()}`,
  });
  if (!result.ok && result.status !== "dry_run") {
    await releaseCooldown(uid, SLUT.command);
    logger.warn({ uid, status: result.status }, "SLUT wallet apply failed");
    if (result.status === "disabled") {
      res.status(503).json({ error: "The economy is currently disabled. An admin must enable the Economy System before SLUT can pay out." });
      return;
    }
    res.status(502).json({ error: "Could not complete SLUT right now. Try again shortly." });
    return;
  }

  res.json({
    command: "slut",
    outcome: fined ? "fined" : "earned",
    amount,
    balance: result.balance,
    cooldownEndsAt: cooldownEndsAt(reservedAt).toISOString(),
  });
});

export default router;
