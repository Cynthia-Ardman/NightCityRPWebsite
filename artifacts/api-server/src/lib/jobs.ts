import { db, users, jobRuns, characters, characterStatus, walletTransactions, housing, lifestyleTiers, activityEvents, botConfig, shopOpens, inventoryItems } from "@workspace/db";
import { eq, and, desc, sql, isNotNull, gte, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { fetchGuildMemberRolesViaBot, postToChannel } from "./discord";
import { patchBalance } from "./unbelievaboat";
import { sumCwpByCharacter } from "./cyberware";
import { runMissionAutoPay } from "./missionsService";
import { isSystemLive, type LiveSystem } from "./liveMode";

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

export type JobName = "cyberware_humanity" | "monthly_rent" | "role_sync" | "eviction_sweep" | "mission_autopay";

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
          if (roles.length) {
            await db.update(users).set({ roles, rolesSyncedAt: new Date() }).where(eq(users.id, u.id));
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
            const ubCredit = await patchBalance(owner.discordId, {
              cash: income,
              reason: `Shop income: ${lease.address} (${opens} day${opens === 1 ? "" : "s"})`,
            });
            if (ubCredit) {
              await db.insert(walletTransactions).values({
                characterId: c.id,
                userId: c.ownerId,
                amount: income,
                kind: "shop_income",
                memo: `Shop income: ${lease.address} (${opens} day${opens === 1 ? "" : "s"})`,
              });
              markBilled(c.id, "shop_income");
              affected++;
            } else {
              logger.warn(
                { characterId: c.id, leaseId: lease.id, income },
                "monthly_rent shop_income UB credit failed; skipping ledger row",
              );
            }
          }
        }

        const ub = await patchBalance(owner.discordId, {
          cash: -rent,
          reason: `${reasonLabel}: ${lease.address}`,
        });
        if (!ub) {
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
        await db.insert(walletTransactions).values({
          characterId: c.id,
          amount: -rent,
          kind: isBusiness ? "business_rent" : "rent",
          memo: `${reasonLabel}: ${lease.address}`,
        });
        // Bump paid_through forward by one month from its previous value (or
        // from now if it was missing/stale), preserving anchor date when
        // possible so leases stay on a consistent monthly cadence.
        const base = lease.paidThrough && lease.paidThrough.getTime() > Date.now() - 86400000
          ? new Date(lease.paidThrough)
          : new Date();
        base.setUTCMonth(base.getUTCMonth() + 1);
        // Clear delinquentSince on every successful debit — a paid month
        // resets the eviction clock, even if the lease had previously
        // entered the grace period.
        await db
          .update(housing)
          .set({ paidThrough: base, delinquentSince: null })
          .where(eq(housing.id, lease.id));
        affected++;
      }

      // ----- 3. Lifestyle ----------------------------------------------------
      // Monthly lifestyle charge — independent of housing, iterates approved
      // non-archived PCs that have selected a (non-archived) lifestyle tier.
      // Personal fee → skipped on LOA. UB is authoritative; on debit failure
      // we log an activity event but do NOT evict the tier or write a ledger
      // row.
      const lifestyleRows = await db
        .select({ character: characters, tier: lifestyleTiers })
        .from(characters)
        .innerJoin(lifestyleTiers, eq(lifestyleTiers.id, characters.lifestyleTierId))
        .where(and(
          eq(characters.kind, "pc"),
          eq(characters.approved, true),
          eq(characters.archived, false),
          eq(lifestyleTiers.archived, false),
          isNotNull(characters.lifestyleTierId),
        ));
      for (const { character: c, tier } of lifestyleRows) {
        if (isOnLoa(c.id)) continue;
        if (billedThisRun(c.id, "lifestyle")) continue;
        const cost = tier.monthlyCost;
        if (cost <= 0) continue;
        if (!c.ownerId) continue;
        const owner = await getOwner(c.ownerId);
        if (!owner) continue;
        const ub = await patchBalance(owner.discordId, {
          cash: -cost,
          reason: `Lifestyle: ${tier.name} (${c.name})`,
        });
        if (!ub) {
          logger.warn(
            { characterId: c.id, tierId: tier.id },
            "monthly_rent lifestyle UB debit failed; logging unpaid event",
          );
          await db.insert(activityEvents).values({
            kind: "lifestyle_unpaid",
            actorId: c.ownerId,
            message: `${c.name} could not pay ${tier.name} lifestyle (€$${cost})`,
          });
          continue;
        }
        await db.insert(walletTransactions).values({
          characterId: c.id,
          userId: c.ownerId,
          amount: -cost,
          kind: "lifestyle",
          memo: `Lifestyle: ${tier.name}`,
        });
        markBilled(c.id, "lifestyle");
        affected++;
      }

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
          const ub = await patchBalance(owner.discordId, {
            cash: -baselineCost,
            reason: `Baseline living cost`,
          });
          if (ub) {
            await db.insert(walletTransactions).values({
              characterId: null,
              userId: c.ownerId,
              amount: -baselineCost,
              kind: "baseline",
              memo: "Baseline living cost (monthly)",
            });
            baselineBilledOwners.add(c.ownerId);
            affected++;
          } else {
            logger.warn({ ownerId: c.ownerId }, "monthly_rent baseline UB debit failed");
          }
        }

        // 5. Trauma Team subscription
        const tier = (c.traumaTeamTier ?? "").toLowerCase();
        const traumaCost = tier ? (traumaCosts[tier] ?? 0) : 0;
        if (tier && traumaCost > 0 && !billedThisRun(c.id, "trauma_team")) {
          const ub = await patchBalance(owner.discordId, {
            cash: -traumaCost,
            reason: `Trauma Team ${tier} (${c.name})`,
          });
          if (ub) {
            await db.insert(walletTransactions).values({
              characterId: c.id,
              userId: c.ownerId,
              amount: -traumaCost,
              kind: "trauma_team",
              memo: `Trauma Team ${tier} subscription`,
            });
            markBilled(c.id, "trauma_team");
            affected++;
          } else {
            logger.warn({ characterId: c.id, tier }, "monthly_rent trauma UB debit failed");
          }
        }

        // 6. Xanadu Gold premium membership
        if (c.xanaduGold && xanaduCost > 0 && !billedThisRun(c.id, "xanadu_gold")) {
          const ub = await patchBalance(owner.discordId, {
            cash: -xanaduCost,
            reason: `Xanadu Gold (${c.name})`,
          });
          if (ub) {
            await db.insert(walletTransactions).values({
              characterId: c.id,
              userId: c.ownerId,
              amount: -xanaduCost,
              kind: "xanadu_gold",
              memo: "Xanadu Gold membership",
            });
            markBilled(c.id, "xanadu_gold");
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
        // UB is authoritative — only insert a local ledger entry after a
        // confirmed UB debit. Skip cleanly on UB unavailability.
        const ub = await patchBalance(owner.discordId, {
          cash: -proj.charge,
          reason: `Cyberpsychosis meds (${proj.level}, week ${weeksUnpaid}, household x${proj.multiplier.toFixed(2)})`,
        });
        if (!ub) {
          logger.warn({ ownerId }, "cyberware_humanity UB debit failed; skipping local ledger insert");
          continue;
        }
        try {
          await db.insert(walletTransactions).values({
            userId: ownerId,
            characterId: null,
            amount: -proj.charge,
            kind: "meds",
            memo: `Weekly cyberpsychosis meds (${proj.level}, ${maxChromeCount} chrome, week ${weeksUnpaid}, household x${proj.multiplier.toFixed(2)})`,
          });
          affected++;
        } catch (err) {
          logger.warn({ err, ownerId }, "cyberware_humanity ledger insert failed");
        }
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
    logger.info("Cron jobs scheduled");
  });
}

// suppress unused export warning
void sql;
