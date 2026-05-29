import { db, botConfig } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { isSystemLive } from "./liveMode";

// ---------------------------------------------------------------------------
// Mission system configuration (bot_config-backed, admin-editable).
//
// The master Test/Live toggle (`missions_live_mode`) gates EVERY external
// side effect of the mission system — Discord scheduled events, channel
// posts, and UnbelievaBoat money movement. It defaults to OFF (= Test mode)
// so a freshly deployed environment never touches Discord or moves money
// until an admin explicitly flips it to Live. In Test mode the system still
// records what it "would have" done (simulated payments, audit entries) so
// fixers can rehearse the full flow safely.
// ---------------------------------------------------------------------------
export const MISSION_CONFIG_KEYS = {
  liveMode: "missions_live_mode",
  bankingChannel: "missions_banking_channel_id",
  npcSpendingChannel: "missions_npc_spending_channel_id",
  npcAnnouncementChannel: "missions_npc_announcement_channel_id",
  defaultImage: "missions_default_image_url",
  autopayDelayHours: "missions_autopay_delay_hours",
} as const;

// Defaults from the spec (§24, §26, §36). Channel IDs are configurable but
// ship with the current production values.
export const MISSION_DEFAULTS = {
  bankingChannelId: "1348640138321989642",
  npcSpendingChannelId: "1354606166004600903",
  // #npc-announcements — pre-mission "actors needed" announcement target.
  npcAnnouncementChannelId: "1348654909553250315",
  autopayDelayHours: 3.5,
  defaultImageUrl: "",
} as const;

async function readRaw(key: string): Promise<unknown> {
  try {
    const [row] = await db.select().from(botConfig).where(eq(botConfig.key, key));
    return row?.value;
  } catch (err) {
    logger.warn({ err, key }, "mission config read failed");
    return undefined;
  }
}

async function readString(key: string, fallback: string): Promise<string> {
  const v = await readRaw(key);
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return fallback;
}

async function readNumber(key: string, fallback: number): Promise<number> {
  const v = await readRaw(key);
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return fallback;
}

/**
 * Mission external-effects gate. Live only when BOTH the global master switch
 * (`master_live_mode`) and the missions override (`missions_live_mode`) are
 * explicitly Live. Anything else is Test mode — fail-safe. Delegates to the
 * shared site-wide live-mode module so missions stay consistent with every
 * other gated system.
 */
export async function isMissionsLiveMode(): Promise<boolean> {
  return isSystemLive("missions");
}

export interface MissionExternalContext {
  live: boolean;
  bankingChannelId: string;
  npcSpendingChannelId: string;
  npcAnnouncementChannelId: string;
  defaultImageUrl: string;
  autopayDelayMs: number;
}

/** Resolve the full external-effects context for a mission action. */
export async function getMissionContext(): Promise<MissionExternalContext> {
  const [live, bankingChannelId, npcSpendingChannelId, npcAnnouncementChannelId, defaultImageUrl, hours] =
    await Promise.all([
      isMissionsLiveMode(),
      readString(MISSION_CONFIG_KEYS.bankingChannel, MISSION_DEFAULTS.bankingChannelId),
      readString(MISSION_CONFIG_KEYS.npcSpendingChannel, MISSION_DEFAULTS.npcSpendingChannelId),
      readString(MISSION_CONFIG_KEYS.npcAnnouncementChannel, MISSION_DEFAULTS.npcAnnouncementChannelId),
      readString(MISSION_CONFIG_KEYS.defaultImage, MISSION_DEFAULTS.defaultImageUrl),
      readNumber(MISSION_CONFIG_KEYS.autopayDelayHours, MISSION_DEFAULTS.autopayDelayHours),
    ]);
  return {
    live,
    bankingChannelId,
    npcSpendingChannelId,
    npcAnnouncementChannelId,
    defaultImageUrl,
    autopayDelayMs: Math.round(hours * 60 * 60 * 1000),
  };
}
