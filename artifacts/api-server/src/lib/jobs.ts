import { db, users, jobRuns, characters, characterStatus, walletTransactions, housing, activityEvents, botConfig, shopOpens, inventoryItems, stores, ripperdocs, notifications } from "@workspace/db";
import { eq, and, desc, sql, isNotNull, gte, inArray, ne, lt } from "drizzle-orm";
import { logger } from "./logger";
import { recordAudit } from "./audit";
import { fetchGuildMemberRolesViaBot, fetchGuildMemberRoleIdsViaBot, fetchAllGuildMemberRoles, VERIFIED_18_ROLE_ID, RULES_ROLE_ID, DEAD_CHARACTER_ROLE_ID, applyRoleIdGrants, addGuildMemberRole, postToChannel } from "./discord";
import { reconcileBusinessChannelAccess } from "./businessChannelAccess";
import { notifyAutoCharge } from "./notifications";
import { patchBalance } from "./unbelievaboat";
import { sumCwpByCharacter } from "./cyberware";
import { runMissionAutoPay, runMissionNpcAnnouncements, runMissionThreadBackfill } from "./missionsService";
import { reconcileDiscordEvents, backfillMainSessions, reconcileVrchatCalendar } from "./eventsService";
import { isSystemLive, type LiveSystem } from "./liveMode";
import { runEconomyReconcile, getEconomyMode, advanceSettledWalletBalance } from "./economy";
import { pollGroupInstances } from "./vrchatInstances";
import { vrchatCredsConfigured, vrchatSessionConnected } from "./vrchatClient";
import {
  DEFAULT_BASELINE_LIVING_COST,
  DEFAULT_XANADU_GOLD_COST,
  readConfigNumber,
  readTraumaCosts,
} from "./billingConfig";

const EVICTION_CHANNEL_ID = process.env.EVICTION_CHANNEL_ID ?? "";
const HOUSING_GRACE_DAYS = Number(process.env.HOUSING_GRACE_DAYS ?? 7);

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

// Characters whose headline lifeStatus is one of these drop out of the
// cyberware household the instant the status is set: they neither owe weekly
// meds nor count toward the household multiplier that scales every other
// member's bill. Keyed on lifeStatus (the LOA / Retired / Dead dropdown).
// "missing" and "active" deliberately still count.
export const CYBERWARE_EXCLUDED_LIFE_STATUSES = new Set(["dead", "retired", "loa"]);

export function countsForCyberwareBilling(c: { lifeStatus?: string | null }): boolean {
  return !CYBERWARE_EXCLUDED_LIFE_STATUSES.has((c.lifeStatus ?? "active").toLowerCase());
}

// The owner's current household "effective last checkup" date: the newest of
// (lastCheckupAt ?? createdAt) across their billable PCs (approved,
// non-archived, not dead/retired/LOA) — exactly the reduce the meds cron and
// dashboard projection use. Returns null when the owner has no billable PCs.
//
// Why this exists: a NEWLY approved character must not reset the household
// meds streak. Because the household week is derived from the max effective
// date, a fresh row's createdAt=now would drag the whole household back to
// week 1. Every path that creates/approves a PC for an owner should stamp the
// new character's lastCheckupAt with this inherited date (when non-null) so
// the streak stays exactly where it was. Stamping can never CHANGE the
// household week either — the inherited date is by construction the current
// household max, so the max is unchanged. When this returns null (first PC),
// leaving lastCheckupAt null is correct: createdAt acts as the implicit
// initial checkup (see .agents/memory/checkup-streak-creation-floor.md).
export async function householdEffectiveCheckupDate(
  conn: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  ownerId: string,
  excludeCharacterId?: number,
): Promise<Date | null> {
  const rows = await conn
    .select({
      lastCheckupAt: characters.lastCheckupAt,
      createdAt: characters.createdAt,
      lifeStatus: characters.lifeStatus,
    })
    .from(characters)
    .where(and(
      eq(characters.ownerId, ownerId),
      eq(characters.kind, "pc"),
      eq(characters.approved, true),
      eq(characters.archived, false),
      ...(excludeCharacterId != null ? [ne(characters.id, excludeCharacterId)] : []),
    ));
  let acc: Date | null = null;
  for (const r of rows) {
    if (!countsForCyberwareBilling(r)) continue;
    const eff = r.lastCheckupAt ?? r.createdAt;
    if (eff && (!acc || eff.getTime() > acc.getTime())) acc = eff;
  }
  return acc;
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
  /** Player-facing label for the charge DM. */
  dmLabel: string;
  /** Optional character name shown in the DM (null for per-player fees). */
  characterName?: string | null;
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
  // Advance the website wallet balance in lockstep with the UB debit so it
  // doesn't drift until the next reconcile (the ledger row was already written
  // above). Best-effort: a failure here is folded by reconcile later.
  await advanceSettledWalletBalance({ userId: opts.userId, amount: -opts.cost, ubTotalAfter: ub.total }).catch(() => {});
  void notifyAutoCharge({
    discordId: opts.discordId,
    userId: opts.userId,
    amount: opts.cost,
    label: opts.dmLabel,
    characterName: opts.characterName,
    newBalance: ub.cash,
  });
  return true;
}

export type JobName = "cyberware_humanity" | "monthly_rent" | "role_sync" | "eviction_sweep" | "mission_autopay" | "mission_npc_announce" | "economy_reconcile" | "discord_event_sync" | "main_session_backfill" | "mission_thread_backfill" | "notification_prune";

// Retention policy for the bell-feed notifications table (append-only
// otherwise): READ rows older than this are deleted; unread rows are kept
// indefinitely so nobody loses a notification they never saw.
const NOTIFICATION_READ_RETENTION_DAYS = 90;

// Jobs guarded against overlapping in-process runs (see runJob). Money-moving
// jobs (monthly_rent, cyberware_humanity) would double-charge; mission_thread_-
// backfill would double-post Discord threads — it reads each mission's
// discordThreadId before creating, so two overlapping runs (e.g. a manual admin
// trigger landing on a cron tick) can both see null and create a second forum
// thread before either commits the link.
const NO_OVERLAP_JOBS = new Set<JobName>(["monthly_rent", "cyberware_humanity", "mission_thread_backfill"]);
const inFlightJobs = new Set<JobName>();

export async function runJob(name: JobName): Promise<{ id: number; status: string; affectedCount: number }> {
  // In-process guard for overlap-sensitive jobs: stop a manual /admin/jobs/run
  // from overlapping an in-flight cron tick (or vice versa) within this process.
  // Money jobs can both pass the paid_through / billed-this-run guards before
  // either commits (double-charge); mission_thread_backfill can both read a null
  // discordThreadId and create two forum threads. The deployment is a single
  // always-on VM, so an in-process mutex is reliable here (unlike pooled-
  // connection Postgres advisory locks, which don't keep a stable session).
  if (NO_OVERLAP_JOBS.has(name) && inFlightJobs.has(name)) {
    logger.warn({ job: name }, "job already running in-process; skipping overlapping run");
    const [skipped] = await db
      .insert(jobRuns)
      .values({ job: name, status: "skipped", finishedAt: new Date(), affectedCount: 0, message: "Skipped: another run of this job is already in progress." })
      .returning();
    return { id: skipped.id, status: "skipped", affectedCount: 0 };
  }
  const heldOverlapLock = NO_OVERLAP_JOBS.has(name);
  if (heldOverlapLock) inFlightJobs.add(name);
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
      // Owners of at least one dead PC get the "Dead Character" Discord role
      // (afterlife-drinks access). Precompute the owner set once — this doubles
      // as the backfill for characters that died before the role existed and as
      // the self-heal for any missed immediate grant. Grant-only (see
      // DEAD_CHARACTER_ROLE_ID docs): never auto-revoked here.
      const deadOwnerRows = await db
        .selectDistinct({ ownerId: characters.ownerId })
        .from(characters)
        .where(and(eq(characters.kind, "pc"), eq(characters.lifeStatus, "dead"), isNotNull(characters.ownerId)));
      const deadOwners = new Set(deadOwnerRows.map((r) => r.ownerId).filter((v): v is string => !!v));
      // Try the cheap path first: one paginated bulk fetch of every guild
      // member's roles (~1 Discord call per 1000 members) instead of 2 calls
      // per registered user. This is what makes a tighter sync interval safe.
      // A null result means the bulk scan couldn't be trusted (config/network
      // error or page-cap) — fall back to the per-user path rather than
      // mass-clearing roles from a partial snapshot.
      const bulk = await fetchAllGuildMemberRoles();
      for (const u of allUsers) {
        try {
          let roles: string[];
          let roleIds: string[] | null;
          // `definite` = we have a TRUSTWORTHY read of this member, so an empty
          // result genuinely means "no roles / left the guild" and must be
          // persisted (clearing stale role names). A non-null bulk result is a
          // complete snapshot, so every lookup against it is definite — an absent
          // member has truly left. The per-user fallback returns [] the same way
          // for "no roles" and a transient names-fetch failure, so it stays
          // conservative and never clears on empty.
          let definite: boolean;
          if (bulk) {
            const entry = bulk.get(u.discordId);
            roles = entry ? entry.names : [];
            roleIds = entry ? entry.ids : [];
            definite = true;
          } else {
            roles = await fetchGuildMemberRolesViaBot(u.discordId);
            // Recompute the 18+ gate flag from raw role ids so removing the
            // Verified-18 role in Discord actually revokes portal access on the
            // next sweep. Only touch verified18 when the fetch succeeds
            // (non-null) so a transient Discord failure never clears the gate.
            roleIds = await fetchGuildMemberRoleIdsViaBot(u.discordId);
            definite = false;
          }
          // Map id-gated grants (e.g. Trial Fixer → "trial-fixer" marker) onto
          // the names so id-derived role markers stay current without re-login.
          // Only when we have raw ids; the per-user fallback may return null.
          if (roleIds !== null) roles = applyRoleIdGrants(roles, roleIds);
          const verified18 = roleIds === null ? u.verified18 : roleIds.includes(VERIFIED_18_ROLE_ID);
          // Reconcile the rules-read Discord role. The /auth/accept-rules grant is
          // best-effort (Discord may be transiently down, or writes suppressed off
          // the live deploy), so a member can clear the UI gate without the role.
          // Backfill it here for anyone who has accepted but is missing the role,
          // making eventual grant guaranteed without blocking the accept UX.
          if (u.rulesAccepted && roleIds !== null && !roleIds.includes(RULES_ROLE_ID)) {
            const granted = await addGuildMemberRole(u.discordId, RULES_ROLE_ID);
            if (!granted.ok) {
              // Self-heals on the next hourly sync (the condition re-triggers),
              // but surface the failure so a persistently-missing rules role
              // isn't invisible.
              logger.warn({ userId: u.id, discordId: u.discordId, error: granted.error }, "role sync: RULES_ROLE_ID backfill failed; will retry next sync");
            }
          }
          // Backfill the Dead Character role for anyone who owns a dead PC but
          // is missing it (pre-existing deaths, or an immediate grant that
          // failed / was suppressed off-deployment). Only when we have a
          // definite role read so we never re-grant blind on a fetch failure.
          if (deadOwners.has(u.id) && roleIds !== null && !roleIds.includes(DEAD_CHARACTER_ROLE_ID)) {
            const granted = await addGuildMemberRole(u.discordId, DEAD_CHARACTER_ROLE_ID, "Dead Character — owns a dead PC (role sync backfill)");
            if (!granted.ok) {
              logger.warn({ userId: u.id, discordId: u.discordId, error: granted.error }, "role sync: DEAD_CHARACTER_ROLE_ID backfill failed; will retry next sync");
            }
          }
          // With a definite read, always write `roles` (even empty) so a member
          // who lost their last role or left the guild is reconciled instead of
          // keeping stale names. Otherwise keep the conservative behavior: only
          // overwrite when we actually saw role names.
          if (definite || roles.length || roleIds !== null) {
            await db
              .update(users)
              .set({
                ...(definite || roles.length ? { roles } : {}),
                verified18,
                rolesSyncedAt: new Date(),
              })
              .where(eq(users.id, u.id));
            affected++;
          }
        } catch (err) {
          logger.warn({ err, userId: u.id }, "role sync user failed");
        }
      }
      // Catch-all for the business-owners Discord channel: grant access to any
      // current store/ripperdoc owner who is missing it and revoke anyone who no
      // longer owns a business. Self-heals event-driven grants/revokes that were
      // suppressed off-deployment or failed transiently. No-op when nothing drifted.
      try {
        const { granted, revoked } = await reconcileBusinessChannelAccess();
        if (granted || revoked) {
          logger.info({ granted, revoked }, "role sync: business channel access reconciled");
          affected += granted + revoked;
        }
      } catch (err) {
        logger.warn({ err }, "role sync: business channel access reconcile failed");
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

        // ----- 2a. Passive shop income (REMOVED) -----------------------------
        // Shop income is now paid INSTANTLY when an owner opens shop during a
        // live session (POST /characters/:id/open-shop), like the weekly
        // attendance bonus — no longer accrued and paid monthly. The old
        // monthly pass counted opens in the CURRENT month, but this cron fires
        // on the 1st before any opens exist, so it silently paid nothing.
        // See .agents/memory/shop-open-venue-income.md.

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
            userId: owner.id,
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
            await recordAudit({
              category: "housing",
              action: "housing.delinquent",
              actorId: c.ownerId,
              targetType: "character",
              targetId: String(c.id),
              message: `${c.name} could not pay rent on ${lease.address} (€$${rent})`,
              after: { leaseId: lease.id, address: lease.address, rent },
            });
          }
          continue;
        }
        // Keep the website wallet balance in lockstep with the UB debit.
        await advanceSettledWalletBalance({ userId: owner.id, amount: -rent, ubTotalAfter: ub.total }).catch(() => {});
        // Clear delinquentSince on every successful debit — a paid month
        // resets the eviction clock, even if the lease had previously
        // entered the grace period.
        if (lease.delinquentSince) {
          await db
            .update(housing)
            .set({ delinquentSince: null })
            .where(eq(housing.id, lease.id));
        }
        void notifyAutoCharge({
          discordId: owner.discordId,
          userId: owner.id,
          amount: rent,
          label: `${reasonLabel}: ${lease.address}`,
          characterName: c.name,
          newBalance: ub.cash,
        });
        affected++;
      }

      // ----- 2b. Passive venue-only shop income (REMOVED) --------------------
      // Store / ripperdoc owners without a business lease used to earn monthly
      // passive income here. Shop income is now paid INSTANTLY on open shop
      // (POST /characters/:id/open-shop) for lease holders and venue-only
      // owners alike, so this monthly pass is gone to avoid double-paying.

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
            dmLabel: "Baseline living cost (monthly)",
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
            dmLabel: `Trauma Team ${tier} subscription`,
            characterName: c.name,
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
            dmLabel: "Xanadu Gold membership",
            characterName: c.name,
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
      // Self-service LOA toggle (character_status.loa) pauses meds the same way
      // it pauses rent in monthly_rent. This is separate from the headline
      // lifeStatus="loa" the importer/admin sets; a player on hiatus flips the
      // transient flag and expects ALL personal billing to stop, so honor both.
      const medsStatusRows = await db.select().from(characterStatus);
      const medsLoaByCharacter = new Map<number, boolean>();
      for (const s of medsStatusRows) medsLoaByCharacter.set(s.characterId, !!s.loa);
      const approvedChars = (await db
        .select()
        .from(characters)
        .where(and(eq(characters.kind, "pc"), eq(characters.approved, true), eq(characters.archived, false))))
        // LOA / retired / dead characters owe no meds and don't inflate the
        // household multiplier — drop them before any household grouping. This
        // covers both the headline lifeStatus (countsForCyberwareBilling) and
        // the transient self-service character_status.loa toggle.
        .filter((c) => countsForCyberwareBilling(c) && medsLoaByCharacter.get(c.id) !== true);

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
        // A character's creation counts as an implicit initial checkup, so a
        // brand-new chromed PC isn't billed as if they'd skipped checkups for
        // weeks before they existed. Effective date = real last checkup, or
        // creation date if they've never had one.
        const lastCheckupAt = ownerChars.reduce<Date | null>((acc, c) => {
          const eff = c.lastCheckupAt ?? c.createdAt;
          if (!eff) return acc;
          if (!acc || eff > acc) return eff;
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
        // Keep the website wallet balance in lockstep with the UB debit.
        await advanceSettledWalletBalance({ userId: ownerId, amount: -proj.charge, ubTotalAfter: ub.total }).catch(() => {});
        void notifyAutoCharge({
          discordId: owner.discordId,
          userId: ownerId,
          amount: proj.charge,
          label: `Weekly cyberpsychosis meds (${proj.level})`,
          newBalance: ub.cash,
        });
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
        await recordAudit({
          category: "housing",
          action: "housing.evicted",
          actorId: c.ownerId,
          targetType: "character",
          targetId: String(c.id),
          message: `${c.name} evicted from ${lease.address} after ${HOUSING_GRACE_DAYS}-day grace period`,
          before: { leaseId: lease.id, address: lease.address, delinquentSince: lease.delinquentSince },
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
      // Mirror upcoming Main Sessions + social events to the VRChat group
      // calendar. Self-gated (kill-switch + deployment gate); a no-op otherwise,
      // and bounded per cycle to respect VRChat's write rate limit.
      const vr = await reconcileVrchatCalendar();
      affected += vr.synced;
      const vrchatNote = vr.synced || vr.failed ? `; vrchat synced ${vr.synced}, failed ${vr.failed}` : "";
      message = `discord events sync${live ? " [live]" : " [test: website only]"}: imported ${r.imported}, pulled ${r.pulled}, pushed ${r.pushed}, cancelled ${r.cancelled}, completed ${r.completed}${deferredNote}${r.error ? `, error: ${r.error}` : ""}${vrchatNote}`;
    } else if (name === "main_session_backfill") {
      // Keep ~3 months of weekly Main Sessions on the calendar by cloning the
      // latest session forward to the horizon. Like discord_event_sync this is
      // NOT in liveSystemByJob: the website rows must be created in Test mode
      // too (so the calendar stays populated everywhere), while the Discord
      // scheduled-event push for each new row is gated internally on the live
      // flag inside createEvent. Idempotent — a no-op once coverage is full.
      const r = await backfillMainSessions({ horizonDays: 90 });
      affected = r.created + r.healed;
      const parts: string[] = [];
      if (r.created) parts.push(`created ${r.created} session(s) — ${r.titles.join(", ")}`);
      if (r.healed) parts.push(`pushed ${r.healed} unsynced session(s) to Discord — ${r.healedTitles.join(", ")}`);
      message = parts.length
        ? `main session backfill: ${parts.join("; ")}`
        : `main session backfill: nothing to create${r.reason ? ` (${r.reason})` : ""}`;
    } else if (name === "mission_thread_backfill") {
      // One-off backfill: give every currently-open mission a
      // Discord discussion thread + a seeded current-state snapshot. Like the
      // other thread posts this is deployment-gated (a no-op in the dev
      // workspace), NOT missions Test/Live gated, so it is intentionally NOT in
      // liveSystemByJob. Idempotent — only ever touches missions still missing a
      // thread, so it is safe to re-run.
      const r = await runMissionThreadBackfill();
      affected = r.created;
      message = `mission thread backfill: scanned ${r.scanned}, created ${r.created} thread(s), seeded ${r.seeded} snapshot(s), failed ${r.failed}`;
    } else if (name === "notification_prune") {
      // Retention sweep for the bell-feed notifications table. Notification
      // writers are append-only (one row per user per auto-charge, payout,
      // offer, fine, decision, ...), so without this the table grows without
      // bound. Delete only rows the user has already READ and that are older
      // than the retention window; unread rows are kept indefinitely so a
      // notification is never removed before its recipient has seen it.
      // Deliberately NOT in liveSystemByJob: this is internal housekeeping with
      // no external (Discord/UB) effects, safe to run in Test mode too.
      const cutoff = new Date(Date.now() - NOTIFICATION_READ_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      // Count via the driver's rowCount instead of RETURNING so a large
      // first-run sweep doesn't materialize every deleted row in memory.
      const result = await db
        .delete(notifications)
        .where(and(isNotNull(notifications.readAt), lt(notifications.createdAt, cutoff)));
      affected = result.rowCount ?? 0;
      message = `notification prune: deleted ${affected} read notification(s) older than ${NOTIFICATION_READ_RETENTION_DAYS} days (unread kept)`;
    }
  } catch (err) {
    status = "failed";
    message = err instanceof Error ? err.message : String(err);
    logger.error({ err, job: name }, "Job failed");
  } finally {
    if (heldOverlapLock) inFlightJobs.delete(name);
  }
  await db
    .update(jobRuns)
    .set({ status, finishedAt: new Date(), affectedCount: affected, message })
    .where(eq(jobRuns.id, run.id));
  return { id: run.id, status, affectedCount: affected };
}

export function startCron() {
  // node-cron expressions: monthly_rent on the 1st at 04:00; role_sync hourly; cyberware_humanity daily 05:00
  import("node-cron").then(({ default: cron }) => {
    cron.schedule("0 4 1 * *", async () => {
      if (!(await isAutobillEnabled(AUTOBILL_FLAGS.housing))) {
        logger.info({ flag: AUTOBILL_FLAGS.housing }, "monthly_rent cron skipped (kill switch off)");
        return;
      }
      runJob("monthly_rent").catch((err) => logger.error({ err }, "monthly_rent cron"));
    });
    cron.schedule("0 * * * *", () => {
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
    // Keep ~3 months of weekly Main Sessions on the calendar, daily at 06:37 UTC.
    // Idempotent — creates at most one new Sunday session per run and no-ops once
    // coverage reaches the horizon. Not kill-switch gated (it creates calendar
    // rows, not money); the per-row Discord push is gated on the live flag.
    // Deliberately OFF the */10 minute boundary so it never coincides with a
    // discord_event_sync tick — that keeps the new row's createEvent → Discord
    // push from racing the reconcile importer (which could otherwise re-import
    // the just-pushed Discord event as a duplicate row before it's linked).
    cron.schedule("37 6 * * *", () => {
      runJob("main_session_backfill").catch((err) => logger.error({ err }, "main_session_backfill cron"));
    });
    // Self-heal mission discussion threads every 10 minutes. New missions get a
    // forum thread at creation (announceMissionThread), but this catches every
    // mission still missing one: older missions created before forum-thread
    // support existed, missions made via paths that don't announce (e.g.
    // event→mission conversion), or a transient Discord failure at creation.
    // Idempotent — ensureMissionThread only writes when a thread is actually
    // missing, and the create call is deployment-gated internally (a no-op in
    // dev), so this is NOT Test/Live gated here, matching main_session_backfill.
    // Offset off the */10 boundary so it never piles onto a discord_event_sync
    // tick (different Discord API buckets, but keep the writes spread out).
    cron.schedule("5,15,25,35,45,55 * * * *", () => {
      runJob("mission_thread_backfill").catch((err) => logger.error({ err }, "mission_thread_backfill cron"));
    });
    // Daily notification retention sweep at 06:10 UTC — deletes READ bell-feed
    // rows older than the retention window (unread rows kept indefinitely).
    // Pure internal housekeeping (no Discord/UB effects), so it is not kill-
    // switch or Test/Live gated. Offset off other jobs' minutes to keep the
    // early-morning cron ticks spread out.
    cron.schedule("10 6 * * *", () => {
      runJob("notification_prune").catch((err) => logger.error({ err }, "notification_prune cron"));
    });
    // Live VRChat instance browser poll, every 2 minutes. Reads the NCRP group's
    // open instances and refreshes the member-facing cache. Gated to the
    // deployed environment (or ALLOW_EXTERNAL_WRITES) AND to having credentials
    // configured, so dev never burns the shared VRChat account's rate limit —
    // dev simply serves whatever cache prod last wrote. Staff can still force a
    // poll on demand via POST /vrchat/instances/refresh.
    const vrchatPollAllowed =
      process.env.REPLIT_DEPLOYMENT === "1" || process.env.ALLOW_EXTERNAL_WRITES === "1";
    if (vrchatPollAllowed) {
      cron.schedule("*/2 * * * *", async () => {
        if (!vrchatCredsConfigured()) return;
        // Skip quietly while the staff session is disconnected/expired — the
        // poll can only fail (and would spam a warn every 2 minutes) until a
        // staff member reconnects via the System Admin → VRChat card.
        try {
          if (!(await vrchatSessionConnected())) return;
          await pollGroupInstances();
        } catch (err) {
          logger.warn({ err }, "vrchat_instance_poll cron");
        }
      });
    }
    logger.info("Cron jobs scheduled");
  });
}

// suppress unused export warning
void sql;
