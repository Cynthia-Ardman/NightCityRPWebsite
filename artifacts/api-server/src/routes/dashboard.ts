import { Router, type IRouter } from "express";
import { eq, desc, and, or, sql, inArray } from "drizzle-orm";
import {
  db,
  characters,
  characterStatus,
  characterSheets,
  reviewVotes,
  activityEvents,
  auditLog,
  fixerNpcs,
  users,
  housing,
  walletTransactions,
  inventoryItems,
  botCyberwareStatus,
  botCyberwareWeeklyRuns,
  botBalanceHistory,
  botRentPaymentEvents,
  stores,
  ripperdocs,
  classifyWalletCategory,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { getBalance } from "../lib/unbelievaboat";
import { hasRole } from "../lib/discord";
import { isReviewer } from "../lib/review";
import { projectedWeeklyMeds, weeksSinceLastCheckup, deriveCyberwareBand } from "../lib/jobs";
import { sumCwpByCharacter } from "../lib/cyberware";

// Baseline living cost the monthly_rent cron debits ONCE per player
// (regardless of how many PCs they have). Per-lease housing rent is
// listed separately in the Active Leases section. Keep this in sync
// with DEFAULT_BASELINE_LIVING_COST in lib/jobs.ts.
const BASELINE_LIVING_COST_PER_PLAYER = 500;

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
  // Pending character sheets that THIS viewer can actually action. The count
  // must mirror the review queue's semantics, not a raw global tally, on TWO
  // axes:
  //   1. A reviewer cannot vote on their OWN submission (canVote = !isOwner),
  //      so own pending sheets are excluded. IS DISTINCT FROM treats a null
  //      owner as "not me" so unowned sheets still surface.
  //   2. A reviewer who has ALREADY cast a vote has nothing left to do on that
  //      sheet — it sits below the majority threshold awaiting OTHER reviewers.
  //      Counting it would leave the viewer staring at "1 pending sheet" right
  //      after they clicked Approve, with nothing for them to action when they
  //      click through. Excluding already-voted sheets mirrors the Pending
  //      Requests card (which uses the unseen/actionable count) and keeps the
  //      badge honest.
  let pending = 0;
  if (isReviewer(req.user!)) {
    const [{ c }] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(characterSheets)
      .where(
        and(
          eq(characterSheets.status, "pending"),
          sql`${characterSheets.ownerId} IS DISTINCT FROM ${req.user!.id}`,
          sql`NOT EXISTS (SELECT 1 FROM ${reviewVotes} WHERE ${reviewVotes.subjectType} = 'sheet' AND ${reviewVotes.subjectId} = ${characterSheets.id} AND ${reviewVotes.voterId} = ${req.user!.id})`,
        ),
      );
    pending = c;
  }
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

  // Baseline living cost = ONE charge per player (not per character),
  // matching the monthly_rent cron's per-owner baseline pass. Players
  // with 0 approved PCs owe nothing here.
  const rent = billable.length === 0 ? [] : [{
    characterId: billable[0].id,
    characterName: "Flat household fee",
    amount: BASELINE_LIVING_COST_PER_PLAYER,
    dueAt: rentDueAt,
  }];

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
  // A character's creation counts as an implicit initial checkup — a
  // brand-new chromed PC shouldn't be treated as if they'd skipped checkups
  // for the weeks before they existed (which would jump them straight to the
  // max streak). Effective date is the real last checkup, or creation if none.
  const charLastCheckup = billable.reduce<Date | null>((acc, c) => {
    const eff = c.lastCheckupAt ?? c.createdAt;
    if (!eff) return acc;
    if (!acc || eff > acc) return eff;
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

  // Suppress meds entirely if the player had a checkup within the
  // current billing week. The bot mirror tracks this as weeks=0
  // (just had one); we ALSO fall back to a 7-day window on
  // lastCheckupAt for portal-only users that aren't in the bot
  // mirror yet. Without this guard, projectedWeeklyMeds floors
  // weeksUnpaid at 1 and charges a full week's bill the same day
  // you visit a ripperdoc — which the player rightfully reads as a bug.
  const sevenDaysMs = 7 * 86_400_000;
  const checkupIsCurrent =
    (botRow && (botRow.weeks ?? 0) <= 0) ||
    (!!lastCheckupAt && (now.getTime() - lastCheckupAt.getTime()) < sevenDaysMs);
  const proj = checkupIsCurrent
    ? { charge: 0, level: deriveCyberwareBand(maxChromeCount).level, cap: 0, baseCharge: 0, multiplier: 1, weeksUnpaid: 0, household }
    : projectedWeeklyMeds({ chromeCount: maxChromeCount, household, weeksUnpaid });
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

  // "Next Rent" at the top of the dashboard is everything that will hit
  // the wallet on the 1st: the baseline living cost PLUS every per-lease
  // monthly_rent. Players were confused when a $3,000 apartment didn't
  // show up in the headline total even though it shows up in their bill.
  const leasesRentTotal = leases.reduce((s, l) => s + (l.monthlyRent ?? 0), 0);
  const nextRentTotal = rent.reduce((s, r) => s + r.amount, 0) + leasesRentTotal;
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
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(eq(characters.ownerId, req.user!.id));
  const charIds = myChars.map((c) => c.id);
  const myCharNameById = new Map(myChars.map((c) => [c.id, c.name]));
  const conditions = [eq(walletTransactions.userId, req.user!.id)];
  if (charIds.length > 0) conditions.push(inArray(walletTransactions.characterId, charIds));
  const rows = await db
    .select()
    .from(walletTransactions)
    .where(or(...conditions))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(100);

  // Resolve counterparty character names for player-to-player transfers so the
  // ledger can link straight to that character's detail page. The counterparty
  // is usually not one of this player's own characters, so look them up.
  const counterpartyCharIds = [
    ...new Set(rows.map((r) => r.counterpartyCharacterId).filter((v): v is number => v != null)),
  ];
  const counterpartyCharRows = counterpartyCharIds.length
    ? await db
        .select({ id: characters.id, name: characters.name })
        .from(characters)
        .where(inArray(characters.id, counterpartyCharIds))
    : ([] as { id: number; name: string }[]);
  const counterpartyCharNameById = new Map(counterpartyCharRows.map((c) => [c.id, c.name]));

  // Resolve counterparty venue names for transactions that reference a
  // store/ripperdoc (store_deposit, ripperdoc_withdraw, etc) so the ledger
  // can link straight to that venue's detail page.
  const txStoreIds = [...new Set(rows.map((r) => r.storeId).filter((v): v is number => v != null))];
  const txRipperIds = [...new Set(rows.map((r) => r.ripperdocId).filter((v): v is number => v != null))];
  const [txStoreRows, txRipperRows] = await Promise.all([
    txStoreIds.length
      ? db.select({ id: stores.id, name: stores.name }).from(stores).where(inArray(stores.id, txStoreIds))
      : Promise.resolve([] as { id: number; name: string }[]),
    txRipperIds.length
      ? db.select({ id: ripperdocs.id, name: ripperdocs.name }).from(ripperdocs).where(inArray(ripperdocs.id, txRipperIds))
      : Promise.resolve([] as { id: number; name: string }[]),
  ]);
  const storeNameById = new Map(txStoreRows.map((s) => [s.id, s.name]));
  const ripperNameById = new Map(txRipperRows.map((r) => [r.id, r.name]));

  res.json(
    rows.map((r) => {
      const counterpartyVenueKind = r.storeId != null ? "store" : r.ripperdocId != null ? "ripperdoc" : null;
      const counterpartyVenueId = r.storeId ?? r.ripperdocId ?? null;
      const counterpartyVenueName =
        r.storeId != null
          ? storeNameById.get(r.storeId) ?? null
          : r.ripperdocId != null
            ? ripperNameById.get(r.ripperdocId) ?? null
            : null;
      return {
        ...r,
        category: r.category ?? classifyWalletCategory(r.kind, r.memo),
        characterName: r.characterId != null ? myCharNameById.get(r.characterId) ?? null : null,
        counterpartyCharacterName:
          r.counterpartyCharacterId != null
            ? counterpartyCharNameById.get(r.counterpartyCharacterId) ?? null
            : null,
        counterpartyVenueKind,
        counterpartyVenueId,
        counterpartyVenueName,
      };
    }),
  );
});

// Account-level cyberware MEDS history for the signed-in player. The bot
// charged cyberware meds PER DISCORD USER (not per character), so this is an
// account-wide view. Same merge strategy as rent (two complementary sources):
//   - bot_balance_history ledger: the authoritative recent source (~2026-05
//     onward) carrying the real weekly amount the player paid.
//   - bot_rent_payment_events (kind='cyberware_meds'): the FULL year of older
//     confirmed deductions, imported from the bot's operator DM sweep logs
//     (~1,500 rows back to 2025-07) plus a few #rent-payments channel lines.
//     This is the only surviving complete record for the pre-ledger period.
// Channel/DM rows strictly before this user's first ledger meds charge are merged
// in to avoid double-counting the overlap (the ledger owns the recent weeks).
// Each entry surfaces the week label + amount paid. Read-only — powers the
// "MEDS HISTORY" dialog.
router.get("/me/cyberware-history", requireAuth, async (req, res): Promise<void> => {
  const discordId = req.user!.discordId;

  const [ledgerRows, channelRows] = await Promise.all([
    db
      .select()
      .from(botBalanceHistory)
      .where(
        and(
          eq(botBalanceHistory.userId, discordId),
          sql`${botBalanceHistory.reason} ILIKE 'Cyberware meds%'`,
        ),
      )
      .orderBy(desc(botBalanceHistory.ts))
      .limit(500),
    db
      .select()
      .from(botRentPaymentEvents)
      .where(
        and(
          eq(botRentPaymentEvents.userId, discordId),
          eq(botRentPaymentEvents.kind, "cyberware_meds"),
        ),
      )
      .orderBy(desc(botRentPaymentEvents.ts))
      .limit(500),
  ]);

  // Boundary = this user's earliest ledger meds charge; channel rows at/after it
  // are superseded by the ledger and dropped to avoid double-counting.
  const boundary = ledgerRows.length
    ? Math.min(...ledgerRows.map((r) => new Date(r.ts).getTime()))
    : Infinity;

  const ledgerEntries = ledgerRows.map((r) => {
    const at = new Date(r.ts);
    return {
      source: "bot" as const,
      date: at.toISOString().slice(0, 10),
      at: at.toISOString(),
      // Ledger deltas are already negative for debits.
      amount: (r.cashDelta ?? 0) + (r.bankDelta ?? 0),
      label: r.reason ?? "Cyberware meds",
    };
  });

  const channelEntries = channelRows
    .filter((r) => new Date(r.ts).getTime() < boundary)
    .map((r) => {
      const at = new Date(r.ts);
      return {
        source: "bot" as const,
        date: at.toISOString().slice(0, 10),
        at: at.toISOString(),
        amount: -(r.amount ?? 0),
        label: r.label,
      };
    });

  const entries = [...ledgerEntries, ...channelEntries]
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, 500);

  res.json({
    totalCount: entries.length,
    portalCount: 0,
    botCount: entries.length,
    entries,
  });
});

// Map a legacy ledger rent reason to a friendly label. The ledger uses
// "flat monthly fee" for what the channel calls "Baseline living cost".
function ledgerRentLabel(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("flat monthly fee")) return "Baseline living cost";
  if (r.includes("housing rent")) return "Housing Rent";
  if (r.includes("business rent")) return "Business Rent";
  if (r.includes("xanadu gold membership")) return "Xanadu Gold membership";
  if (r.includes("trauma team subscription")) return "Trauma Team";
  return reason;
}

// Account-level RENT history for the signed-in player. The bot charged rent
// PER DISCORD USER (not per character), so this is account-wide. Two
// complementary legacy sources, merged so neither double-counts a charge:
//   - bot_balance_history ledger: authoritative + fully itemized (it is the
//     only source for Trauma Team subscription and the cleanest for the most
//     recent month), but its coverage only starts ~2026-05.
//   - #rent-payments channel (bot_rent_payment_events): a full year of itemized
//     "paid: $N" confirmations that predate the ledger, but missing some bill
//     types (e.g. Trauma Team) and with patchy baseline/membership coverage.
// We use the ledger for the window it covers and the channel for everything
// strictly BEFORE this user's first ledger rent charge. Amounts are returned
// signed negative (money charged) so the dialog renders them as outflows.
// Read-only — powers the "RENT HISTORY" dialog.
router.get("/me/rent-history", requireAuth, async (req, res): Promise<void> => {
  const discordId = req.user!.discordId;

  // Rent-style ledger reasons (excludes cyberware meds — that has its own view).
  const RENT_REASON_RE =
    "(flat monthly fee|housing rent|business rent|xanadu gold membership|trauma team subscription)";

  const [channelRows, ledgerRows] = await Promise.all([
    db
      .select()
      .from(botRentPaymentEvents)
      .where(
        and(
          eq(botRentPaymentEvents.userId, discordId),
          inArray(botRentPaymentEvents.kind, [
            "baseline",
            "housing_rent",
            "business_rent",
            "membership",
            "trauma_team",
          ]),
        ),
      )
      .orderBy(desc(botRentPaymentEvents.ts))
      .limit(500),
    db
      .select()
      .from(botBalanceHistory)
      .where(
        and(
          eq(botBalanceHistory.userId, discordId),
          sql`${botBalanceHistory.reason} ~* ${RENT_REASON_RE}`,
        ),
      )
      .orderBy(desc(botBalanceHistory.ts))
      .limit(500),
  ]);

  // Boundary = this user's earliest ledger rent charge. Channel rows at or after
  // it are superseded by the (richer) ledger and dropped to avoid double-counting.
  const boundary = ledgerRows.length
    ? Math.min(...ledgerRows.map((r) => new Date(r.ts).getTime()))
    : Infinity;

  const ledgerEntries = ledgerRows.map((r) => {
    const at = new Date(r.ts);
    return {
      source: "bot" as const,
      date: at.toISOString().slice(0, 10),
      at: at.toISOString(),
      // Ledger deltas are already negative for debits.
      amount: (r.cashDelta ?? 0) + (r.bankDelta ?? 0),
      label: ledgerRentLabel(r.reason ?? "Rent"),
    };
  });

  const channelEntries = channelRows
    .filter((r) => new Date(r.ts).getTime() < boundary)
    .map((r) => {
      const at = new Date(r.ts);
      return {
        source: "bot" as const,
        date: at.toISOString().slice(0, 10),
        at: at.toISOString(),
        amount: -(r.amount ?? 0),
        label: r.label,
      };
    });

  const entries = [...ledgerEntries, ...channelEntries]
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, 500);

  res.json({
    totalCount: entries.length,
    portalCount: 0,
    botCount: entries.length,
    entries,
  });
});

// Account-level financial history for the signed-in player, from the imported
// bot transaction ledger (bot_balance_history). Every cash/bank delta the bot
// applied, with its free-text reason (rent, cyberware meds, attendance reward,
// actor pay, mission payout, purchases, etc.). Keyed by Discord id, so this is
// account-wide. Read-only — powers the "FINANCIAL HISTORY" dialog. Bot ledger
// coverage starts ~2026-05.
router.get("/me/financial-history", requireAuth, async (req, res): Promise<void> => {
  const discordId = req.user!.discordId;
  const rows = await db
    .select()
    .from(botBalanceHistory)
    .where(eq(botBalanceHistory.userId, discordId))
    .orderBy(desc(botBalanceHistory.ts))
    .limit(500);

  const entries = rows.map((r) => {
    const at = new Date(r.ts);
    return {
      source: "bot" as const,
      date: at.toISOString().slice(0, 10),
      at: at.toISOString(),
      amount: (r.cashDelta ?? 0) + (r.bankDelta ?? 0),
      label: r.reason ?? null,
    };
  });

  res.json({
    totalCount: entries.length,
    portalCount: 0,
    botCount: entries.length,
    entries,
  });
});

export default router;
