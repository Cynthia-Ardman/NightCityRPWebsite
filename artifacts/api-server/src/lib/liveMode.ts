import { db, botConfig } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Site-wide Test/Live safety switch.
//
// Every system that touches LIVE data (UnbelievaBoat currency, Discord channel
// posts, Discord scheduled events, destructive sweeps) is gated by TWO flags:
//
//   1. `master_live_mode`  — the global master switch.
//   2. `<system>_live_mode` — the per-system override.
//
// A system performs real external/destructive effects ONLY when the master AND
// that system's own switch are both Live. Every flag defaults to OFF (= Test)
// so a freshly deployed environment never touches real data until an admin
// explicitly opts a system into Live. In Test mode each system records/logs
// what it WOULD have done without performing the live effect.
// ---------------------------------------------------------------------------
export type LiveSystem = "missions" | "housing" | "cyberware" | "evictions";

export const LIVE_MODE_KEYS = {
  master: "master_live_mode",
  missions: "missions_live_mode",
  housing: "housing_live_mode",
  cyberware: "cyberware_live_mode",
  evictions: "evictions_live_mode",
} as const;

export const LIVE_SYSTEMS: LiveSystem[] = ["missions", "housing", "cyberware", "evictions"];

/**
 * Read a bot_config flag as a strict boolean. Only the literal JSON `true`
 * counts as ON. Anything else (missing row, false, null, "", numbers, strings)
 * is treated as OFF — fail-safe toward Test mode.
 */
async function readBool(key: string): Promise<boolean> {
  try {
    const [row] = await db.select().from(botConfig).where(eq(botConfig.key, key));
    return row?.value === true;
  } catch (err) {
    logger.warn({ err, key }, "live-mode flag read failed; treating as Test/off");
    return false;
  }
}

/** True only when the global master switch is explicitly Live. */
export async function isMasterLive(): Promise<boolean> {
  return readBool(LIVE_MODE_KEYS.master);
}

/**
 * Effective live state for a system: requires BOTH the master switch and the
 * system's own override to be Live. Read live per-action so an admin flipping
 * the switch takes effect immediately.
 */
export async function isSystemLive(system: LiveSystem): Promise<boolean> {
  const [master, sys] = await Promise.all([
    readBool(LIVE_MODE_KEYS.master),
    readBool(LIVE_MODE_KEYS[system]),
  ]);
  return master && sys;
}

export interface SystemLiveState {
  /** The per-system override as stored (independent of the master switch). */
  configured: boolean;
  /** Whether the system is actually Live right now (master AND configured). */
  effective: boolean;
}

export interface LiveModeState {
  master: boolean;
  systems: Record<LiveSystem, SystemLiveState>;
}

/** Snapshot of the full switchboard for the admin UI. */
export async function getLiveModeState(): Promise<LiveModeState> {
  const [master, missions, housing, cyberware, evictions] = await Promise.all([
    readBool(LIVE_MODE_KEYS.master),
    readBool(LIVE_MODE_KEYS.missions),
    readBool(LIVE_MODE_KEYS.housing),
    readBool(LIVE_MODE_KEYS.cyberware),
    readBool(LIVE_MODE_KEYS.evictions),
  ]);
  const flags: Record<LiveSystem, boolean> = { missions, housing, cyberware, evictions };
  const systems = {} as Record<LiveSystem, SystemLiveState>;
  for (const sys of LIVE_SYSTEMS) {
    systems[sys] = { configured: flags[sys], effective: master && flags[sys] };
  }
  return { master, systems };
}
