import { db, users, jobRuns, characters, characterStatus, walletTransactions, housing, lifestyleTiers, activityEvents, botConfig } from "@workspace/db";
import { eq, and, desc, sql, isNotNull, gte, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { fetchGuildMemberRolesViaBot, postToChannel } from "./discord";
import { patchBalance } from "./unbelievaboat";

const EVICTION_CHANNEL_ID = process.env.EVICTION_CHANNEL_ID ?? "";
const HOUSING_GRACE_DAYS = Number(process.env.HOUSING_GRACE_DAYS ?? 7);

// Default monthly costs used when the corresponding bot_config row is missing
// or malformed. Admins override these by writing to bot_config; the cron
// always falls back here so a fresh deploy is internally consistent.
const DEFAULT_BASELINE_LIVING_COST = 500;
const DEFAULT_XANADU_GOLD_COST = 500;
const DEFAULT_TRAUMA_TEAM_COSTS: Record<string, number> = {
  silver: 500,
  gold: 1000,
  platinum: 2000,
  diamond: 5000,
};

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

export type JobName = "cyberware_humanity" | "monthly_rent" | "role_sync" | "eviction_sweep";

export async function runJob(name: JobName): Promise<{ id: number; status: string; affectedCount: number }> {
  const [run] = await db.insert(jobRuns).values({ job: name, status: "running" }).returning();
  let affected = 0;
  let status = "succeeded";
  let message: string | null = null;
  try {
    if (name === "role_sync") {
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
      const TRACKED_PERSONAL_KINDS = ["lifestyle", "baseline", "trauma_team", "xanadu_gold"] as const;
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

      for (const c of personalChars) {
        if (isOnLoa(c.id)) continue;
        if (!c.ownerId) continue; // narrowing — the SQL filter already guarantees this
        const owner = await getOwner(c.ownerId);
        if (!owner) continue;

        // 4. Baseline living cost (food, utilities, etc.)
        if (baselineCost > 0 && !billedThisRun(c.id, "baseline")) {
          const ub = await patchBalance(owner.discordId, {
            cash: -baselineCost,
            reason: `Baseline living cost (${c.name})`,
          });
          if (ub) {
            await db.insert(walletTransactions).values({
              characterId: c.id,
              userId: c.ownerId,
              amount: -baselineCost,
              kind: "baseline",
              memo: "Baseline living cost",
            });
            markBilled(c.id, "baseline");
            affected++;
          } else {
            logger.warn({ characterId: c.id }, "monthly_rent baseline UB debit failed");
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
      // Weekly cyberpsychosis-meds charge. For each approved (non-archived) character
      // with an approved sheet, sum total humanity loss across all chrome (foundational
      // slots + Misc) and charge meds = HL * RATE_PER_HL.
      const RATE_PER_HL = 50; // eddies per humanity loss point per week
      const MAX_STREAK_MULTIPLIER = 10; // cap on missed-checkup streak penalty
      const { characterSheets } = await import("@workspace/db");
      // Weekly idempotency: skip any character who already has a 'meds' debit in
      // the last 6 days so a manual rerun (or two cron ticks in the same week)
      // can't double-charge or double-bump the streak.
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
      for (const c of approvedChars) {
        if (recentMedsSet.has(c.id)) continue;
        const [sheet] = await db
          .select()
          .from(characterSheets)
          .where(and(eq(characterSheets.characterId, c.id), eq(characterSheets.status, "approved")))
          .orderBy(desc(characterSheets.createdAt))
          .limit(1);
        if (!sheet) continue;
        const data = (sheet.data ?? {}) as Record<string, unknown>;
        const bySlot = Array.isArray(data.cyberwareBySlot) ? data.cyberwareBySlot : [];
        const misc = Array.isArray(data.cyberwareMisc) ? data.cyberwareMisc : [];
        const allChrome = [...bySlot, ...misc] as Array<{ name?: string; humanityLoss?: number }>;
        const totalHL = allChrome
          .filter((cw) => (cw?.name ?? "").trim().length > 0)
          .reduce((s, cw) => s + (Number(cw.humanityLoss) || 0), 0);
        if (totalHL <= 0) continue;
        // Missed-checkup streak penalty. Increment every cron tick; the
        // admin /admin/characters/:id/checkup endpoint resets it to 0.
        // Capped so the bill can't run away on a long-absent player.
        const nextStreak = Math.min((c.checkupStreak ?? 0) + 1, MAX_STREAK_MULTIPLIER);
        const multiplier = nextStreak;
        const charge = totalHL * RATE_PER_HL * multiplier;
        if (!c.ownerId) continue;
        const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
        if (!owner) continue;
        // UB is authoritative — only insert a local ledger entry after a
        // confirmed UB debit. Skip cleanly on UB unavailability.
        const ub = await patchBalance(owner.discordId, {
          cash: -charge,
          reason: `Cyberpsychosis meds (${totalHL} HL × week ${multiplier})`,
        });
        if (!ub) {
          logger.warn({ characterId: c.id }, "cyberware_humanity UB debit failed; skipping local ledger insert");
          continue;
        }
        try {
          await db.insert(walletTransactions).values({
            characterId: c.id,
            amount: -charge,
            kind: "meds",
            memo: `Weekly cyberpsychosis maintenance for ${totalHL} HL of chrome (week ${multiplier} of missed checkups)`,
          });
          // Bump the streak after a successful debit so a UB failure doesn't
          // also burn the player's streak counter — they get a clean retry.
          await db.update(characters).set({ checkupStreak: nextStreak }).where(eq(characters.id, c.id));
          affected++;
        } catch (err) {
          logger.warn({ err, characterId: c.id }, "cyberware_humanity ledger insert failed");
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
    logger.info("Cron jobs scheduled");
  });
}

// suppress unused export warning
void sql;
