import { Router, type IRouter } from "express";
import { eq, desc, and, or, sql, inArray } from "drizzle-orm";
import {
  db,
  characters,
  characterStatus,
  characterSheets,
  activityEvents,
  auditLog,
  fixerNpcs,
  users,
  housing,
  walletTransactions,
  inventoryItems,
  botCyberwareStatus,
  botCyberwareWeeklyRuns,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { getBalance } from "../lib/unbelievaboat";
import { hasRole } from "../lib/discord";
import { projectedWeeklyMeds, weeksSinceLastCheckup, deriveCyberwareBand } from "../lib/jobs";
import { sumCwpByCharacter } from "../lib/cyberware";

// Keep this in sync with `lib/jobs.ts` — it's the rent the monthly_rent cron
// actually debits per approved PC. Meds use a different formula keyed on
// the ripperdoc-assigned cyberwareLevel — see projectedWeeklyMeds().
const RENT_PER_PC_PER_MONTH = 500;

// monthly_rent cron runs 04:00 UTC on the 1st of every month.
function nextMonthlyRunDate(now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 4, 0, 0));
  if (d.getTime() <= now.getTime()) d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

// cyberware_humanity cron runs 05:00 UTC on Mondays.
function nextWeeklyRunDate(now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setUTCHours(5, 0, 0, 0);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat; Monday=1
  const daysUntilMon = (1 - dow + 7) % 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMon);
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

const router: IRouter = Router();

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const myChars = await db.select().from(characters).where(eq(characters.ownerId, req.user!.id));
  const characterIds = myChars.map((c) => c.id);
  let openShops = 0;
  let attendingCount = 0;
  let loaCount = 0;
  if (characterIds.length) {
    const statuses = await db
      .select()
      .from(characterStatus)
      .where(inArray(characterStatus.characterId, characterIds));
    for (const s of statuses) {
      if (s.openShop) openShops++;
      if (s.attending) attendingCount++;
      if (s.loa) loaCount++;
    }
  }
  const ub = await getBalance(req.user!.discordId);
  const totalEddies = ub?.total ?? 0;
  const [{ pending }] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(characterSheets)
    .where(eq(characterSheets.status, "pending"));
  const topFixers = await db
    .select({
      fixerId: fixerNpcs.fixerId,
      fixerName: users.username,
      avatarUrl: users.avatarUrl,
      count: sql<number>`count(*)::int`,
    })
    .from(fixerNpcs)
    .leftJoin(users, eq(users.id, fixerNpcs.fixerId))
    .groupBy(fixerNpcs.fixerId, users.username, users.avatarUrl)
    .orderBy(desc(sql`count(*)`))
    .limit(5);
  // Roster snippet shown on every dashboard. Must NOT include sheet body
  // fields (background, sheetData, importedFromThreadId, ownerId, …) —
  // those are owner/staff-only per the character-sheet visibility policy
  // enforced in routes/directory.ts. Keep this to the minimum a roster
  // tile renders: name, kind, archetype, portrait.
  const recentArrivals = await db
    .select({
      id: characters.id,
      name: characters.name,
      kind: characters.kind,
      archetype: characters.archetype,
      portraitUrl: characters.portraitUrl,
      createdAt: characters.createdAt,
    })
    .from(characters)
    .where(eq(characters.kind, "pc"))
    .orderBy(desc(characters.createdAt))
    .limit(5);
  res.json({
    characterCount: myChars.length,
    activeCharacterCount: characterIds.length,
    totalEddies,
    openShops,
    attendingCount,
    loaCount,
    pendingSheets: pending,
    topFixers,
    recentArrivals,
  });
});

router.get("/dashboard/upcoming-bills", requireAuth, async (req, res): Promise<void> => {
  const ownerId = req.user!.id;
  const myChars = await db.select().from(characters).where(eq(characters.ownerId, ownerId));
  const billable = myChars.filter((c) => c.kind === "pc" && c.approved && !c.archived);

  const now = new Date();
  const rentDueAt = nextMonthlyRunDate(now).toISOString();
  const medsDueAt = nextWeeklyRunDate(now).toISOString();

  const rent = billable.map((c) => ({
    characterId: c.id,
    characterName: c.name,
    amount: RENT_PER_PC_PER_MONTH,
    dueAt: rentDueAt,
  }));

  // Meds projection — one bill per PLAYER, not per character. The band
  // comes from the highest chrome count across the player's PCs
  // (0-6=none, 7-9=medium, 10-12=high, 13+=extreme). "Weeks unpaid" is
  // the most recent checkup across all characters; household multiplier
  // scales the bill by +25% per extra billable character (chrome >= 7).
  // Calls the same helper the cyberware_humanity cron uses so the
  // displayed number is exactly what gets debited.
  // chromeCount is the per-character CWP TOTAL (sum of "CWP n" parsed from
  // each cyberware item's notes), not a row count. "Fully Organic" items
  // count as 0; un-tagged items fall back to 1 per piece. Bands (7-9
  // medium, 10-12 high, 13+ extreme) are defined in CWP, so a player with
  // 5 items totalling 10 CWP is correctly High, not None.
  const billableIds = billable.map((c) => c.id);
  const chromeCounts = await sumCwpByCharacter(billableIds);
  // Per-user checkup state. The portal stores characters.lastCheckupAt per
  // character, but the legacy bot (and current weekly cron) track checkups
  // PER USER — one ripperdoc visit on any character resets the streak for
  // every character that user owns. Trust botCyberwareStatus first (it's
  // the authoritative per-user mirror; weeks = weeks since last checkup,
  // lastProcessed = most recent weekly cron tick that touched this user).
  // Fall back to the max(lastCheckupAt) across the household only if no
  // per-user row exists — this is the case for brand-new portal users who
  // were never tracked by the bot.
  const charLastCheckup = billable.reduce<Date | null>((acc, c) => {
    if (!c.lastCheckupAt) return acc;
    if (!acc || c.lastCheckupAt > acc) return c.lastCheckupAt;
    return acc;
  }, null);
  const nextRunDate = nextWeeklyRunDate(now);
  const discordId = req.user!.discordId;
  const [botRow] = await db
    .select()
    .from(botCyberwareStatus)
    .where(eq(botCyberwareStatus.userId, discordId))
    .limit(1);
  // Try to resolve an exact checkup date from the bot's weekly_runs log
  // (each row's checkup_ids array lists the discord IDs that paid for a
  // checkup that week). If the user has a row in cyberware_status but no
  // matching run (older history), approximate as last_processed - weeks*7d
  // so the UI shows roughly when the streak started rather than "never".
  let lastCheckupAt: Date | null = charLastCheckup;
  let weeksUnpaid = weeksSinceLastCheckup(charLastCheckup, nextRunDate);
  if (botRow) {
    weeksUnpaid = botRow.weeks ?? weeksUnpaid;
    // checkupIds is a jsonb array of discord-id strings. Use `?` (jsonb
    // top-level key/element containment) which is the explicit predicate
    // for "this array contains this string". Safer than scalar @> tricks.
    const [lastRun] = await db
      .select({ runAt: botCyberwareWeeklyRuns.runAt })
      .from(botCyberwareWeeklyRuns)
      .where(sql`${botCyberwareWeeklyRuns.checkupIds} ? ${discordId}`)
      .orderBy(desc(botCyberwareWeeklyRuns.runAt))
      .limit(1);
    if (lastRun?.runAt) {
      lastCheckupAt = lastRun.runAt;
    } else if (botRow.lastProcessed && (botRow.weeks ?? 0) >= 0) {
      const approx = new Date(botRow.lastProcessed.getTime() - (botRow.weeks ?? 0) * 7 * 86_400_000);
      lastCheckupAt = approx;
    }
    // Don't let charLastCheckup beat a fresher value from the bot mirror.
    if (charLastCheckup && (!lastCheckupAt || charLastCheckup > lastCheckupAt)) {
      lastCheckupAt = charLastCheckup;
    }
  }
  const maxChromeCount = billable.reduce((m, c) => Math.max(m, chromeCounts.get(c.id) ?? 0), 0);
  const household = billable.filter((c) => (chromeCounts.get(c.id) ?? 0) >= 7).length;
  // Anchor character = the one driving the band (highest chrome). Used so
  // the UI can link back to a relevant character page.
  let anchor: { id: number; name: string } | null = null;
  let anchorMax = -1;
  for (const c of billable) {
    const n = chromeCounts.get(c.id) ?? 0;
    if (n > anchorMax) {
      anchorMax = n;
      anchor = { id: c.id, name: c.name };
    }
  }

  const proj = projectedWeeklyMeds({ chromeCount: maxChromeCount, household, weeksUnpaid });
  const meds: Array<{
    anchorCharacterId: number | null;
    anchorCharacterName: string | null;
    maxChromeCount: number;
    level: string;
    weeksUnpaid: number;
    household: number;
    multiplier: number;
    baseCharge: number;
    amount: number;
    dueAt: string;
  }> = [];
  if (proj.charge > 0) {
    meds.push({
      anchorCharacterId: anchor?.id ?? null,
      anchorCharacterName: anchor?.name ?? null,
      maxChromeCount,
      level: proj.level,
      weeksUnpaid: proj.weeksUnpaid,
      household: proj.household,
      multiplier: Number(proj.multiplier.toFixed(2)),
      baseCharge: proj.baseCharge,
      amount: proj.charge,
      dueAt: medsDueAt,
    });
  }
  const lastCheckupAtIso = lastCheckupAt ? lastCheckupAt.toISOString() : null;

  // Active leases (informational — automated rent currently charges the flat
  // RENT_PER_PC_PER_MONTH per PC; per-lease billing is not yet wired up).
  const charIds = myChars.map((c) => c.id);
  const leases = charIds.length === 0 ? [] : await db
    .select({
      id: housing.id,
      characterId: housing.characterId,
      characterName: characters.name,
      address: housing.address,
      monthlyRent: housing.monthlyRent,
      paidThrough: housing.paidThrough,
    })
    .from(housing)
    .innerJoin(characters, eq(characters.id, housing.characterId))
    .where(inArray(housing.characterId, charIds));

  const nextRentTotal = rent.reduce((s, r) => s + r.amount, 0);
  const nextMedsTotal = meds.reduce((s, m) => s + m.amount, 0);
  // Rough monthly estimate = next rent + (weekly meds * ~4.33 weeks).
  const monthlyEstimate = nextRentTotal + Math.round(nextMedsTotal * 4.33);

  // Report the same effective week count the meds calculation actually used
  // (projectedWeeklyMeds floors at 1). Otherwise we end up displaying
  // "0 weeks unpaid · €$X meds owed" right after a checkup, which looks
  // contradictory even though the math is correct.
  const reportedWeeksUnpaid = proj.weeksUnpaid;

  // Per-character chrome breakdown for the dashboard tooltip. Includes
  // every billable PC that has at least one piece of chrome, so the
  // player can see exactly which characters are driving their household
  // band and bill (Corpse with 7 vs. Korra with 5, etc.). Sorted hi→lo.
  const breakdown = billable
    .map((c) => {
      const count = chromeCounts.get(c.id) ?? 0;
      return {
        characterId: c.id,
        characterName: c.name,
        chromeCount: count,
        band: deriveCyberwareBand(count).level,
      };
    })
    .filter((r) => r.chromeCount > 0)
    .sort((a, b) => b.chromeCount - a.chromeCount);
  // topBand = the band the household is currently being billed at (derived
  // from maxChromeCount). This is the same value used by projectedWeeklyMeds.
  const topBand = deriveCyberwareBand(maxChromeCount).level;

  res.json({
    rent,
    meds,
    cyberwareStatus: {
      lastCheckupAt: lastCheckupAtIso,
      weeksUnpaid: reportedWeeksUnpaid,
      household,
      multiplier: Number(((household <= 1) ? 1 : (1 + 0.25 * (household - 1))).toFixed(2)),
      topBand,
      breakdown,
    },
    leases: leases.map((l) => ({
      ...l,
      paidThrough: l.paidThrough ? l.paidThrough.toISOString() : null,
    })),
    totals: {
      nextRent: nextRentTotal,
      nextMedsWeekly: nextMedsTotal,
      monthlyEstimate,
    },
  });
});

router.get("/dashboard/activity", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(activityEvents).orderBy(desc(activityEvents.createdAt)).limit(20);
  res.json(rows);
});

// Per-user activity feed for the home dashboard SYSTEM_LOGS card.
// - ADMIN and FIXER see the global audit_log (most recent N rows).
// - Everyone else sees rows where they are the actor OR the target is one
//   of their characters. Keeps players' personal feed actually personal
//   without exposing other players' wallet/sheet activity.
router.get("/me/system-log", requireAuth, async (req, res): Promise<void> => {
  const limit = Math.min(50, parseInt(String(req.query.limit ?? "15"), 10) || 15);
  const u = req.user!;
  const staff = hasRole(u.roles, "ADMIN") || hasRole(u.roles, "FIXER");
  if (staff) {
    const rows = await db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
    res.json(rows);
    return;
  }
  const myChars = await db
    .select({ id: characters.id })
    .from(characters)
    .where(eq(characters.ownerId, u.id));
  const charIdStrs = myChars.map((c) => String(c.id));
  const conds: ReturnType<typeof eq>[] = [eq(auditLog.actorId, u.id)];
  if (charIdStrs.length > 0) {
    conds.push(
      and(
        eq(auditLog.targetType, "character"),
        inArray(auditLog.targetId, charIdStrs),
      ) as ReturnType<typeof eq>,
    );
  }
  const rows = await db
    .select()
    .from(auditLog)
    .where(or(...conds))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  res.json(rows);
});

// Per-user wallet — eddies live on the Discord account via Unbelievaboat,
// not per-character. UI should prefer these over the per-character endpoints.
router.get("/me/wallet", requireAuth, async (req, res): Promise<void> => {
  const ub = await getBalance(req.user!.discordId);
  if (!ub) {
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  res.json({ balance: ub.total, cash: ub.cash, bank: ub.bank, source: "unbelievaboat" });
});

router.get("/me/wallet/transactions", requireAuth, async (req, res): Promise<void> => {
  const myChars = await db
    .select({ id: characters.id })
    .from(characters)
    .where(eq(characters.ownerId, req.user!.id));
  const charIds = myChars.map((c) => c.id);
  const conditions = [eq(walletTransactions.userId, req.user!.id)];
  if (charIds.length > 0) conditions.push(inArray(walletTransactions.characterId, charIds));
  const rows = await db
    .select()
    .from(walletTransactions)
    .where(or(...conditions))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(100);
  res.json(rows);
});

export default router;
