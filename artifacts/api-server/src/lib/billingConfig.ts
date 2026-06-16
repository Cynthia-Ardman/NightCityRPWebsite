import { db, botConfig } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// Shared monthly-fee config. The monthly_rent cron AND the dashboard "next
// bill" projection both read from here so the number a player is shown is
// exactly what the cron will debit. Admins override these by writing to
// bot_config; the defaults are the fresh-deploy fallback.

export const DEFAULT_BASELINE_LIVING_COST = 500;
export const DEFAULT_XANADU_GOLD_COST = 500;
// Aligned with NightCityBot's trauma_team_costs config: 1k / 2k / 4k / 10k.
export const DEFAULT_TRAUMA_TEAM_COSTS: Record<string, number> = {
  silver: 1000,
  gold: 2000,
  platinum: 4000,
  diamond: 10000,
  // Corporate-sponsorship comp tier — no monthly charge. Fixer-assignable only.
  corporate: 0,
};

export async function readConfigNumber(key: string, fallback: number): Promise<number> {
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

export async function readTraumaCosts(): Promise<Record<string, number>> {
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
