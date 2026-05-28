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
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { getBalance } from "../lib/unbelievaboat";
import { hasRole } from "../lib/discord";
import { projectedWeeklyMeds } from "../lib/jobs";

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

  // Meds projection. The cyberware_humanity cron does NOT count chrome HL —
  // it charges purely off the ripperdoc-assigned cyberwareLevel + the
  // checkup streak counter. So the dashboard's projected weekly meds must
  // come from that same formula or we'd be lying about what gets debited
  // on the next Monday tick.
  //
  // Chrome COUNT, on the other hand, comes from the portal's inventory_items
  // table (category='cyberware'). The user might own chrome in their
  // inventory but still have cyberwareLevel='none' if they haven't seen a
  // ripperdoc — that's a real game state, not "no chrome on file".
  const billableIds = billable.map((c) => c.id);
  const chromeCountsRaw = billableIds.length === 0 ? [] : await db
    .select({
      characterId: inventoryItems.characterId,
      count: sql<number>`count(*)::int`,
    })
    .from(inventoryItems)
    .where(and(inArray(inventoryItems.characterId, billableIds), eq(inventoryItems.category, "cyberware")))
    .groupBy(inventoryItems.characterId);
  const chromeCounts = new Map<number, number>();
  for (const r of chromeCountsRaw) {
    if (r.characterId != null) chromeCounts.set(r.characterId, r.count);
  }

  const meds: Array<{
    characterId: number;
    characterName: string;
    chromeCount: number;
    level: string;
    nextStreak: number;
    amount: number;
    dueAt: string;
  }> = [];
  // Characters that have chrome installed in inventory but no risk band
  // assigned yet — surfaced in the UI as a hint so "no meds owed" doesn't
  // look like the system failed to see their chrome.
  const unbilledChrome: Array<{ characterId: number; characterName: string; chromeCount: number; reason: string }> = [];

  for (const c of billable) {
    const chromeCount = chromeCounts.get(c.id) ?? 0;
    const proj = projectedWeeklyMeds(c.cyberwareLevel, c.checkupStreak ?? 0);
    if (proj.charge > 0) {
      meds.push({
        characterId: c.id,
        characterName: c.name,
        chromeCount,
        level: proj.level,
        nextStreak: proj.nextStreak,
        amount: proj.charge,
        dueAt: medsDueAt,
      });
    } else if (chromeCount > 0) {
      unbilledChrome.push({
        characterId: c.id,
        characterName: c.name,
        chromeCount,
        reason: "No risk band assigned — visit a ripperdoc to start cyberpsychosis tracking",
      });
    }
  }

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

  res.json({
    rent,
    meds,
    unbilledChrome,
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
