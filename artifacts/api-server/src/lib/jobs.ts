import { db, users, jobRuns, characters, walletTransactions } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
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
      // Placeholder: charges flat rent to every approved PC. Real logic uses character housing.
      const chars = await db.select().from(characters).where(eq(characters.kind, "pc"));
      for (const c of chars) {
        const rent = 500;
        const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
        if (owner) await patchBalance(owner.discordId, { cash: -rent, reason: "Monthly rent" });
        await db.insert(walletTransactions).values({
          characterId: c.id,
          amount: -rent,
          kind: "rent",
          memo: "Monthly rent",
        });
        affected++;
      }
    } else if (name === "cyberware_humanity") {
      // Placeholder: would compute humanity loss from installed cyberware.
      message = "No-op placeholder";
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
    cron.schedule("0 5 * * *", () => {
      runJob("cyberware_humanity").catch((err) => logger.error({ err }, "cyberware_humanity cron"));
    });
    logger.info("Cron jobs scheduled");
  });
}

// suppress unused export warning
void sql;
