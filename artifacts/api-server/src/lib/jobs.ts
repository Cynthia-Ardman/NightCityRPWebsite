import { db, users, jobRuns, characters, walletTransactions, housing, lifestyleTiers, activityEvents } from "@workspace/db";
import { eq, and, desc, sql, isNotNull } from "drizzle-orm";
import { logger } from "./logger";
import { fetchGuildMemberRolesViaBot } from "./discord";
import { patchBalance } from "./unbelievaboat";

export type JobName = "cyberware_humanity" | "monthly_rent" | "role_sync";

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
      // Per-lease billing: iterate active housing rows joined to their
      // approved, non-archived characters. UB is authoritative — record the
      // local ledger entry and roll paid_through forward only when the debit
      // succeeds. On UB failure leave paid_through where it is so the lease
      // shows as delinquent in upcoming-bills until next run.
      const rows = await db
        .select({
          lease: housing,
          character: characters,
        })
        .from(housing)
        .innerJoin(characters, eq(characters.id, housing.characterId))
        .where(and(eq(characters.archived, false)));
      for (const { lease, character: c } of rows) {
        if (!c.approved) continue;
        if (!c.ownerId) continue;
        const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
        if (!owner) continue;
        const rent = lease.monthlyRent;
        if (rent <= 0) continue;
        const ub = await patchBalance(owner.discordId, {
          cash: -rent,
          reason: `Rent: ${lease.address}`,
        });
        if (!ub) {
          logger.warn(
            { characterId: c.id, leaseId: lease.id },
            "monthly_rent UB debit failed; lease will show delinquent",
          );
          continue;
        }
        await db.insert(walletTransactions).values({
          characterId: c.id,
          amount: -rent,
          kind: "rent",
          memo: `Rent: ${lease.address}`,
        });
        // Bump paid_through forward by one month from its previous value (or
        // from now if it was missing/stale), preserving anchor date when
        // possible so leases stay on a consistent monthly cadence.
        const base = lease.paidThrough && lease.paidThrough.getTime() > Date.now() - 86400000
          ? new Date(lease.paidThrough)
          : new Date();
        base.setUTCMonth(base.getUTCMonth() + 1);
        await db.update(housing).set({ paidThrough: base }).where(eq(housing.id, lease.id));
        affected++;
      }
      // Monthly lifestyle charge — independent of housing, iterates approved
      // non-archived PCs that have selected a (non-archived) lifestyle tier.
      // UB is authoritative; on debit failure we log an activity event but do
      // NOT evict the tier or write a ledger row.
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
        const cost = tier.monthlyCost;
        if (cost <= 0) continue;
        if (!c.ownerId) continue;
        const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
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
        affected++;
      }
    } else if (name === "cyberware_humanity") {
      // Weekly cyberpsychosis-meds charge. For each approved (non-archived) character
      // with an approved sheet, sum total humanity loss across all chrome (foundational
      // slots + Misc) and charge meds = HL * RATE_PER_HL.
      const RATE_PER_HL = 50; // eddies per humanity loss point per week
      const { characterSheets } = await import("@workspace/db");
      const approvedChars = await db
        .select()
        .from(characters)
        .where(and(eq(characters.kind, "pc"), eq(characters.approved, true), eq(characters.archived, false)));
      for (const c of approvedChars) {
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
        const charge = totalHL * RATE_PER_HL;
        if (!c.ownerId) continue;
        const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
        if (!owner) continue;
        // UB is authoritative — only insert a local ledger entry after a
        // confirmed UB debit. Skip cleanly on UB unavailability.
        const ub = await patchBalance(owner.discordId, {
          cash: -charge,
          reason: `Cyberpsychosis meds (${totalHL} HL)`,
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
            memo: `Weekly cyberpsychosis maintenance for ${totalHL} HL of chrome`,
          });
          affected++;
        } catch (err) {
          logger.warn({ err, characterId: c.id }, "cyberware_humanity ledger insert failed");
        }
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
    cron.schedule("0 4 1 * *", () => {
      runJob("monthly_rent").catch((err) => logger.error({ err }, "monthly_rent cron"));
    });
    cron.schedule("0 */6 * * *", () => {
      runJob("role_sync").catch((err) => logger.error({ err }, "role_sync cron"));
    });
    // Weekly cyberpsychosis-meds charge: Mondays at 05:00.
    cron.schedule("0 5 * * 1", () => {
      runJob("cyberware_humanity").catch((err) => logger.error({ err }, "cyberware_humanity cron"));
    });
    logger.info("Cron jobs scheduled");
  });
}

// suppress unused export warning
void sql;
