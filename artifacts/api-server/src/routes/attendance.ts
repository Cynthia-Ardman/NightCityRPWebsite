import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db, attendanceClaims, activityEvents, botAttendanceLog, type AttendanceClaim } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { patchBalance } from "../lib/unbelievaboat";
import { logger } from "../lib/logger";
import { recordAudit } from "../lib/audit";
import {
  isSessionWindowOpen,
  nextSessionWindowStart,
  sessionWeekKey,
  legacySessionWeekKeys,
  SESSION_WINDOW_HINT,
} from "../lib/sessionWindow";

const WEEKLY_ATTEND_PAYOUT = 250;

const router: IRouter = Router();

// Find the user's claim for the CURRENT Pacific session week, if any. We look
// up the new Pacific-Sunday key plus the legacy UTC-Monday keys it replaced,
// then disambiguate legacy hits by re-deriving the session week from each
// row's `claimedAt` (legacy keys overlap across weeks, so a bare key match can
// be a different week's row). This keeps a pre-cutover claim from being
// re-claimed under the new key during the rollout, without false-positives.
async function findThisWeekClaim(userId: string, weekKey: string): Promise<AttendanceClaim | undefined> {
  const candidateKeys = Array.from(new Set([weekKey, ...legacySessionWeekKeys()]));
  const rows = await db
    .select()
    .from(attendanceClaims)
    .where(and(eq(attendanceClaims.userId, userId), inArray(attendanceClaims.weekStart, candidateKeys)));
  return rows.find((r) => r.weekStart === weekKey || sessionWeekKey(r.claimedAt) === weekKey);
}

// Returns this week's claim state for the signed-in user. The UI uses this
// to decide whether to disable the CLAIM button.
router.get("/attendance/me", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const weekStart = sessionWeekKey();
  const row = await findThisWeekClaim(userId, weekStart);
  const recent = await db
    .select()
    .from(attendanceClaims)
    .where(eq(attendanceClaims.userId, userId))
    .orderBy(desc(attendanceClaims.weekStart))
    .limit(8);
  const windowOpen = isSessionWindowOpen();
  res.json({
    weekStart,
    payout: WEEKLY_ATTEND_PAYOUT,
    claimed: !!row,
    claimedAt: row?.claimedAt ?? null,
    windowOpen,
    nextWindowOpensAt: windowOpen ? null : nextSessionWindowStart().toISOString(),
    windowHint: SESSION_WINDOW_HINT,
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
  const weekStart = sessionWeekKey();

  // Attendance is only claimable during the live session window
  // (Sundays 2-9pm PST). The frontend disables the button outside the
  // window but the server is authoritative — reject closed-window POSTs
  // before we ever hit UB.
  if (!isSessionWindowOpen()) {
    res.status(403).json({
      error: "Attendance can only be claimed during Sunday sessions (2:00pm–9:00pm Pacific).",
      nextWindowOpensAt: nextSessionWindowStart().toISOString(),
    });
    return;
  }

  // Pre-check (race-safe with the unique index below — the index is the
  // source of truth, this is just to skip the UB roundtrip on the obvious
  // already-claimed case). Also covers legacy-keyed rows from before the
  // Pacific-Sunday cutover so a pre-cutover claim can't be re-claimed.
  const existing = await findThisWeekClaim(userId, weekStart);
  if (existing) {
    res.status(409).json({
      error: "Already claimed this week",
      weekStart,
      claimedAt: existing.claimedAt,
    });
    return;
  }

  // Reserve the claim row BEFORE crediting UB. The UNIQUE (userId, weekStart)
  // index makes the insert the single source of truth: if it fails for any
  // reason we never credit UB, so a retry can't double-pay. Crediting first
  // (the old order) meant a non-unique insert failure left money in UB with no
  // claim row, which a retry would pay again.
  let row: AttendanceClaim;
  try {
    [row] = await db
      .insert(attendanceClaims)
      .values({ userId, weekStart, amount: WEEKLY_ATTEND_PAYOUT })
      .returning();
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ error: "Already claimed this week", weekStart });
      return;
    }
    logger.error({ err, userId, weekStart }, "attendance/claim reservation insert failed");
    res.status(500).json({ error: "Could not record attendance claim" });
    return;
  }

  const ub = await patchBalance(discordId, {
    cash: WEEKLY_ATTEND_PAYOUT,
    reason: `Weekly attendance bonus (${weekStart})`,
  });
  if (!ub) {
    // UB credit failed — release the reservation so the user can retry cleanly.
    // (No refund needed: no money was credited.)
    try {
      await db.delete(attendanceClaims).where(eq(attendanceClaims.id, row.id));
    } catch (e) {
      logger.error(
        { err: e, userId, weekStart, claimId: row.id },
        "attendance/claim: failed to release reservation after UB failure — manual cleanup may be needed",
      );
    }
    logger.warn({ userId, weekStart }, "attendance/claim UB credit failed");
    res.status(502).json({ error: "UnbelievaBoat unavailable, try again shortly" });
    return;
  }

  // Money is credited and the claim row is durable. Activity/audit are
  // best-effort: even if they throw, a retry hits the unique index (409) and
  // cannot double-pay.
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
});

// Full attendance history for the signed-in user: portal-era weekly claims
// (attendance_claims, keyed by portal user id) merged with the imported
// bot-era check-ins (bot_attendance_log, keyed by Discord id). Read-only —
// powers the "ATTENDANCE HISTORY" dialog on the dashboard.
router.get("/attendance/history", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const discordId = req.user!.discordId;
  const [claims, botLogs] = await Promise.all([
    db
      .select()
      .from(attendanceClaims)
      .where(eq(attendanceClaims.userId, userId))
      .orderBy(desc(attendanceClaims.weekStart))
      .limit(500),
    db
      .select()
      .from(botAttendanceLog)
      .where(eq(botAttendanceLog.userId, discordId))
      .orderBy(desc(botAttendanceLog.loggedAt))
      .limit(500),
  ]);

  const entries = [
    ...claims.map((c) => ({
      source: "portal" as const,
      at: c.claimedAt ? new Date(c.claimedAt) : new Date(`${c.weekStart}T00:00:00Z`),
      date: c.weekStart,
      amount: c.amount as number | null,
    })),
    ...botLogs.map((b) => ({
      source: "bot" as const,
      at: new Date(b.loggedAt),
      date: new Date(b.loggedAt).toISOString().slice(0, 10),
      amount: null as number | null,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  res.json({
    totalCount: entries.length,
    portalCount: claims.length,
    botCount: botLogs.length,
    entries: entries.map((e) => ({
      source: e.source,
      date: e.date,
      at: e.at.toISOString(),
      amount: e.amount,
    })),
  });
});

export default router;
