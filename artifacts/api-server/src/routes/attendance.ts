import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, attendanceClaims, activityEvents } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { patchBalance } from "../lib/unbelievaboat";
import { logger } from "../lib/logger";

const WEEKLY_ATTEND_PAYOUT = 250;

// ISO-week Monday 00:00 UTC for the date passed in. The `attendance_claims`
// row stores this as a `date` (YYYY-MM-DD) so the UNIQUE index naturally
// enforces one-claim-per-user-per-week without us having to do any range
// math on read.
function isoWeekStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay: 0=Sun..6=Sat. ISO week starts on Monday → shift Sunday to 7.
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

const router: IRouter = Router();

// Returns this week's claim state for the signed-in user. The UI uses this
// to decide whether to disable the CLAIM button.
router.get("/attendance/me", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const weekStart = isoWeekStart(new Date());
  const [row] = await db
    .select()
    .from(attendanceClaims)
    .where(and(eq(attendanceClaims.userId, userId), eq(attendanceClaims.weekStart, weekStart)));
  const recent = await db
    .select()
    .from(attendanceClaims)
    .where(eq(attendanceClaims.userId, userId))
    .orderBy(desc(attendanceClaims.weekStart))
    .limit(8);
  res.json({
    weekStart,
    payout: WEEKLY_ATTEND_PAYOUT,
    claimed: !!row,
    claimedAt: row?.claimedAt ?? null,
    history: recent.map((r) => ({
      weekStart: r.weekStart,
      amount: r.amount,
      claimedAt: r.claimedAt,
    })),
  });
});

// Records a weekly attend claim and credits the user's UB balance. The
// UNIQUE (userId, weekStart) index in the attendance_claims table is the
// only thing standing between an honest user and a double-claim — we rely
// on it for correctness rather than a read-then-write race. UB credit is
// best-effort: if UB rejects, we 502 BEFORE inserting the claim row so the
// user can retry without losing their week.
router.post("/attendance/claim", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const discordId = req.user!.discordId;
  const weekStart = isoWeekStart(new Date());

  // Pre-check (race-safe with the unique index below — the index is the
  // source of truth, this is just to skip the UB roundtrip on the obvious
  // already-claimed case).
  const [existing] = await db
    .select()
    .from(attendanceClaims)
    .where(and(eq(attendanceClaims.userId, userId), eq(attendanceClaims.weekStart, weekStart)));
  if (existing) {
    res.status(409).json({
      error: "Already claimed this week",
      weekStart,
      claimedAt: existing.claimedAt,
    });
    return;
  }

  const ub = await patchBalance(discordId, {
    cash: WEEKLY_ATTEND_PAYOUT,
    reason: `Weekly attendance bonus (${weekStart})`,
  });
  if (!ub) {
    logger.warn({ userId, weekStart }, "attendance/claim UB credit failed");
    res.status(502).json({ error: "UnbelievaBoat unavailable, try again shortly" });
    return;
  }

  try {
    const [row] = await db
      .insert(attendanceClaims)
      .values({ userId, weekStart, amount: WEEKLY_ATTEND_PAYOUT })
      .returning();
    await db.insert(activityEvents).values({
      kind: "attendance_claim",
      actorId: userId,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message: `${req.user!.username} claimed weekly attendance (+€$${WEEKLY_ATTEND_PAYOUT})`,
    });
    res.json({
      weekStart: row.weekStart,
      amount: row.amount,
      claimedAt: row.claimedAt,
      newBalance: ub.total,
    });
  } catch (err: unknown) {
    // Unique-violation: another tab raced us. Refund UB so the credit
    // matches the (single) claim row and tell the caller the truth.
    // If the refund itself fails we MUST NOT report a clean 409 — that
    // would leave the user with an unreconciled extra €$250 and no
    // record. Surface a 502 + structured log so an operator can refund
    // by hand. (The 23505 still prevents a second DB row, so the
    // ledger isn't corrupted — only UB drifted.)
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      const refund = await patchBalance(discordId, {
        cash: -WEEKLY_ATTEND_PAYOUT,
        reason: `Refund: duplicate weekly attendance claim (${weekStart})`,
      });
      if (!refund) {
        logger.error(
          { userId, weekStart, discordId, amount: WEEKLY_ATTEND_PAYOUT },
          "ATTENDANCE_REFUND_FAILED: duplicate claim could not be refunded — manual reconciliation required",
        );
        res.status(502).json({
          error: "Duplicate claim detected but refund failed. Contact staff for reconciliation.",
          weekStart,
        });
        return;
      }
      res.status(409).json({ error: "Already claimed this week", weekStart });
      return;
    }
    logger.error({ err, userId, weekStart }, "attendance/claim insert failed after UB credit");
    res.status(500).json({ error: "claim recorded in UB but ledger insert failed" });
  }
});

export default router;
