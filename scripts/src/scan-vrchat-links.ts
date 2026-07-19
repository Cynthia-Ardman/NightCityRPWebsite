// One-off: scrape the #vrchat-username self-service channel and upsert
// Discord<->VRChat links into vrchat_links. Read-only on Discord.
// Usage: tsx src/scan-vrchat-links.ts [--target=live]
import pg from "pg";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is not set");
  process.exit(1);
}
const target = process.argv.includes("--target=live") ? "live" : "dev";
const targetUrl = () => {
  if (target === "live") {
    if (process.env.IMPORT_TARGET !== "prod") {
      console.error("refusing live target without IMPORT_TARGET=prod");
      process.exit(1);
    }
    const u = process.env.LIVE_PROD_DATABASE_URL;
    if (!u) {
      console.error("LIVE_PROD_DATABASE_URL is not set");
      process.exit(1);
    }
    return u;
  }
  return process.env.DATABASE_URL!;
};

const DISCORD_API = "https://discord.com/api/v10";
const CHANNEL_ID = process.env.VRCHAT_CHANNEL_ID ?? "1382703020332290089";
const VRCHAT_URL_RE = /https?:\/\/vrchat\.com\/home\/user\/(usr_[0-9a-fA-F-]+)/;

interface DiscordMessage {
  id: string;
  timestamp: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  embeds?: { title?: string | null; url?: string | null; description?: string | null }[];
}

async function fetchPage(before?: string): Promise<DiscordMessage[]> {
  const url = new URL(`${DISCORD_API}/channels/${CHANNEL_ID}/messages`);
  url.searchParams.set("limit", "100");
  if (before) url.searchParams.set("before", before);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 5) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Discord fetch failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as DiscordMessage[];
  }
  throw new Error("rate limited after retries");
}

function parse(m: DiscordMessage) {
  const fromContent = m.content?.match(VRCHAT_URL_RE)?.[1];
  const fromEmbed = (m.embeds ?? [])
    .map((e) => e.url?.match(VRCHAT_URL_RE)?.[1])
    .find((x): x is string => !!x);
  const vrchatUserId = fromContent ?? fromEmbed;
  if (!vrchatUserId) return null;
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
    vrchatUrl: `https://vrchat.com/home/user/${vrchatUserId}`,
    sourceMessageId: m.id,
    sourcePostedAt: new Date(m.timestamp),
  };
}

async function main() {
  let scanned = 0;
  let matched = 0;
  const latest = new Map<string, NonNullable<ReturnType<typeof parse>>>();
  let before: string | undefined;
  for (let page = 0; page < 200; page++) {
    const messages = await fetchPage(before);
    if (messages.length === 0) break;
    scanned += messages.length;
    for (const m of messages) {
      const p = parse(m);
      if (!p) continue;
      matched++;
      if (!latest.has(p.discordId)) latest.set(p.discordId, p);
    }
    before = messages[messages.length - 1]!.id;
    if (messages.length < 100) break;
  }
  console.log(`scanned ${scanned} messages, ${matched} matched, ${latest.size} players`);

  const client = new pg.Client({ connectionString: targetUrl() });
  await client.connect();
  try {
    let upserts = 0;
    for (const l of latest.values()) {
      await client.query(
        `INSERT INTO vrchat_links
           (discord_id, discord_username, discord_global_name, vrchat_user_id,
            vrchat_username, vrchat_url, source_message_id, source_posted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (discord_id) DO UPDATE SET
           discord_username = EXCLUDED.discord_username,
           discord_global_name = EXCLUDED.discord_global_name,
           vrchat_user_id = EXCLUDED.vrchat_user_id,
           vrchat_username = EXCLUDED.vrchat_username,
           vrchat_url = EXCLUDED.vrchat_url,
           source_message_id = EXCLUDED.source_message_id,
           source_posted_at = EXCLUDED.source_posted_at,
           updated_at = now()`,
        [
          l.discordId,
          l.discordUsername,
          l.discordGlobalName,
          l.vrchatUserId,
          l.vrchatUsername,
          l.vrchatUrl,
          l.sourceMessageId,
          l.sourcePostedAt,
        ],
      );
      upserts++;
    }
    console.log(`[${target}] upserted ${upserts} vrchat_links rows`);
  } catch (err) {
    console.error("scan failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
