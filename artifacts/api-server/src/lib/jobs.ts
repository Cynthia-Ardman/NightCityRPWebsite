import { db, users, jobRuns, characters, characterStatus, walletTransactions, housing, activityEvents, botConfig, shopOpens, inventoryItems, stores, ripperdocs } from "@workspace/db";
import { eq, and, desc, sql, isNotNull, gte, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { fetchGuildMemberRolesViaBot, fetchGuildMemberRoleIdsViaBot, VERIFIED_18_ROLE_ID, postToChannel } from "./discord";
import { patchBalance } from "./unbelievaboat";
import { sumCwpByCharacter } from "./cyberware";
import { runMissionAutoPay, runMissionNpcAnnouncements } from "./missionsService";
import { reconcileDiscordEvents } from "./eventsService";
import { isSystemLive, type LiveSystem } from "./liveMode";
import { runEconomyReconcile, getEconomyMode } from "./economy";

const EVICTION_CHANNEL_ID = process.env.EVICTION_CHANNEL_ID ?? "";
const HOUSING_GRACE_DAYS = Number(process.env.HOUSING_GRACE_DAYS ?? 7);

// Default monthly costs used when the corresponding bot_config row is missing
// or malformed. Admins override these by writing to bot_config; the cron
// always falls back here so a fresh deploy is internally consistent.
const DEFAULT_BASELINE_LIVING_COST = 500;
const DEFAULT_XANADU_GOLD_COST = 500;
// Aligned with NightCityBot's trauma_team_costs config: 1k / 2k / 4k / 10k.
// Admins can still override these by writing to bot_config["trauma_team_costs"];
// these defaults are what a fresh deploy or a malformed config row falls back to.
const DEFAULT_TRAUMA_TEAM_COSTS: Record<string, number> = {
  silver: 1000,
  gold: 2000,
  platinum: 4000,
  diamond: 10000,
};

// Cyberware meds caps by ripperdoc-assigned risk band. Matches the bot's
// medium/high/extreme role tiers. The weekly charge for a non-"none"
// character is (cap/128) * 2^(streak-1), clamped to the cap — meaning the
// charge starts trivial and doubles each missed checkup until it hits the
// ceiling at streak 8.
// Cyberware risk band is now auto-derived from how many cyberware pieces a
// character has installed (inventory_items where category='cyberware'). No
// ripperdoc certification step required — the band is a function of chrome
// count and the weekly cap is keyed off the band:
//   0-6  pieces → none    (no charge, body can metabolize the load)
//   7-9         → medium  (cap €2000/wk)
//  10-12        → high    (cap €5000/wk)
//  13+         → extreme (cap €10000/wk)
export const CYBERWARE_BANDS: ReadonlyArray<{ min: number; max: number; level: string; cap: number }> = [
  { min: 0, max: 6, level: "none", cap: 0 },
  { min: 7, max: 9, level: "medium", cap: 2000 },
  { min: 10, max: 12, level: "high", cap: 5000 },
  { min: 13, max: Number.POSITIVE_INFINITY, level: "extreme", cap: 10000 },
];

export function deriveCyberwareBand(chromeCount: number): { level: string; cap: number } {
  const n = Math.max(0, Math.floor(chromeCount));
  const band = CYBERWARE_BANDS.find((b) => n >= b.min && n <= b.max);
  return band ? { level: band.level, cap: band.cap } : { level: "none", cap: 0 };
}

// Household multiplier on the weekly meds bill. More characters under the
// same Discord account = +25% per extra billable character (2 → 1.25x,
// 3 → 1.5x, 4 → 1.75x …). "Billable" = approved, non-archived PCs that
// actually own chrome (>=7 pieces — chars below the threshold don't owe
// meds anyway so they don't count toward the household risk).
export function householdMultiplier(billableCharCount: number): number {
  if (billableCharCount <= 1) return 1;
  return 1 + 0.25 * (billableCharCount - 1);
}

// Cap on how many weeks of skipped checkups the formula will compound.
// At streak 8 the doubling already hits the cap; anything beyond is just
// a safety bound on Math.pow.
export const CYBERWARE_MAX_STREAK = 12;

// Weeks since the last ripperdoc checkup, projected forward to a given
// cron tick (defaults to "right now"). Returns 1 if a checkup just
// happened (first tick after a checkup is week 1). Capped at
// CYBERWARE_MAX_STREAK; null lastCheckupAt means "never had one" → max.
export function weeksSinceLastCheckup(lastCheckupAt: Date | null | undefined, runAt: Date = new Date()): number {
  if (!lastCheckupAt) return CYBERWARE_MAX_STREAK;
  const ms = runAt.getTime() - lastCheckupAt.getTime();
  if (ms <= 0) return 1;
  const weeks = Math.floor(ms / (7 * 86400000)) + 1;
  return Math.max(1, Math.min(CYBERWARE_MAX_STREAK, weeks));
}

// Weekly cyberpsychosis-meds charge for a PLAYER (one bill per Discord
// account, not per character). `chromeCount` is the highest chrome count
// across any of the player's approved PCs — that drives the band — and
// `household` is the count of their PCs that own chrome (>=7 pieces).
// Both the cron and the dashboard call this so the displayed number is
// exactly what gets debited.
//
// formula: floor((cap/128) * 2^(weeksUnpaid - 1)) * householdMultiplier,
// clamped at the cap BEFORE the multiplier (so household scaling can push
// past the band cap, which is intentional — more chrome under one roof
// = more risk).
export function projectedWeeklyMeds(opts: {
  chromeCount: number;
  household: number;
  weeksUnpaid: number;
}): {
  charge: number;
  level: string;
  cap: number;
  baseCharge: number;
  multiplier: number;
  weeksUnpaid: number;
  household: number;
} {
  const weeksUnpaid = Math.max(1, Math.min(CYBERWARE_MAX_STREAK, opts.weeksUnpaid));
  const { level, cap } = deriveCyberwareBand(opts.chromeCount);
  const multiplier = householdMultiplier(opts.household);
  if (cap <= 0) {
    return { charge: 0, level, cap, baseCharge: 0, multiplier, weeksUnpaid, household: opts.household };
  }
  const base = cap / 128;
  const baseCharge = Math.min(Math.floor(base * Math.pow(2, weeksUnpaid - 1)), cap);
  const charge = Math.floor(baseCharge * multiplier);
  return { charge, level, cap, baseCharge, multiplier, weeksUnpaid, household: opts.household };
}

// Passive-income table for opened businesses.
//   T0 (tier 0 / micro): flat eddies by # of opens this month.
//   T1+ (everything else): rent × multiplier.
// Bot caps payout at 4 opens / month; opens beyond 4 don't increase income.
const SHOP_T0_PAYOUTS = [0, 150, 250, 350, 500]; // index = opens (0..4)
const SHOP_TIER_PLUS_MULT = [0, 0.25, 0.4, 0.6, 0.8]; // index = opens (0..4)
const SHOP_OPENS_CAP = 4;

// Best-effort tier detection from a housing.address / catalogRent.tier label.
// Bot uses an explicit tier on the catalog row; here we keep it permissive:
// anything that looks like tier 0 / micro / micro-business uses the T0 flat
// schedule, everything else uses the rent-multiplier schedule.
function isShopTierZero(addr: string, leaseKind: string): boolean {
  if (leaseKind !== "business") return false;
  return /\bT?0\b|micro/i.test(addr);
}

async function readConfigNumber(key: string, fallback: number): Promise<number> {
  try {
    const [row] = await db.select().from(botConfig).where(eq(botConfig.key, key));
    const v = row?.value;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
    return fallback;
  } catch (err) {
    logger.warn({ err, key }, "readConfigNumber failed; using fallback");
    return fallback;
  }
}

async function readTraumaCosts(): Promise<Record<string, number>> {
  try {
    const [row] = await db.select().from(botConfig).where(eq(botConfig.key, "trauma_team_costs"));
    const v = row?.value;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, number> = { ...DEFAULT_TRAUMA_TEAM_COSTS };
      for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
        if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
          out[k.toLowerCase()] = Math.floor(raw);
        }
      }
      return out;
    }
    return { ...DEFAULT_TRAUMA_TEAM_COSTS };
  } catch (err) {
    logger.warn({ err }, "readTraumaCosts failed; using defaults");
    return { ...DEFAULT_TRAUMA_TEAM_COSTS };
  }
}

// Kill-switch flags stored in bot_config. Both default to OFF so freshly
// deployed environments never silently start charging players until an
// admin explicitly flips the switch in the System Flags / Jobs UI.
//   - housing_autobill_enabled gates the monthly_rent cron (housing
//     leases + lifestyle cycle, which fire together).
//   - cyberware_autobill_enabled gates the cyberware_humanity cron.
// Manual /admin/jobs/run is intentionally NOT gated — admin pressing
// the button is an explicit action and is the supported way to test
// while the cron is disabled.
export const AUTOBILL_FLAGS = {
  housing: "housing_autobill_enabled",
  cyberware: "cyberware_autobill_enabled",
  missionAutopay: "mission_autopay_enabled",
} as const;

export async function isAutobillEnabled(key: string): Promise<boolean> {
  try {
    const [row] = await db.select().from(botConfig).where(eq(botConfig.key, key));
    // Treat the column as a JSON value; only the literal `true` enables the
    // job. Anything else (missing row, false, null, "", numbers, strings)
    // keeps the switch off — fail-safe.
    return row?.value === true;
  } catch (err) {
    logger.warn({ err, key }, "isAutobillEnabled read failed; treating as OFF");
    return false;
  }
}

// Reserve-before-debit for a single personal fee (lifestyle, baseline, trauma
// team, xanadu gold). Writes the ledger row and flips the caller's in-memory
// "already billed this run" guard BEFORE the external UB debit. If the process
// dies after UB succeeds but before the run finishes, the committed ledger row
// trips the period guard on a manual rerun — so the player is never
// double-charged. On a clean UB failure (UB returns null, i.e. NOT a crash) we
// delete the reservation and undo the in-memory guard so a later run can retry.
// Returns true iff the debit succeeded. See
// .agents/memory/autobill-parity.md ("Known crash-window race").
async function chargePersonalFeeWithReservation(opts: {
  characterId: number | null;
  userId: string;
  discordId: string;
  cost: number;
  kind: string;
  memo: string;
  reason: string;
  reserve: () => void;
  unreserve: () => void;
}): Promise<boolean> {
  const [row] = await db
    .insert(walletTransactions)
    .values({
      characterId: opts.characterId,
      userId: opts.userId,
      amount: -opts.cost,
      kind: opts.kind,
      memo: opts.memo,
    })
    .returning({ id: walletTransactions.id });
  opts.reserve();
  const ub = await patchBalance(opts.discordId, { cash: -opts.cost, reason: opts.reason });
  if (!ub) {
    await db.delete(walletTransactions).where(eq(walletTransactions.id, row.id));
    opts.unreserve();
    return false;
  }
  return true;
}

export type JobName = "cyberware_humanity" | "monthly_rent" | "role_sync" | "eviction_sweep" | "mission_autopay" | "mission_npc_announce" | "economy_reconcile" | "discord_event_sync";

export async function runJob(name: JobName): Promise<{ id: number; status: string; affectedCount: number }> {
  const [run] = await db.insert(jobRuns).values({ job: name, status: "running" }).returning();
  let affected = 0;
  let status = "succeeded";
  let message: string | null = null;
  try {
    // Site-wide Test/Live gate. The money-moving + destructive jobs perform NO
    // live effects (no UnbelievaBoat debits, no Discord posts, no lease deletes)
    // unless BOTH the master switch and the job's own system are Live. This
    // applies to manual /admin/jobs/run too, so admins can safely trigger a job
    // without touching real data. mission_autopay is intentionally NOT listed:
    // its internal payment path already simulates + records in Test mode.
    const liveSystemByJob: Partial<Record<JobName, LiveSystem>> = {
      monthly_rent: "housing",
      cyberware_humanity: "cyberware",
      eviction_sweep: "evictions",
      // discord_event_sync is intentionally NOT listed: its website-side writes
      // (importing Discord events, pulling Discord edits, mirroring deletes) are
      // non-destructive and must run in Test mode too, so admins can import the
      // existing schedule without flipping Live. Only its Discord-side mutations
      // are gated, via the `live` flag passed to reconcileDiscordEvents below.
    };
    const gatedSystem = liveSystemByJob[name];
    if (gatedSystem && !(await isSystemLive(gatedSystem))) {
      message = `Test mode: ${name} made no live changes. Set the master switch AND ${gatedSystem} to Live to run for real.`;
      logger.info({ job: name, system: gatedSystem }, "job skipped — Test mode (live gate)");
    } else if (name === "role_sync") {
      const allUsers = await db.select().from(users);
      for (const u of allUsers) {
        try {
          const roles = await fetchGuildMemberRolesViaBot(u.discordId);
          // Recompute the 18+ gate flag from raw role ids so removing the
          // Verified-18 role in Discord actually revokes portal access on the
          // next sweep. Only touch verified18 when the fetch succeeds (non-null)
          // so a transient Discord failure never silently clears the gate.
          const roleIds = await fetchGuildMemberRoleIdsViaBot(u.discordId);
          const verified18 = roleIds === null ? u.verified18 : roleIds.includes(VERIFIED_18_ROLE_ID);
          if (roles.length || roleIds !== null) {
            await db
              .update(users)
              .set({ ...(roles.length ? { roles } : {}), verified18, rolesSyncedAt: new Date() })
              .where(eq(users.id, u.id));
            affected++;
          }
        } catch (err) {
          logger.warn({ err, userId: u.id }, "role sync user failed");
        }
      }
    } else if (name === "monthly_rent") {
      // Build an LOA lookup once so every billing pass below can ask
      // "is this character on LOA?" without a per-row roundtrip. We treat
      // a missing status row as "not on LOA" — same as the bot's default.
      const statusRows = await db.select().from(characterStatus);
      const loaByCharacter = new Map<number, boolean>();
      for (const s of statusRows) loaByCharacter.set(s.characterId, !!s.loa);
      const isOnLoa = (cid: number) => loaByCharacter.get(cid) === true;

      // Resolve and cache owner rows so we do at most one users-row read per
      // distinct owner across all six billing passes below.
      const ownerCache = new Map<string, typeof users.$inferSelect | null>();
      const getOwner = async (ownerId: string | null | undefined) => {
        if (!ownerId) return null;
        if (ownerCache.has(ownerId)) return ownerCache.get(ownerId) ?? null;
        const [row] = await db.select().from(users).where(eq(users.id, ownerId));
        ownerCache.set(ownerId, row ?? null);
        return row ?? null;
      };

      // ----- 1+2. Housing leases (residential AND business) -----------------
      // Per-lease billing: iterate active housing rows joined to their
      // approved, non-archived characters. UB is authoritative — record the
      // local ledger entry and roll paid_through forward only when the debit
      // succeeds. On UB failure leave paid_through where it is so the lease
      // shows as delinquent in upcoming-bills until next run.
      //
      // LOA rule (matches NightCityBot): residential leases pause while the
      // character is on LOA; business leases bill regardless because the
      // venue keeps operating.
      const rows = await db
        .select({
          lease: housing,
          character: characters,
        })
        .from(housing)
        .innerJoin(characters, eq(characters.id, housing.characterId))
        .where(and(eq(characters.archived, false)));
      const now = new Date();

      // Idempotency guard for personal-fee passes (lifestyle, baseline,
      // trauma_team, xanadu_gold): pull every wallet_transactions row in the
      // tracked kinds written this calendar month (UTC), then build a Set of
      // "charId:kind" pairs already billed. Each pass below consults the set
      // before debiting so a manual rerun in the same month is a no-op.
      // Housing leases use their own rolling paid_through guard instead.
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      // Include `shop_income` in the preload so a rerun after a rent debit
      // failure (which leaves paid_through unchanged) cannot re-credit the
      // monthly shop payout. Credits are still keyed by characterId only —
      // a character only ever owns one shop lease at a time in practice,
      // and the per-character cap matches the bot.
      const TRACKED_PERSONAL_KINDS = ["lifestyle", "baseline", "trauma_team", "xanadu_gold", "shop_income"] as const;
      const alreadyBilled = new Set<string>();
      const existingBills = await db
        .select({ characterId: walletTransactions.characterId, kind: walletTransactions.kind })
        .from(walletTransactions)
        .where(and(
          inArray(walletTransactions.kind, TRACKED_PERSONAL_KINDS as unknown as string[]),
          gte(walletTransactions.createdAt, periodStart),
        ));
      for (const e of existingBills) {
        if (e.characterId != null) alreadyBilled.add(`${e.characterId}:${e.kind}`);
      }
      const billedThisRun = (cid: number, kind: string) => alreadyBilled.has(`${cid}:${kind}`);
      const markBilled = (cid: number, kind: string) => alreadyBilled.add(`${cid}:${kind}`);
      const unmarkBilled = (cid: number, kind: string) => alreadyBilled.delete(`${cid}:${kind}`);

      for (const { lease, character: c } of rows) {
        if (!c.approved) continue;
        if (!c.ownerId) continue;
        const isBusiness = lease.kind === "business";
        if (!isBusiness && isOnLoa(c.id)) continue;
        // Idempotency: if this lease is already paid past now (rolling
        // paid_through), skip. Manual rerun within the same period must not
        // double-charge.
        if (lease.paidThrough && lease.paidThrough.getTime() > now.getTime()) continue;
        const owner = await getOwner(c.ownerId);
        if (!owner) continue;
        const rent = lease.monthlyRent;
        if (rent <= 0) continue;
        const reasonLabel = isBusiness ? "Business rent" : "Rent";

        // ----- 2a. Passive income for businesses -----------------------------
        // Credit BEFORE the rent debit so a profitable shop can fund its own
        // rent. The income amount is driven by how many days the owner
        // pressed OPEN SHOP during the period (capped at SHOP_OPENS_CAP).
        // T0 (micro) leases use a flat schedule; everything else uses a
        // rent-multiplier curve. Skipped silently on UB failure — we'd
        // rather lose passive income than corrupt the rent flow.
        if (isBusiness && !billedThisRun(c.id, "shop_income")) {
          const opensThisMonth = await db
            .select({ n: sql<number>`count(*)` })
            .from(shopOpens)
            .where(and(eq(shopOpens.characterId, c.id), gte(shopOpens.openedAt, periodStart)));
          const opens = Math.min(Number(opensThisMonth[0]?.n ?? 0), SHOP_OPENS_CAP);
          let income = 0;
          if (opens > 0) {
            income = isShopTierZero(lease.address, lease.kind)
              ? SHOP_T0_PAYOUTS[opens]
              : Math.floor(rent * SHOP_TIER_PLUS_MULT[opens]);
          }
          if (income > 0) {
            // Crash-window guard (credit-side mirror of the rent/personal-fee
            // debits): RESERVE the 'shop_income' ledger row + flip the period
            // marker BEFORE the external UB credit. If the process dies after
            // the credit succeeds but before we can finish, the reservation is
            // already committed, so a manual rerun in the same period sees the
            // row (preloaded into `alreadyBilled`) and skips — no double credit.
            // The trade-off is a recoverable under-payment if UB never actually
            // ran; we roll the reservation back below on a clean UB failure.
            // See .agents/memory/autobill-parity.md ("Crash-window race").
            const incomeMemo = `Shop income: ${lease.address} (${opens} day${opens === 1 ? "" : "s"})`;
            const [reservedIncome] = await db
              .insert(walletTransactions)
              .values({
                characterId: c.id,
                userId: c.ownerId,
                amount: income,
                kind: "shop_income",
                memo: incomeMemo,
              })
              .returning({ id: walletTransactions.id });
            markBilled(c.id, "shop_income");

            const ubCredit = await patchBalance(owner.discordId, {
              cash: income,
              reason: incomeMemo,
            });
            if (ubCredit) {
              affected++;
            } else {
              // Clean UB failure (not a crash): roll the reservation back so a
              // later run can retry the payout.
              await db.delete(walletTransactions).where(eq(walletTransactions.id, reservedIncome.id));
              unmarkBilled(c.id, "shop_income");
              logger.warn(
                { characterId: c.id, leaseId: lease.id, income },
                "monthly_rent shop_income UB credit failed; rolled back ledger reservation",
              );
            }
          }
        }

        // Crash-window guard: RESERVE the idempotency markers (ledger row +
        // paid_through bump) BEFORE the external UB debit. If the process dies
        // after UB succeeds but before we can finish, the reservation is
        // already committed, so a manual rerun in the same period sees
        // paid_through > now and skips — no double charge. The trade-off is a
        // recoverable under-charge if UB never actually ran (we roll the
        // reservation back below on a clean UB failure). See
        // .agents/memory/autobill-parity.md ("Known crash-window race").
        //
        // Bump paid_through forward by one month from its previous value (or
        // from now if it was missing/stale), preserving anchor date when
        // possible so leases stay on a consistent monthly cadence.
        const base = lease.paidThrough && lease.paidThrough.getTime() > Date.now() - 86400000
          ? new Date(lease.paidThrough)
          : new Date();
        base.setUTCMonth(base.getUTCMonth() + 1);
        const [reservedRent] = await db
          .insert(walletTransactions)
          .values({
            characterId: c.id,
            amount: -rent,
            kind: isBusiness ? "business_rent" : "rent",
            memo: `${reasonLabel}: ${lease.address}`,
          })
          .returning({ id: walletTransactions.id });
        await db
          .update(housing)
          .set({ paidThrough: base })
          .where(eq(housing.id, lease.id));

        const ub = await patchBalance(owner.discordId, {
          cash: -rent,
          reason: `${reasonLabel}: ${lease.address}`,
        });
        if (!ub) {
          // Clean UB failure (not a crash): roll the reservation back so the
          // lease isn't shown as paid and the next run can retry the debit.
          await db.delete(walletTransactions).where(eq(walletTransactions.id, reservedRent.id));
          await db
            .update(housing)
            .set({ paidThrough: lease.paidThrough ?? null })
            .where(eq(housing.id, lease.id));
          logger.warn(
            { characterId: c.id, leaseId: lease.id, kind: lease.kind },
            "monthly_rent UB debit failed; lease will show delinquent",
          );
          // Stamp the lease as delinquent on the FIRST failed cycle only —
          // subsequent failures preserve the original timestamp so the
          // eviction grace clock counts from the first miss, not the most
          // recent retry.
          if (!lease.delinquentSince) {
            await db
              .update(housing)
              .set({ delinquentSince: new Date() })
              .where(eq(housing.id, lease.id));
            await db.insert(activityEvents).values({
              kind: "housing_delinquent",
              actorId: c.ownerId,
              message: `${c.name} could not pay rent on ${lease.address} (€$${rent})`,
            });
          }
          continue;
        }
        // Clear delinquentSince on every successful debit — a paid month
        // resets the eviction clock, even if the lease had previously
        // entered the grace period.
        if (lease.delinquentSince) {
          await db
            .update(housing)
            .set({ delinquentSince: null })
            .where(eq(housing.id, lease.id));
        }
        affected++;
      }

      // ----- 2b. Passive income for venue-only shop owners -------------------
      // Store / ripperdoc owners don't necessarily hold a `business` housing
      // lease, but they're still "shop owners" and the OPEN SHOP button is
      // available to them. They have no rent base, so they earn the flat
      // Tier-0 schedule (SHOP_T0_PAYOUTS) driven purely by how many days they
      // pressed OPEN SHOP this period. Characters that DO hold a business
      // lease are intentionally excluded here — they were already paid (often
      // more) in the lease pass above, and the shared `alreadyBilled` /
      // `shop_income` guard prevents any double credit.
      const businessLeaseCharIds = new Set<number>();
      for (const { lease, character: c } of rows) {
        if (lease.kind === "business") businessLeaseCharIds.add(c.id);
      }
      const [storeOwners, clinicOwners] = await Promise.all([
        db.select({ cid: stores.ownerCharacterId, name: stores.name }).from(stores).where(isNotNull(stores.ownerCharacterId)),
        db.select({ cid: ripperdocs.ownerCharacterId, name: ripperdocs.name }).from(ripperdocs).where(isNotNull(ripperdocs.ownerCharacterId)),
      ]);
      const venueNameByChar = new Map<number, string>();
      for (const v of [...storeOwners, ...clinicOwners]) {
        if (v.cid == null) continue;
        if (businessLeaseCharIds.has(v.cid)) continue;
        if (!venueNameByChar.has(v.cid)) venueNameByChar.set(v.cid, v.name);
      }
      if (venueNameByChar.size > 0) {
        const venueChars = await db
          .select()
          .from(characters)
          .where(and(
            inArray(characters.id, [...venueNameByChar.keys()]),
            eq(characters.approved, true),
            eq(characters.archived, false),
          ));
        for (const c of venueChars) {
          if (!c.ownerId) continue;
          if (billedThisRun(c.id, "shop_income")) continue;
          const owner = await getOwner(c.ownerId);
          if (!owner) continue;
          const opensThisMonth = await db
            .select({ n: sql<number>`count(*)` })
            .from(shopOpens)
            .where(and(eq(shopOpens.characterId, c.id), gte(shopOpens.openedAt, periodStart)));
          const opens = Math.min(Number(opensThisMonth[0]?.n ?? 0), SHOP_OPENS_CAP);
          if (opens <= 0) continue;
          const income = SHOP_T0_PAYOUTS[opens];
          if (income <= 0) continue;
          const shopName = venueNameByChar.get(c.id) ?? `${c.name}'s shop`;
          // Same crash-window reservation as the business pass: RESERVE the
          // ledger row + period marker BEFORE the external UB credit so a
          // rerun can't double-pay; roll back only on a clean UB failure.
          const incomeMemo = `Shop income: ${shopName} (${opens} day${opens === 1 ? "" : "s"})`;
          const [reservedIncome] = await db
            .insert(walletTransactions)
            .values({
              characterId: c.id,
              userId: c.ownerId,
              amount: income,
              kind: "shop_income",
              memo: incomeMemo,
            })
            .returning({ id: walletTransactions.id });
          markBilled(c.id, "shop_income");
          const ubCredit = await patchBalance(owner.discordId, {
            cash: income,
            reason: incomeMemo,
          });
          if (ubCredit) {
            affected++;
          } else {
            await db.delete(walletTransactions).where(eq(walletTransactions.id, reservedIncome.id));
            unmarkBilled(c.id, "shop_income");
            logger.warn(
              { characterId: c.id, income },
              "monthly_rent venue shop_income UB credit failed; rolled back ledger reservation",
            );
          }
        }
      }

      // ----- 3. Lifestyle (REMOVED) -----------------------------------------
      // Lifestyle tiers were retired pre-launch: cost-of-living is now a flat
      // $500 baseline (billed in the Baseline step below). The tier table and
      // characters.lifestyleTierId column are intentionally kept for historical
      // data, but no per-tier lifestyle debits are issued anymore.

      // ----- 4+5+6. Baseline / Trauma Team / Xanadu Gold ---------------------
      // These three personal fees all iterate the same set: approved PCs that
      // are claimed (have an ownerId), not archived, and not on LOA. Costs
      // come from bot_config with sensible defaults so the cron is internally
      // consistent on a fresh deploy. UB is authoritative for each — skip the
      // ledger row on debit failure.
      const baselineCost = await readConfigNumber("baseline_living_cost", DEFAULT_BASELINE_LIVING_COST);
      const xanaduCost = await readConfigNumber("xanadu_gold_cost", DEFAULT_XANADU_GOLD_COST);
      const traumaCosts = await readTraumaCosts();

      const personalChars = await db
        .select()
        .from(characters)
        .where(and(
          eq(characters.kind, "pc"),
          eq(characters.approved, true),
          eq(characters.archived, false),
          isNotNull(characters.ownerId),
        ));

      // Baseline living cost is billed ONCE PER PLAYER, not per PC.
      // Track which owners have already been billed this run so a player
      // with multiple PCs only pays $500 total. Idempotency for reruns
      // within the same month uses the same per-owner key, persisted via
      // wallet_transactions (kind='baseline', characterId=NULL keyed off
      // userId only) — preloaded into baselineBilledOwners below.
      const baselineBilledOwners = new Set<string>();
      const existingBaselineByOwner = await db
        .select({ userId: walletTransactions.userId })
        .from(walletTransactions)
        .where(and(
          eq(walletTransactions.kind, "baseline"),
          gte(walletTransactions.createdAt, periodStart),
        ));
      for (const r of existingBaselineByOwner) {
        if (r.userId) baselineBilledOwners.add(r.userId);
      }

      for (const c of personalChars) {
        if (isOnLoa(c.id)) continue;
        if (!c.ownerId) continue; // narrowing — the SQL filter already guarantees this
        const owner = await getOwner(c.ownerId);
        if (!owner) continue;

        // 4. Baseline living cost (food, utilities, etc.) — ONE per player.
        if (baselineCost > 0 && !baselineBilledOwners.has(c.ownerId)) {
          const ok = await chargePersonalFeeWithReservation({
            characterId: null,
            userId: c.ownerId,
            discordId: owner.discordId,
            cost: baselineCost,
            kind: "baseline",
            memo: "Baseline living cost (monthly)",
            reason: `Baseline living cost`,
            reserve: () => baselineBilledOwners.add(c.ownerId!),
            unreserve: () => baselineBilledOwners.delete(c.ownerId!),
          });
          if (ok) {
            affected++;
          } else {
            logger.warn({ ownerId: c.ownerId }, "monthly_rent baseline UB debit failed");
          }
        }

        // 5. Trauma Team subscription
        const tier = (c.traumaTeamTier ?? "").toLowerCase();
        const traumaCost = tier ? (traumaCosts[tier] ?? 0) : 0;
        if (tier && traumaCost > 0 && !billedThisRun(c.id, "trauma_team")) {
          const ok = await chargePersonalFeeWithReservation({
            characterId: c.id,
            userId: c.ownerId,
            discordId: owner.discordId,
            cost: traumaCost,
            kind: "trauma_team",
            memo: `Trauma Team ${tier} subscription`,
            reason: `Trauma Team ${tier} (${c.name})`,
            reserve: () => markBilled(c.id, "trauma_team"),
            unreserve: () => unmarkBilled(c.id, "trauma_team"),
          });
          if (ok) {
            affected++;
          } else {
            logger.warn({ characterId: c.id, tier }, "monthly_rent trauma UB debit failed");
          }
        }

        // 6. Xanadu Gold premium membership
        if (c.xanaduGold && xanaduCost > 0 && !billedThisRun(c.id, "xanadu_gold")) {
          const ok = await chargePersonalFeeWithReservation({
            characterId: c.id,
            userId: c.ownerId,
            discordId: owner.discordId,
            cost: xanaduCost,
            kind: "xanadu_gold",
            memo: "Xanadu Gold membership",
            reason: `Xanadu Gold (${c.name})`,
            reserve: () => markBilled(c.id, "xanadu_gold"),
            unreserve: () => unmarkBilled(c.id, "xanadu_gold"),
          });
          if (ok) {
            affected++;
          } else {
            logger.warn({ characterId: c.id }, "monthly_rent xanadu UB debit failed");
          }
        }
      }
    } else if (name === "cyberware_humanity") {
      // Weekly cyberpsychosis-meds charge. The band is auto-derived from
      // each character's chrome count (inventory_items where
      // category='cyberware') — no ripperdoc certification required:
      //   0-6 → none, 7-9 → medium, 10-12 → high, 13+ → extreme.
      // The "weeks unpaid" counter is per-USER, computed from the most
      // recent ripperdoc checkup across ANY of the user's characters
      // (characters.lastCheckupAt). One checkup resets the streak for the
      // whole household. Cost per character:
      //   floor((cap/128) * 2^(weeksUnpaid - 1)) * householdMultiplier
      // where householdMultiplier = 1 + 0.25 * (billableCharCount - 1).
      // See projectedWeeklyMeds() — both this cron and the dashboard
      // projection call into the same helper so the displayed number is
      // exactly what gets debited.

      // Weekly idempotency: skip any character with a 'meds' debit in the
      // last 6 days so a manual rerun (or two cron ticks in the same week)
      // can't double-charge.
      const sixDaysAgo = new Date(Date.now() - 6 * 86400000);
      const recentMeds = await db
        .select({ characterId: walletTransactions.characterId })
        .from(walletTransactions)
        .where(and(eq(walletTransactions.kind, "meds"), gte(walletTransactions.createdAt, sixDaysAgo)));
      const recentMedsSet = new Set(recentMeds.map((r) => r.characterId));
      const approvedChars = await db
        .select()
        .from(characters)
        .where(and(eq(characters.kind, "pc"), eq(characters.approved, true), eq(characters.archived, false)));

      // Per-character CWP totals (sum of "CWP n" parsed from each
      // cyberware item's notes, not a row count). Bands (7/10/13) are
      // defined in CWP, so a single item worth 7 CWP can trigger meds
      // on its own while five 1-CWP trinkets total only 5.
      const approvedIds = approvedChars.map((c) => c.id);
      const chromeByChar = await sumCwpByCharacter(approvedIds);

      // Group chars by owner so we can compute the household multiplier
      // and the per-user "last checkup across all chars" streak.
      const charsByOwner = new Map<string, typeof approvedChars>();
      for (const c of approvedChars) {
        if (!c.ownerId) continue;
        const list = charsByOwner.get(c.ownerId) ?? [];
        list.push(c);
        charsByOwner.set(c.ownerId, list);
      }

      // One bill per PLAYER (not per character). We charge once at the
      // band derived from the player's highest-chrome character; the
      // household multiplier still scales it by +25% per extra billable
      // character so multi-PC players pay more in aggregate.
      const recentMedsByUser = await db
        .select({ userId: walletTransactions.userId })
        .from(walletTransactions)
        .where(and(
          eq(walletTransactions.kind, "meds"),
          gte(walletTransactions.createdAt, sixDaysAgo),
          isNotNull(walletTransactions.userId),
        ));
      const recentMedsUserSet = new Set(recentMedsByUser.map((r) => r.userId).filter((u): u is string => !!u));

      const now = new Date();
      for (const [ownerId, ownerChars] of charsByOwner) {
        if (recentMedsUserSet.has(ownerId)) continue; // already billed this week
        const maxChromeCount = ownerChars.reduce((m, c) => Math.max(m, chromeByChar.get(c.id) ?? 0), 0);
        if (maxChromeCount < 7) continue; // no PC has enough chrome to trigger any band
        const household = ownerChars.filter((c) => (chromeByChar.get(c.id) ?? 0) >= 7).length;
        // Per-user last checkup = most recent across the household. One
        // ripperdoc visit resets the streak for every character.
        const lastCheckupAt = ownerChars.reduce<Date | null>((acc, c) => {
          if (!c.lastCheckupAt) return acc;
          if (!acc || c.lastCheckupAt > acc) return c.lastCheckupAt;
          return acc;
        }, null);
        const weeksUnpaid = weeksSinceLastCheckup(lastCheckupAt, now);
        // Skip the bill entirely if the household had a ripperdoc checkup
        // inside the current billing week. weeksSinceLastCheckup() floors
        // at 1, so we re-check the raw 7-day window here — without this
        // guard a checkup the same day as the Monday cron tick would still
        // be charged as if a full week had elapsed.
        const checkupIsCurrent = !!lastCheckupAt
          && (now.getTime() - lastCheckupAt.getTime()) < 7 * 86_400_000;
        if (checkupIsCurrent) continue;
        const proj = projectedWeeklyMeds({ chromeCount: maxChromeCount, household, weeksUnpaid });
        if (proj.charge <= 0) continue;

        const [owner] = await db.select().from(users).where(eq(users.id, ownerId));
        if (!owner) continue;
        // Reserve-before-debit (mirrors chargePersonalFeeWithReservation):
        // write the idempotency guard — the 'meds' ledger row plus the
        // in-memory per-user weekly flag — BEFORE the external UB debit, and
        // roll it back ONLY on a clean UB failure (patchBalance returns null).
        // If the process crashes after the debit succeeds but before this
        // commit, the guard is already committed, so a rerun in the same week
        // skips this owner and can't double-charge. The trade-off is a
        // recoverable under-charge if UB never actually ran.
        const [medsRow] = await db
          .insert(walletTransactions)
          .values({
            userId: ownerId,
            characterId: null,
            amount: -proj.charge,
            kind: "meds",
            memo: `Weekly cyberpsychosis meds (${proj.level}, ${maxChromeCount} chrome, week ${weeksUnpaid}, household x${proj.multiplier.toFixed(2)})`,
          })
          .returning({ id: walletTransactions.id });
        recentMedsUserSet.add(ownerId);
        const ub = await patchBalance(owner.discordId, {
          cash: -proj.charge,
          reason: `Cyberpsychosis meds (${proj.level}, week ${weeksUnpaid}, household x${proj.multiplier.toFixed(2)})`,
        });
        if (!ub) {
          await db.delete(walletTransactions).where(eq(walletTransactions.id, medsRow.id));
          recentMedsUserSet.delete(ownerId);
          logger.warn({ ownerId }, "cyberware_humanity UB debit failed; rolled back local ledger reservation");
          continue;
        }
        affected++;
      }
    } else if (name === "eviction_sweep") {
      // Daily housing eviction sweep. Any lease whose delinquentSince is
      // older than HOUSING_GRACE_DAYS gets evicted: the row is deleted, an
      // activity event is logged, and an optional Discord notice is posted
      // to EVICTION_CHANNEL_ID. Runs independently of the housing
      // kill-switch — once a lease is flagged delinquent the grace clock
      // keeps ticking even if autobill is paused, but no NEW delinquency
      // can be created while monthly_rent is off.
      const cutoff = new Date(Date.now() - HOUSING_GRACE_DAYS * 86400000);
      const overdue = await db
        .select({ lease: housing, character: characters })
        .from(housing)
        .innerJoin(characters, eq(characters.id, housing.characterId))
        .where(isNotNull(housing.delinquentSince));
      for (const { lease, character: c } of overdue) {
        if (!lease.delinquentSince || lease.delinquentSince > cutoff) continue;
        await db.delete(housing).where(eq(housing.id, lease.id));
        await db.insert(activityEvents).values({
          kind: "housing_evicted",
          actorId: c.ownerId,
          message: `${c.name} evicted from ${lease.address} after ${HOUSING_GRACE_DAYS}-day grace period`,
        });
        if (EVICTION_CHANNEL_ID) {
          await postToChannel(
            EVICTION_CHANNEL_ID,
            `**EVICTION** — ${c.name} has been evicted from \`${lease.address}\` after failing to pay rent for ${HOUSING_GRACE_DAYS}+ days.`,
          ).catch((err) => logger.warn({ err, leaseId: lease.id }, "eviction notice post failed"));
        }
        affected++;
      }
    } else if (name === "mission_autopay") {
      // Pay out players for any scheduled mission whose run window (start +
      // duration + the configured auto-pay delay) has elapsed and which
      // hasn't already been auto-processed. All external effects inside
      // payMissionPlayers are themselves gated by the Test/Live toggle, so
      // running this cron in Test mode simulates + records without paying.
      affected = await runMissionAutoPay();
    } else if (name === "mission_npc_announce") {
      // Pre-mission "actors needed" announcement. Posting is gated by the
      // missions Test/Live toggle inside the service (Test mode logs only),
      // so this is intentionally NOT listed in liveSystemByJob.
      const r = await runMissionNpcAnnouncements();
      affected = r.announced;
    } else if (name === "economy_reconcile") {
      // UB->website wallet reconciliation. Handles its own tri-state mode
      // (disabled/test/enabled) internally, so it is intentionally NOT listed
      // in liveSystemByJob (it must still run as a dry-run in Test mode).
      const r = await runEconomyReconcile();
      affected = r.changed + r.seeded;
      message = `economy reconcile (${r.mode}): scanned ${r.scanned}, changed ${r.changed}, seeded ${r.seeded}, ub-unavailable ${r.failed}${r.dryRun ? " [dry-run: no writes]" : ""}`;
    } else if (name === "discord_event_sync") {
      // Bidirectional calendar ↔ Discord scheduled-event sync. Website-side
      // writes (import/pull/mirror-cancel) always run; Discord-side mutations
      // (push website edits up, delete a Discord event for an on-site cancel)
      // only run when missions are Live. `live` ANDs the master switch.
      const live = await isSystemLive("missions");
      const r = await reconcileDiscordEvents(live);
      affected = r.imported + r.pulled + r.pushed + r.cancelled + r.completed;
      const deferredNote = r.deferred
        ? `, deferred ${r.deferred} Discord write(s) (Test mode — set master + missions Live to push)`
        : "";
      message = `discord events sync${live ? " [live]" : " [test: website only]"}: imported ${r.imported}, pulled ${r.pulled}, pushed ${r.pushed}, cancelled ${r.cancelled}, completed ${r.completed}${deferredNote}${r.error ? `, error: ${r.error}` : ""}`;
    }
  } catch (err) {
    status = "failed";
    message = err instanceof Error ? err.message : String(err);
    logger.error({ err, job: name }, "Job failed");
  }
  await db
    .update(jobRuns)
    .set({ status, finishedAt: new Date(), affectedCount: affected, message })
    .where(eq(jobRuns.id, run.id));
  return { id: run.id, status, affectedCount: affected };
}

export function startCron() {
  // node-cron expressions: monthly_rent on the 1st at 04:00; role_sync every 6h; cyberware_humanity daily 05:00
  import("node-cron").then(({ default: cron }) => {
    cron.schedule("0 4 1 * *", async () => {
      if (!(await isAutobillEnabled(AUTOBILL_FLAGS.housing))) {
        logger.info({ flag: AUTOBILL_FLAGS.housing }, "monthly_rent cron skipped (kill switch off)");
        return;
      }
      runJob("monthly_rent").catch((err) => logger.error({ err }, "monthly_rent cron"));
    });
    cron.schedule("0 */6 * * *", () => {
      runJob("role_sync").catch((err) => logger.error({ err }, "role_sync cron"));
    });
    // Weekly cyberpsychosis-meds charge: Mondays at 05:00.
    cron.schedule("0 5 * * 1", async () => {
      if (!(await isAutobillEnabled(AUTOBILL_FLAGS.cyberware))) {
        logger.info({ flag: AUTOBILL_FLAGS.cyberware }, "cyberware_humanity cron skipped (kill switch off)");
        return;
      }
      runJob("cyberware_humanity").catch((err) => logger.error({ err }, "cyberware_humanity cron"));
    });
    // Daily eviction sweep at 04:30 UTC, just after the monthly rent run so
    // any same-day delinquency stamps are already in place. Intentionally
    // NOT gated on the housing kill switch — once a lease is in the grace
    // window we want it to resolve cleanly even if autobill is paused.
    cron.schedule("30 4 * * *", () => {
      runJob("eviction_sweep").catch((err) => logger.error({ err }, "eviction_sweep cron"));
    });
    // Mission auto-pay sweep every 15 minutes: pays players once a scheduled
    // mission's run window + auto-pay delay has elapsed. Gated on its own
    // kill switch (default OFF) so freshly deployed environments never pay
    // out automatically until an admin enables it. External effects are also
    // gated by the Test/Live toggle inside the job itself.
    cron.schedule("*/15 * * * *", async () => {
      if (!(await isAutobillEnabled(AUTOBILL_FLAGS.missionAutopay))) {
        logger.info({ flag: AUTOBILL_FLAGS.missionAutopay }, "mission_autopay cron skipped (kill switch off)");
        return;
      }
      runJob("mission_autopay").catch((err) => logger.error({ err }, "mission_autopay cron"));
    });
    // Pre-mission NPC announcement sweep every 5 minutes: posts an "actors
    // needed" call ~1h before a posted mission starts (once per mission, via
    // npcAnnouncedAt). Posting is gated by the missions Test/Live toggle inside
    // the service, so Test mode only logs.
    cron.schedule("*/5 * * * *", () => {
      runJob("mission_npc_announce").catch((err) => logger.error({ err }, "mission_npc_announce cron"));
    });
    // UB->website wallet reconciliation every 30 minutes. Skipped entirely when
    // the economy system is disabled (kill switch off); runs as a dry-run in
    // Test mode and performs live balance folds only when economy is Enabled.
    cron.schedule("*/30 * * * *", async () => {
      if ((await getEconomyMode()) === "disabled") {
        logger.info("economy_reconcile cron skipped (economy disabled)");
        return;
      }
      runJob("economy_reconcile").catch((err) => logger.error({ err }, "economy_reconcile cron"));
    });
    // Bidirectional Discord scheduled-event ↔ calendar sync every 10 minutes.
    // Imports new Discord events and reconciles edits/deletions both ways. Gated
    // on the missions Test/Live switch inside runJob, so Test mode is a no-op.
    cron.schedule("*/10 * * * *", () => {
      runJob("discord_event_sync").catch((err) => logger.error({ err }, "discord_event_sync cron"));
    });
    logger.info("Cron jobs scheduled");
  });
}

// suppress unused export warning
void sql;
