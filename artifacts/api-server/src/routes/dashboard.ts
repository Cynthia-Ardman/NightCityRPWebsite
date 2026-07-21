import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, and, or, sql, inArray, notInArray } from "drizzle-orm";
import {
  db,
  characters,
  characterStatus,
  activityEvents,
  auditLog,
  fixerNpcs,
  users,
  housing,
  walletTransactions,
  inventoryItems,
  botBalanceHistory,
  botRentPaymentEvents,
  botCyberwareWeeklyRuns,
  stores,
  ripperdocs,
  classifyWalletCategory,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { recordSettledWalletMovement } from "../lib/economy";
import { logger } from "../lib/logger";
import { hasRole } from "../lib/discord";
import { projectedWeeklyMeds, weeksSinceLastCheckup, deriveCyberwareBand, countsForCyberwareBilling } from "../lib/jobs";
import { sumCwpByCharacter } from "../lib/cyberware";
import {
  DEFAULT_BASELINE_LIVING_COST,
  DEFAULT_XANADU_GOLD_COST,
  readConfigNumber,
  readTraumaCosts,
} from "../lib/billingConfig";

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
  const ub = await getBalance(req.user!.discordId, { allowStale: true });
  const totalEddies = ub?.total ?? 0;
  // NOTE: the dashboard's "Sheets to Review" / "Requests to Review" cards are
  // driven entirely by GET /review/unseen-counts (the same source as the
  // sidebar "Pending" badge), NOT by this summary. The summary deliberately
  // does NOT compute a pending-sheets tally — a second, divergent count here
  // is what produced the recurring phantom "Sheets to Review: N with nothing
  // new" bug (it counted unvoted sheets the reviewer had already seen).
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
    topFixers,
    recentArrivals,
  });
});

router.get("/dashboard/upcoming-bills", requireAuth, async (req, res): Promise<void> => {
  const ownerId = req.user!.id;
  const myChars = await db.select().from(characters).where(eq(characters.ownerId, ownerId));
  const billable = myChars.filter((c) => c.kind === "pc" && c.approved && !c.archived);
  // Cyberware household = billable PCs MINUS anyone on LOA / retired / dead.
  // Switching a character to one of those statuses immediately removes them
  // from the household multiplier AND the meds projection below. Rent, trauma
  // and baseline fees keep using the full `billable` set above.
  const cyberBillable = billable.filter(countsForCyberwareBilling);

  const now = new Date();
  const rentDueAt = nextMonthlyRunDate(now).toISOString();
  const medsDueAt = nextWeeklyRunDate(now).toISOString();

  // Fee config is read from bot_config (same source as the monthly_rent cron)
  // so the projection reflects any admin override, not a hardcoded default.
  const baselineCost = await readConfigNumber("baseline_living_cost", DEFAULT_BASELINE_LIVING_COST);
  const xanaduCost = await readConfigNumber("xanadu_gold_cost", DEFAULT_XANADU_GOLD_COST);
  const traumaCosts = await readTraumaCosts();

  // Baseline living cost = ONE charge per player (not per character),
  // matching the monthly_rent cron's per-owner baseline pass. Players
  // with 0 approved PCs owe nothing here.
  const rent: Array<{ characterId: number; characterName: string; amount: number; dueAt: string }> =
    billable.length === 0 || baselineCost <= 0
      ? []
      : [{ characterId: billable[0].id, characterName: "Cost of Living", amount: baselineCost, dueAt: rentDueAt }];

  // Trauma Team + Xanadu Gold are billed PER PC by the monthly_rent cron, so
  // include them here too — previously the projection omitted them entirely and
  // under-reported the player's actual next bill.
  for (const c of billable) {
    const tier = (c.traumaTeamTier ?? "").toLowerCase();
    const traumaCost = tier ? (traumaCosts[tier] ?? 0) : 0;
    if (tier && traumaCost > 0) {
      rent.push({
        characterId: c.id,
        characterName: `Trauma Team ${tier} — ${c.name}`,
        amount: traumaCost,
        dueAt: rentDueAt,
      });
    }
    if (c.xanaduGold && xanaduCost > 0) {
      rent.push({
        characterId: c.id,
        characterName: `Xanadu Gold — ${c.name}`,
        amount: xanaduCost,
        dueAt: rentDueAt,
      });
    }
  }

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
  const billableIds = cyberBillable.map((c) => c.id);
  const chromeCounts = await sumCwpByCharacter(billableIds);
  // Checkup state. Checkups are HOUSEHOLD-scoped: one ripperdoc visit on any
  // character resets the streak for every character that player owns. The
  // weekly cyberware_humanity cron charges money strictly off
  // characters.lastCheckupAt (falling back to createdAt as an implicit
  // initial checkup), reduced to the most recent date across the household.
  // We derive this projection from that exact same source so the displayed
  // bill always equals what the cron will actually debit.
  //
  // bot_cyberware_status is a stale legacy per-user mirror (the weeks-since-
  // checkup the bot computed at its last tick). It is deliberately NOT
  // consulted here: trusting its cached `weeks` would let an out-of-date,
  // higher count override the authoritative checkup date and nag the player
  // with a projected charge the cron will never make once their real
  // lastCheckupAt is current.
  //
  // A character's creation counts as an implicit initial checkup — a
  // brand-new chromed PC shouldn't be treated as if they'd skipped checkups
  // for the weeks before they existed (which would jump them straight to the
  // max streak). Effective date is the real last checkup, or creation if none.
  const charLastCheckup = cyberBillable.reduce<Date | null>((acc, c) => {
    const eff = c.lastCheckupAt ?? c.createdAt;
    if (!eff) return acc;
    if (!acc || eff > acc) return eff;
    return acc;
  }, null);
  const nextRunDate = nextWeeklyRunDate(now);
  const lastCheckupAt: Date | null = charLastCheckup;
  const weeksUnpaid = weeksSinceLastCheckup(charLastCheckup, nextRunDate);
  const maxChromeCount = cyberBillable.reduce((m, c) => Math.max(m, chromeCounts.get(c.id) ?? 0), 0);
  const household = cyberBillable.filter((c) => (chromeCounts.get(c.id) ?? 0) >= 7).length;
  // Anchor character = the one driving the band (highest chrome). Used so
  // the UI can link back to a relevant character page.
  let anchor: { id: number; name: string } | null = null;
  let anchorMax = -1;
  for (const c of cyberBillable) {
    const n = chromeCounts.get(c.id) ?? 0;
    if (n > anchorMax) {
      anchorMax = n;
      anchor = { id: c.id, name: c.name };
    }
  }

  // Suppress meds entirely if the household had a checkup within the
  // current billing week. weeksSinceLastCheckup() floors at 1, so without
  // this guard projectedWeeklyMeds would charge a full week's bill the same
  // day you visit a ripperdoc — which the player rightfully reads as a bug.
  // This mirrors the cyberware_humanity cron's own 7-day guard exactly, off
  // the same authoritative effective checkup date.
  const sevenDaysMs = 7 * 86_400_000;
  const checkupIsCurrent =
    !!lastCheckupAt && (now.getTime() - lastCheckupAt.getTime()) < sevenDaysMs;
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

  // Actual most-recent checkup VISIT across the household, from the audit
  // trail. Under the temporary checkup-reset-floor event, lastCheckupAt is
  // backdated so billing stays capped at week N — display surfaces show the
  // real visit date instead so players don't think their checkup was lost.
  // Billing math above deliberately keeps using the effective date.
  const allCharIds = myChars.map((c) => c.id);
  let lastCheckupActualAt: Date | null = lastCheckupAt;
  if (allCharIds.length > 0) {
    const [visit] = await db
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "character"),
          inArray(auditLog.targetId, allCharIds.map(String)),
          eq(auditLog.action, "checkup"),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    if (visit?.createdAt && (!lastCheckupActualAt || visit.createdAt > lastCheckupActualAt)) {
      lastCheckupActualAt = visit.createdAt;
    }
  }

  // Active leases. Per-lease monthly_rent IS billed by the cron (see jobs.ts
  // lease billing) and is summed into the headline "Next Rent" total below.
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
  const breakdown = cyberBillable
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
      lastCheckupActualAt: lastCheckupActualAt ? lastCheckupActualAt.toISOString() : null,
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
  const ub = await getBalance(req.user!.discordId, { allowStale: true });
  if (!ub) {
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  res.json({ balance: ub.total, cash: ub.cash, bank: ub.bank, source: ub.source });
});

// Move eddies between the caller's UnbelievaBoat bank and cash ("on person").
// Transfers can only spend cash, so players with most of their money in the
// bank need to withdraw first. Both directions share this handler: a withdrawal
// is bank -> cash, a deposit is cash -> bank. The total never changes — this is
// a purely internal move — so the ledger row we record is net-zero (amount 0)
// purely to carry the idempotency key; these rows are filtered out of the
// ledger display (they'd read as misleading "+0" in/out entries). UB is
// authoritative: we require a live balance read before writing and reject when
// the source side can't cover the amount.
//
// Idempotency mirrors the transfer path: a client may pass a key (a UUID
// generated once per submit) so a retry / double-click can't run the bank<->cash
// move twice. If we've already settled this exact key, return the current
// balance without touching UB again.
//
// NOTE: UB writes only fire in the deployed environment (externalWritesAllowed),
// so in dev patchBalance returns null and this responds 502 by design.
const BANK_MOVE_KINDS = ["bank_withdraw", "bank_deposit"] as const;

async function handleWalletMove(
  req: Request,
  res: Response,
  dir: "withdraw" | "deposit",
): Promise<void> {
  const amount = Number((req.body ?? {}).amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    res.status(400).json({ error: "A positive whole amount is required" });
    return;
  }
  const rawKey = (req.body ?? {}).idempotencyKey;
  const moveKey =
    typeof rawKey === "string" && rawKey.trim()
      ? `bank-move:${rawKey.trim().slice(0, 80)}`
      : null;
  // Durable dedup BEFORE any UB write: if this exact key already settled, return
  // the current balance instead of moving money again.
  if (moveKey) {
    const [done] = await db
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.idempotencyKey, moveKey), eq(walletTransactions.syncStatus, "synced")));
    if (done) {
      const cur = await getBalance(req.user!.discordId, { allowStale: true });
      res.json({
        balance: cur?.total ?? 0,
        cash: cur?.cash ?? 0,
        bank: cur?.bank ?? 0,
        source: cur?.source ?? "unbelievaboat",
      });
      return;
    }
  }
  // UB is the source of truth — never move money off a stale local figure.
  const bal = await getBalance(req.user!.discordId);
  if (!bal) {
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  if (dir === "withdraw" && bal.bank < amount) {
    res.status(400).json({
      error: `Not enough in the bank. You have ${bal.bank.toLocaleString()} €$ in the bank but tried to withdraw ${amount.toLocaleString()} €$.`,
    });
    return;
  }
  if (dir === "deposit" && bal.cash < amount) {
    res.status(400).json({
      error: `Not enough cash on hand. You have ${bal.cash.toLocaleString()} €$ in cash but tried to deposit ${amount.toLocaleString()} €$.`,
    });
    return;
  }
  const delta =
    dir === "withdraw"
      ? { cash: amount, bank: -amount, reason: "Withdraw from bank (portal)" }
      : { cash: -amount, bank: amount, reason: "Deposit to bank (portal)" };
  const moved = await patchBalance(req.user!.discordId, delta);
  if (!moved) {
    logger.warn(
      { discordUserId: req.user!.discordId, dir, amount },
      "wallet move failed: UB patch returned null",
    );
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  // Record a net-zero ledger row carrying the idempotency key so a retry that
  // races past the pre-check above can't double-move (onConflictDoNothing on the
  // key). amount 0 means the user's mirrored walletBalance is unchanged; total
  // is unchanged so reconcile won't drift. Hidden from the ledger display.
  if (moveKey) {
    await recordSettledWalletMovement({
      userId: req.user!.id,
      amount: 0,
      ubTotalAfter: moved.total,
      source: "website",
      kind: dir === "withdraw" ? "bank_withdraw" : "bank_deposit",
      memo: dir === "withdraw" ? `Withdrew ${amount} from bank` : `Deposited ${amount} to bank`,
      idempotencyKey: moveKey,
    });
  }
  res.json({ balance: moved.total, cash: moved.cash, bank: moved.bank, source: moved.source });
}

router.post("/me/wallet/withdraw", requireAuth, (req, res) => handleWalletMove(req, res, "withdraw"));
router.post("/me/wallet/deposit", requireAuth, (req, res) => handleWalletMove(req, res, "deposit"));

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
    // Hide net-zero bank<->cash move rows (they only exist to carry an
    // idempotency key; the total never changed so they'd read as a "+0" entry).
    .where(and(or(...conditions), notInArray(walletTransactions.kind, [...BANK_MOVE_KINDS])))
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

  // Characters owned by this player. Meds are billed per-PLAYER, but portal
  // checkups are logged per-character in the audit log, so we resolve owned PCs
  // once to gather their checkup rows and label them by character name.
  const ownedChars = await db
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(eq(characters.ownerId, req.user!.id));
  const ownedCharIds = ownedChars.map((c) => c.id);
  const charNameById = new Map(ownedChars.map((c) => [c.id, c.name]));

  const [ledgerRows, channelRows, portalMedsRows, botRunRows, portalCheckupRows] =
    await Promise.all([
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
      // Portal-native weekly meds (the cyberware cron writes kind='meds'). The
      // legacy importer also copied the bot ledger into wallet_transactions as
      // kind='historical' / category='cyberware'; those are EXCLUDED here because
      // botBalanceHistory above already carries them — including both double-counts.
      db
        .select()
        .from(walletTransactions)
        .where(
          and(
            eq(walletTransactions.userId, discordId),
            eq(walletTransactions.kind, "meds"),
          ),
        )
        .orderBy(desc(walletTransactions.createdAt))
        .limit(500),
      // Bot-era checkups: one weekly-run row per sweep listing the Discord ids
      // that had a checkup that week. Read every run this player appears in.
      db
        .select()
        .from(botCyberwareWeeklyRuns)
        .where(sql`${botCyberwareWeeklyRuns.checkupIds} @> ${JSON.stringify([discordId])}::jsonb`)
        .orderBy(desc(botCyberwareWeeklyRuns.runAt))
        .limit(500),
      // Portal-era checkups: audit rows the ripperdoc-checkup endpoint writes
      // (one per visit) for any character this player owns.
      ownedCharIds.length
        ? db
            .select()
            .from(auditLog)
            .where(
              and(
                eq(auditLog.targetType, "character"),
                eq(auditLog.action, "checkup"),
                inArray(auditLog.targetId, ownedCharIds.map(String)),
              ),
            )
            .orderBy(desc(auditLog.createdAt))
            .limit(500)
        : Promise.resolve([] as (typeof auditLog.$inferSelect)[]),
    ]);

  // Boundary = this user's earliest ledger meds charge; channel rows at/after it
  // are superseded by the ledger and dropped to avoid double-counting.
  const boundary = ledgerRows.length
    ? Math.min(...ledgerRows.map((r) => new Date(r.ts).getTime()))
    : Infinity;

  type HistEntry = {
    source: "bot" | "portal";
    type: "meds" | "checkup";
    date: string;
    at: string;
    amount: number | null;
    label: string;
  };

  const ledgerEntries: HistEntry[] = ledgerRows.map((r) => {
    const at = new Date(r.ts);
    return {
      source: "bot",
      type: "meds",
      date: at.toISOString().slice(0, 10),
      at: at.toISOString(),
      // Ledger deltas are already negative for debits.
      amount: (r.cashDelta ?? 0) + (r.bankDelta ?? 0),
      label: r.reason ?? "Cyberware meds",
    };
  });

  const channelEntries: HistEntry[] = channelRows
    .filter((r) => new Date(r.ts).getTime() < boundary)
    .map((r) => {
      const at = new Date(r.ts);
      return {
        source: "bot",
        type: "meds",
        date: at.toISOString().slice(0, 10),
        at: at.toISOString(),
        amount: -(r.amount ?? 0),
        label: r.label,
      };
    });

  // Portal meds. Only kind='meds' rows reach here — the legacy importer mirrored
  // the bot ledger into wallet_transactions as kind='historical' (already filtered
  // out by the query), and the bot never writes wallet_transactions, so these are
  // exclusively portal-native charges that never duplicate the bot ledger. We keep
  // a cheap memo guard against any stray legacy-tagged row but do NOT suppress by
  // day, which would wrongly hide a genuine portal charge landing on a bot day.
  const portalEntries: HistEntry[] = portalMedsRows
    .filter((r) => !(r.memo ?? "").includes("[legacy-bal:"))
    .map((r) => {
      const at = r.createdAt ?? new Date();
      return {
        source: "portal",
        type: "meds",
        date: at.toISOString().slice(0, 10),
        at: at.toISOString(),
        amount: r.amount,
        label: r.memo ?? "Weekly cyberware meds",
      };
    });

  // Checkups carry no money (amount null) so the dialog renders them as plain
  // dated markers showing which weeks a checkup happened.
  const botCheckupEntries: HistEntry[] = botRunRows.map((r) => {
    const at = new Date(r.runAt);
    return {
      source: "bot",
      type: "checkup",
      date: at.toISOString().slice(0, 10),
      at: at.toISOString(),
      amount: null,
      label: "Ripperdoc checkup",
    };
  });

  const portalCheckupEntries: HistEntry[] = portalCheckupRows.map((r) => {
    const at = r.createdAt ?? new Date();
    const name = charNameById.get(Number(r.targetId));
    return {
      source: "portal",
      type: "checkup",
      date: at.toISOString().slice(0, 10),
      at: at.toISOString(),
      amount: null,
      label: name ? `Ripperdoc checkup — ${name}` : "Ripperdoc checkup",
    };
  });

  const entries = [
    ...ledgerEntries,
    ...channelEntries,
    ...portalEntries,
    ...botCheckupEntries,
    ...portalCheckupEntries,
  ]
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, 500);

  const botCount = entries.filter((e) => e.source === "bot").length;
  const portalCount = entries.filter((e) => e.source === "portal").length;

  res.json({
    totalCount: entries.length,
    portalCount,
    botCount,
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

  const [channelRows, ledgerRows, portalRows] = await Promise.all([
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
    // Portal-native rent-style charges written by the monthly billing cron.
    // kind='historical' importer mirrors of the bot ledger are excluded by the
    // kind filter (botBalanceHistory above already carries those rows).
    db
      .select()
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.userId, discordId),
          inArray(walletTransactions.kind, [
            "rent",
            "business_rent",
            "baseline",
            "trauma_team",
            "xanadu_gold",
          ]),
        ),
      )
      .orderBy(desc(walletTransactions.createdAt))
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

  // Portal charges never duplicate the bot sources (the bot never writes
  // wallet_transactions and importer mirrors use kind='historical', filtered
  // out above); keep the cheap memo guard against any stray legacy-tagged row.
  const portalEntries = portalRows
    .filter((r) => !(r.memo ?? "").includes("[legacy-bal:"))
    .map((r) => {
      const at = r.createdAt ?? new Date();
      return {
        source: "portal" as const,
        date: at.toISOString().slice(0, 10),
        at: at.toISOString(),
        amount: r.amount,
        label: r.memo ?? ledgerRentLabel(r.kind),
      };
    });

  const entries = [...ledgerEntries, ...channelEntries, ...portalEntries]
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, 500);

  const botCount = entries.filter((e) => e.source === "bot").length;

  res.json({
    totalCount: entries.length,
    portalCount: entries.length - botCount,
    botCount,
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
  const [rows, portalRows] = await Promise.all([
    db
      .select()
      .from(botBalanceHistory)
      .where(eq(botBalanceHistory.userId, discordId))
      .orderBy(desc(botBalanceHistory.ts))
      .limit(500),
    // Portal-native wallet movement (crons, purchases, transfers, payouts…).
    // kind='historical' rows are the importer's mirror of the bot ledger above,
    // so they're excluded to avoid double-counting.
    db
      .select()
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.userId, discordId),
          sql`${walletTransactions.kind} <> 'historical'`,
        ),
      )
      .orderBy(desc(walletTransactions.createdAt))
      .limit(500),
  ]);

  const botEntries = rows.map((r) => {
    const at = new Date(r.ts);
    return {
      source: "bot" as const,
      date: at.toISOString().slice(0, 10),
      at: at.toISOString(),
      amount: (r.cashDelta ?? 0) + (r.bankDelta ?? 0),
      label: r.reason ?? null,
    };
  });

  const portalEntries = portalRows
    .filter((r) => !(r.memo ?? "").includes("[legacy-bal:"))
    .map((r) => {
      const at = r.createdAt ?? new Date();
      return {
        source: "portal" as const,
        date: at.toISOString().slice(0, 10),
        at: at.toISOString(),
        amount: r.amount,
        label: r.memo ?? r.kind,
      };
    });

  const entries = [...botEntries, ...portalEntries]
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, 500);

  const botCount = entries.filter((e) => e.source === "bot").length;

  res.json({
    totalCount: entries.length,
    portalCount: entries.length - botCount,
    botCount,
    entries,
  });
});

export default router;
