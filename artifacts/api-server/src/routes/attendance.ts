import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, attendanceClaims, activityEvents } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { patchBalance } from "../lib/unbelievaboat";
import { logger } from "../lib/logger";
import { recordAudit } from "../lib/audit";

const WEEKLY_ATTEND_PAYOUT = 250;

// Attendance can only be claimed during the in-game session window:
// Sundays 2pm-9pm Pacific Time. We use Intl.DateTimeFormat against
// America/Los_Angeles so DST is handled correctly (PST ↔ PDT shifts
// twice a year and naive UTC offset math would silently drift).
const ATTENDANCE_TZ = "America/Los_Angeles";
const ATTENDANCE_DAY = "Sun";
const ATTENDANCE_HOUR_START = 14; // 2pm inclusive
const ATTENDANCE_HOUR_END = 21;   // 9pm exclusive (i.e. window closes at 21:00)

function pacificParts(now: Date): { weekday: string; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ATTENDANCE_TZ,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  // Intl reports midnight as "24" with hour12:false in some runtimes.
  const hourNum = parseInt(hourStr, 10);
  const hour = Number.isNaN(hourNum) ? 0 : (hourNum === 24 ? 0 : hourNum);
  return { weekday, hour };
}

export function isAttendanceWindowOpen(now: Date = new Date()): boolean {
  const { weekday, hour } = pacificParts(now);
  return weekday === ATTENDANCE_DAY && hour >= ATTENDANCE_HOUR_START && hour < ATTENDANCE_HOUR_END;
}

// Next Sunday-2pm-PST opening, computed by stepping hour-by-hour from
// `now`. Bounded to 9 days so we always terminate even if Intl returns
// something unexpected. Used purely for UI display.
export function nextAttendanceWindowStart(now: Date = new Date()): Date {
  const cursor = new Date(now.getTime());
  for (let i = 0; i < 24 * 9; i++) {
    cursor.setTime(cursor.getTime() + 60 * 60 * 1000);
    const { weekday, hour } = pacificParts(cursor);
    if (weekday === ATTENDANCE_DAY && hour === ATTENDANCE_HOUR_START) return cursor;
  }
  return cursor;
}

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
  const windowOpen = isAttendanceWindowOpen();
  res.json({
    weekStart,
    payout: WEEKLY_ATTEND_PAYOUT,
    claimed: !!row,
    claimedAt: row?.claimedAt ?? null,
    windowOpen,
    nextWindowOpensAt: windowOpen ? null : nextAttendanceWindowStart().toISOString(),
    windowHint: "Sundays 2:00pm–9:00pm Pacific",
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

  // Attendance is only claimable during the live session window
  // (Sundays 2-9pm PST). The frontend disables the button outside the
  // window but the server is authoritative — reject closed-window POSTs
  // before we ever hit UB.
  if (!isAttendanceWindowOpen()) {
    res.status(403).json({
      error: "Attendance can only be claimed during Sunday sessions (2:00pm–9:00pm Pacific).",
      nextWindowOpensAt: nextAttendanceWindowStart().toISOString(),
    });
    return;
  }

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
    await recordAudit({
      req,
      category: "attendance",
      action: "claim",
      targetType: "user",
      targetId: userId,
      message: `Weekly attendance claimed (+${WEEKLY_ATTEND_PAYOUT})`,
      after: { weekStart, amount: WEEKLY_ATTEND_PAYOUT },
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
