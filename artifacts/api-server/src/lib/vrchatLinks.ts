import { db, botConfig, vrchatLinks } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { DISCORD_BOT_TOKEN } from "./discord";

// ---------------------------------------------------------------------------
// Discord <-> VRChat username linking.
//
// The #vrchat-username channel is a self-service registry: each player posts a
// link to their own VRChat profile, so the message AUTHOR is the Discord
// identity and the message body + unfurled embed carry the VRChat profile.
//   author.id / username / global_name -> Discord identity
//   content URL  https://vrchat.com/home/user/usr_xxxx -> VRChat user id
//   embed.title  "Voillah" -> VRChat display name
//
// Scanning is a read-only Discord operation (no live data is mutated on
// Discord), so it is NOT subject to the Test/Live gate. It only writes our
// local vrchat_links table, keyed by Discord id so a re-scan upserts the
// latest post per player.
// ---------------------------------------------------------------------------
const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_VRCHAT_CHANNEL_ID = "1382703020332290089";

export const VRCHAT_CONFIG_KEYS = {
  channel: "vrchat_channel_id",
} as const;

const VRCHAT_URL_RE = /https?:\/\/vrchat\.com\/home\/user\/(usr_[0-9a-fA-F-]+)/;

interface DiscordMessage {
  id: string;
  timestamp: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  embeds?: { title?: string | null; url?: string | null; description?: string | null }[];
}

export interface ParsedVrchatLink {
  discordId: string;
  discordUsername: string;
  discordGlobalName: string | null;
  vrchatUserId: string;
  vrchatUsername: string;
  vrchatUrl: string;
  sourceMessageId: string;
  sourcePostedAt: Date;
}

export interface VrchatScanResult {
  channelId: string;
  scannedMessages: number;
  matchedMessages: number;
  linkedPlayers: number;
}

async function getVrchatChannelId(): Promise<string> {
  try {
    const [row] = await db.select().from(botConfig).where(eq(botConfig.key, VRCHAT_CONFIG_KEYS.channel));
    if (typeof row?.value === "string" && row.value.trim().length > 0) return row.value.trim();
  } catch (err) {
    logger.warn({ err }, "vrchat channel id read failed; using default");
  }
  return DEFAULT_VRCHAT_CHANNEL_ID;
}

/** Extract the VRChat link from a single message, or null if it carries none. */
export function parseVrchatMessage(m: DiscordMessage): ParsedVrchatLink | null {
  const fromContent = m.content?.match(VRCHAT_URL_RE)?.[1];
  const fromEmbed = (m.embeds ?? [])
    .map((e) => e.url?.match(VRCHAT_URL_RE)?.[1])
    .find((x): x is string => !!x);
  const vrchatUserId = fromContent ?? fromEmbed;
  if (!vrchatUserId) return null;

  const vrchatUrl = `https://vrchat.com/home/user/${vrchatUserId}`;
  // Prefer the embed that unfurled this exact profile; fall back to the first.
  const embed =
    (m.embeds ?? []).find((e) => e.url?.includes(vrchatUserId)) ?? (m.embeds ?? [])[0];
  let vrchatUsername = embed?.title?.trim() || undefined;
  if (!vrchatUsername && embed?.description) {
    vrchatUsername = embed.description.replace(/^VRChat user\s+/i, "").trim() || undefined;
  }
  if (!vrchatUsername) vrchatUsername = m.author.global_name?.trim() || m.author.username;

  return {
    discordId: m.author.id,
    discordUsername: m.author.username,
    discordGlobalName: m.author.global_name?.trim() || null,
    vrchatUserId,
    vrchatUsername,
    vrchatUrl,
    sourceMessageId: m.id,
    sourcePostedAt: new Date(m.timestamp),
  };
}

async function fetchMessagePage(channelId: string, before?: string): Promise<DiscordMessage[]> {
  const url = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
  url.searchParams.set("limit", "100");
  if (before) url.searchParams.set("before", before);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 5) * 1000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Discord messages fetch failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as DiscordMessage[];
  }
  throw new Error("Discord messages fetch failed: rate limited after retries");
}

/**
 * Scrape the whole #vrchat-username channel and upsert one row per Discord
 * player (newest post wins). Returns counts for the admin UI.
 */
export async function scanVrchatChannel(): Promise<VrchatScanResult> {
  if (!DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN is not configured");
  const channelId = await getVrchatChannelId();

  let scannedMessages = 0;
  let matchedMessages = 0;
  // Messages arrive newest-first; the first parsed link per Discord id is the
  // most recent one, which is what we keep.
  const latestByDiscordId = new Map<string, ParsedVrchatLink>();

  let before: string | undefined;
  for (let page = 0; page < 200; page++) {
    const messages = await fetchMessagePage(channelId, before);
    if (messages.length === 0) break;
    scannedMessages += messages.length;
    for (const m of messages) {
      const parsed = parseVrchatMessage(m);
      if (!parsed) continue;
      matchedMessages++;
      if (!latestByDiscordId.has(parsed.discordId)) latestByDiscordId.set(parsed.discordId, parsed);
    }
    before = messages[messages.length - 1]!.id;
    if (messages.length < 100) break;
  }

  for (const link of latestByDiscordId.values()) {
    await db
      .insert(vrchatLinks)
      .values({
        discordId: link.discordId,
        discordUsername: link.discordUsername,
        discordGlobalName: link.discordGlobalName,
        vrchatUserId: link.vrchatUserId,
        vrchatUsername: link.vrchatUsername,
        vrchatUrl: link.vrchatUrl,
        sourceMessageId: link.sourceMessageId,
        sourcePostedAt: link.sourcePostedAt,
      })
      .onConflictDoUpdate({
        target: vrchatLinks.discordId,
        set: {
          discordUsername: link.discordUsername,
          discordGlobalName: link.discordGlobalName,
          vrchatUserId: link.vrchatUserId,
          vrchatUsername: link.vrchatUsername,
          vrchatUrl: link.vrchatUrl,
          sourceMessageId: link.sourceMessageId,
          sourcePostedAt: link.sourcePostedAt,
          updatedAt: new Date(),
        },
      });
  }

  logger.info(
    { channelId, scannedMessages, matchedMessages, linkedPlayers: latestByDiscordId.size },
    "vrchat channel scan complete",
  );
  return { channelId, scannedMessages, matchedMessages, linkedPlayers: latestByDiscordId.size };
}
