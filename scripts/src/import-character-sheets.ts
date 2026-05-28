import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * Imports character sheets from a Discord forum channel.
 *
 * Each forum thread is treated as one character sheet:
 *   - Thread title format: "Character Name - username"
 *   - The OP message contains the labeled sheet body (Name:, Age:, etc.)
 *   - Additional messages in the thread may contain more images or updates
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run import-character-sheets -- --list-channels
 *   pnpm --filter @workspace/scripts run import-character-sheets -- --forum-channel-id <id>
 *
 * Flags:
 *   --forum-channel-id <id>     Required (or pass --forum-channel-ids).
 *   --forum-channel-ids a,b,c   Comma-separated list of forum channel ids.
 *   --list-channels             List all forum channels in the guild, then exit.
 *   --limit <n>                 Only process the first n threads per channel.
 *   --no-classify               Skip Anthropic image classification.
 *   --classify-concurrency <n>  Parallel image classification calls (default 4).
 *
 * Required env:
 *   DISCORD_BOT_TOKEN, DISCORD_GUILD_ID
 *
 * Optional env (for image classification):
 *   AI_INTEGRATIONS_ANTHROPIC_BASE_URL, AI_INTEGRATIONS_ANTHROPIC_API_KEY
 *
 * Output:
 *   scripts/output/character-sheets-preview.json
 *   scripts/output/character-sheets-preview.html
 *
 * This script is read-only against Discord and writes nothing to the database.
 * Use it to validate parser/classifier output before running the real import.
 */

const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const GUILD = process.env.DISCORD_GUILD_ID ?? "";

if (!TOKEN || !GUILD) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must be set.");
  process.exit(1);
}

// ---------- arg parsing ----------
const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const hasFlag = (name: string) => argv.includes(name);

// ---------- discord fetch with rate-limit handling ----------
async function discord<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bot ${TOKEN}` },
    });
    if (r.status === 429) {
      const retry = Number(r.headers.get("retry-after") ?? "1");
      await new Promise((res) => setTimeout(res, (retry + 0.2) * 1000));
      continue;
    }
    if (!r.ok) {
      throw new Error(`Discord ${path} -> ${r.status}: ${await r.text()}`);
    }
    return (await r.json()) as T;
  }
  throw new Error(`Discord ${path} rate-limited too many times`);
}

// ---------- list channels mode ----------
type Channel = {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
};

if (hasFlag("--list-channels")) {
  const channels = await discord<Channel[]>(`/guilds/${GUILD}/channels`);
  const forums = channels.filter((c) => c.type === 15);
  if (forums.length === 0) {
    console.log("No forum channels found in this guild.");
  } else {
    console.log("Forum channels in this guild:");
    for (const f of forums) console.log(`  ${f.id}   #${f.name}`);
  }
  process.exit(0);
}

const channelIds = (() => {
  const list = arg("--forum-channel-ids");
  if (list) return list.split(",").map((s) => s.trim()).filter(Boolean);
  const single = arg("--forum-channel-id");
  return single ? [single] : [];
})();
// NPC forums are imported the same way but their threads are stamped with
// kind="npc" so the directory + fixer UI can filter them. They are added
// to the channelIds set automatically — pass them only via the npc flag.
const npcChannelIds = (() => {
  const list = arg("--npc-forum-channel-ids");
  if (list) return new Set(list.split(",").map((s) => s.trim()).filter(Boolean));
  return new Set<string>();
})();
for (const id of npcChannelIds) {
  if (!channelIds.includes(id)) channelIds.push(id);
}
if (channelIds.length === 0) {
  console.error(
    "Pass --forum-channel-id <id>, --forum-channel-ids a,b,c, --npc-forum-channel-ids a,b, or --list-channels.",
  );
  process.exit(1);
}
const limit = arg("--limit") ? Number(arg("--limit")) : Infinity;
const noClassify = hasFlag("--no-classify");
const classifyConcurrency = arg("--classify-concurrency")
  ? Number(arg("--classify-concurrency"))
  : 4;
const applyToDb = hasFlag("--apply");
const apiBase = arg("--api-base") ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:5000";
const rehostConcurrency = arg("--rehost-concurrency")
  ? Number(arg("--rehost-concurrency"))
  : 4;

// ---------- threads ----------
type Thread = {
  id: string;
  name: string;
  parent_id?: string | null;
  thread_metadata?: {
    archived: boolean;
    archive_timestamp?: string;
  };
};

async function fetchAllThreads(forumId: string): Promise<Thread[]> {
  const all = new Map<string, Thread>();

  // Active threads are guild-scoped; filter by parent.
  const active = await discord<{ threads: Thread[] }>(
    `/guilds/${GUILD}/threads/active`,
  );
  for (const t of active.threads) {
    if (t.parent_id === forumId) all.set(t.id, t);
  }

  // Archived public threads are channel-scoped and paginated by archive_timestamp.
  let before: string | undefined;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ limit: "100" });
    if (before) q.set("before", before);
    const res = await discord<{ threads: Thread[]; has_more: boolean }>(
      `/channels/${forumId}/threads/archived/public?${q.toString()}`,
    );
    for (const t of res.threads) all.set(t.id, t);
    if (!res.has_more || res.threads.length === 0) break;
    const last = res.threads[res.threads.length - 1];
    before = last.thread_metadata?.archive_timestamp ?? undefined;
    if (!before) break;
  }

  return [...all.values()];
}

// ---------- title parsing ----------
function parseTitle(title: string): { name: string; username: string | null } {
  // Split on the LAST hyphen (regular, en-dash, or em-dash) with optional
  // surrounding whitespace. Tolerates "Name - user", "Name- user",
  // "Name -user", and "Name-user". Hyphens inside the character's name
  // are fine because we take the LAST separator.
  const sepRe = /\s*[-\u2013\u2014]\s*/g;
  const matches = [...title.matchAll(sepRe)];
  if (matches.length === 0) return { name: title.trim(), username: null };
  const last = matches[matches.length - 1];
  const idx = last.index!;
  return {
    name: title.slice(0, idx).trim(),
    username: title
      .slice(idx + last[0].length)
      .trim()
      .replace(/^@/, ""),
  };
}

// ---------- user resolution ----------
type DiscordUser = { id: string; username: string; global_name?: string };

const userCache = new Map<string, DiscordUser | null>();

async function resolveUser(username: string): Promise<DiscordUser | null> {
  if (!username) return null;
  const key = username.toLowerCase();
  if (userCache.has(key)) return userCache.get(key)!;
  let found: DiscordUser | null = null;
  try {
    const results = await discord<Array<{ user: DiscordUser }>>(
      `/guilds/${GUILD}/members/search?query=${encodeURIComponent(username)}&limit=10`,
    );
    found =
      results.find(
        (r) => r.user.username.toLowerCase() === key,
      )?.user ?? null;
  } catch (err) {
    console.warn(`  user lookup failed for ${username}: ${(err as Error).message}`);
  }
  userCache.set(key, found);
  return found;
}

// ---------- sheet body parser ----------
const SECTION_LABELS = [
  "Name",
  "Age",
  "Pronouns",
  "Occupation / Role in Night City",
  "Occupation",
  "Psychological Profile",
  "Physical Description",
  "Chrome / Implants",
  "Total Cyberware Points",
  "Skills / Talents / Abilities",
  "Skills",
  "Equipment / Armor / Weapons",
  "Equipment",
  "Backstory",
  "Known Affiliations",
  "Affiliations",
  "Reference Image(s)",
  "Reference Images",
  "RP Hooks",
  "Additional Notes",
];

// Allow leading whitespace AND any non-letter prefix (emoji, bullet, symbol)
// before the label, e.g. "🪪 Name:" or "💼 Occupation / Role in Night City:".
// JS regex with `u` flag lets us use \p{L} for any Unicode letter; we eat
// up to ~6 non-letter chars (most emoji are 1-3 code units).
const LABEL_RE = new RegExp(
  `^[^\\p{L}\\n]{0,8}(${SECTION_LABELS.map((l) =>
    l.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"),
  ).join("|")})\\s*:\\s*(.*)$`,
  "iu",
);

function parseSheet(text: string): {
  preamble: string;
  sections: Record<string, string>;
} {
  const sections: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let current: string | null = null;
  let buf: string[] = [];
  const preamble: string[] = [];
  const flush = () => {
    if (current) {
      const key = canonicalLabel(current);
      const prev = sections[key];
      const joined = buf.join("\n").trim();
      sections[key] = prev ? `${prev}\n${joined}`.trim() : joined;
    }
  };
  for (const line of lines) {
    const m = line.match(LABEL_RE);
    if (m) {
      flush();
      current = m[1];
      buf = [m[2] ?? ""];
    } else if (current) {
      buf.push(line);
    } else if (line.trim().length > 0) {
      preamble.push(line);
    }
  }
  flush();
  return { preamble: preamble.join("\n").trim(), sections };
}

// Canonicalize labels so "Occupation" and "Occupation / Role in Night City"
// don't both end up in the output. Same for Skills/Equipment/Affiliations/etc.
function canonicalLabel(label: string): string {
  const l = label.toLowerCase();
  if (l.startsWith("occupation")) return "Occupation";
  if (l.startsWith("psychological")) return "Psychological Profile";
  if (l.startsWith("physical")) return "Physical Description";
  if (l.startsWith("chrome")) return "Chrome / Implants";
  if (l.startsWith("total cyberware")) return "Total Cyberware Points";
  if (l.startsWith("skills")) return "Skills / Talents / Abilities";
  if (l.startsWith("equipment")) return "Equipment / Armor / Weapons";
  if (l.startsWith("backstory")) return "Backstory";
  if (l.startsWith("known affiliations") || l.startsWith("affiliations"))
    return "Known Affiliations";
  if (l.startsWith("reference")) return "Reference Images";
  if (l.startsWith("rp hooks")) return "RP Hooks";
  if (l.startsWith("additional")) return "Additional Notes";
  if (l === "name") return "Name";
  if (l === "age") return "Age";
  if (l === "pronouns") return "Pronouns";
  return label;
}

// ---------- messages ----------
type Attachment = {
  id: string;
  url: string;
  proxy_url?: string;
  filename: string;
  content_type?: string;
  width?: number;
  height?: number;
};
type Embed = {
  image?: { url: string; proxy_url?: string };
  thumbnail?: { url: string; proxy_url?: string };
};
type Message = {
  id: string;
  author: { id: string; username: string };
  content: string;
  attachments: Attachment[];
  embeds: Embed[];
  timestamp: string;
  // Discord message forwarding (introduced 2024): the original message's
  // content / attachments / embeds live inside message_snapshots[*].message,
  // and the outer message has empty content+attachments+embeds. We have to
  // dive into snapshots to find images attached to a forwarded post.
  message_snapshots?: Array<{
    message: {
      content?: string;
      attachments?: Attachment[];
      embeds?: Embed[];
    };
  }>;
};

async function fetchAllMessages(threadId: string): Promise<Message[]> {
  const messages: Message[] = [];
  let before: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ limit: "100" });
    if (before) q.set("before", before);
    const batch = await discord<Message[]>(
      `/channels/${threadId}/messages?${q.toString()}`,
    );
    if (batch.length === 0) break;
    messages.push(...batch);
    if (batch.length < 100) break;
    before = batch[batch.length - 1].id;
  }
  // Discord returns newest-first; flip to chronological.
  messages.sort((a, b) => a.id.localeCompare(b.id));
  return messages;
}

// ---------- image classification ----------
type ImgKind = "stats" | "portrait" | "other";

let classifyImage: ((url: string) => Promise<ImgKind>) | null = null;

if (!noClassify) {
  const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  if (baseURL && apiKey) {
    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      // maxRetries: 1 so a 429 doesn't trigger 10-minute exponential backoff.
      // Per-call timeout enforced via AbortController below.
      const client = new Anthropic({ baseURL, apiKey, maxRetries: 1 });
      const CLASSIFY_TIMEOUT_MS = 25_000;
      classifyImage = async (url: string) => {
        try {
          // 1. Download image with hard 15s timeout.
          const dlCtl = new AbortController();
          const dlTimer = setTimeout(() => dlCtl.abort(), 15_000);
          let buf: Buffer;
          let mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
          try {
            const imgRes = await fetch(url, { signal: dlCtl.signal });
            if (!imgRes.ok) throw new Error(`download ${imgRes.status}`);
            const ct = imgRes.headers.get("content-type") ?? "image/png";
            mediaType = (
              ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(ct)
                ? ct
                : "image/png"
            ) as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
            buf = Buffer.from(await imgRes.arrayBuffer());
          } finally {
            clearTimeout(dlTimer);
          }
          // 2. Skip if too large for the Vertex/Anthropic image cap.
          if (buf.length > 4_500_000) return "other";
          const b64 = buf.toString("base64");
          // 3. Classify with hard 25s timeout via AbortController.
          const apiCtl = new AbortController();
          const apiTimer = setTimeout(
            () => apiCtl.abort(),
            CLASSIFY_TIMEOUT_MS,
          );
          let resp;
          try {
            resp = await client.messages.create(
              {
                model: "claude-haiku-4-5",
                max_tokens: 16,
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "image",
                        source: {
                          type: "base64",
                          media_type: mediaType,
                          data: b64,
                        },
                      },
                      {
                        type: "text",
                        text: 'This image is from a character sheet for a Cyberpunk roleplay community. Classify it as exactly one of: STATS, PORTRAIT, OTHER. STATS = a VRChat or game-engine performance/stats panel showing labels like "DOWNLOAD SIZE", "TEXTURE MEMORY", "TRIANGLES", "BONES", "PHYSBONE", "MATERIAL SLOTS", "MESHES". PORTRAIT = a screenshot of a character avatar, outfit, or face. OTHER = anything else (logos, memes, maps, equipment shots). Reply with one word only.',
                      },
                    ],
                  },
                ],
              },
              { signal: apiCtl.signal, timeout: CLASSIFY_TIMEOUT_MS },
            );
          } finally {
            clearTimeout(apiTimer);
          }
          const block = resp.content[0];
          const text = block && block.type === "text" ? block.text : "";
          const up = text.trim().toUpperCase();
          if (up.startsWith("STATS")) return "stats";
          if (up.startsWith("PORTRAIT")) return "portrait";
          return "other";
        } catch (err) {
          // Silent fallback to "other" per the user's preference — they'll
          // hand-classify the rare failures later.
          return "other";
        }
      };
      console.log("Image classification: ENABLED (claude-haiku-4-5)");
    } catch (err) {
      console.warn(
        `Image classification disabled: failed to load SDK: ${(err as Error).message}`,
      );
    }
  } else {
    console.log(
      "Image classification: DISABLED (AI_INTEGRATIONS_ANTHROPIC_* env vars not set)",
    );
  }
}

// ---------- main ----------
type ImageRecord = {
  url: string;
  proxyUrl?: string;
  filename: string;
  width?: number;
  height?: number;
  fromMessageId: string;
  kind: ImgKind | "unclassified";
};

type ThreadRecord = {
  threadId: string;
  threadTitle: string;
  sourceChannelId: string;
  sourceChannelName: string;
  archived: boolean;
  parsedName: string;
  parsedUsername: string | null;
  resolvedDiscordId: string | null;
  resolvedDisplayName: string | null;
  posterUsername: string;
  sheet: { preamble: string; sections: Record<string, string> } | null;
  images: ImageRecord[];
  warnings: string[];
};

// Simple bounded-concurrency parallel map.
async function pMapBounded<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function extractImages(messages: Message[]): ImageRecord[] {
  const out: ImageRecord[] = [];
  const pushAttachment = (a: Attachment, messageId: string) => {
    if (
      (a.content_type ?? "").startsWith("image/") ||
      /\.(png|jpe?g|gif|webp)$/i.test(a.filename)
    ) {
      out.push({
        url: a.url,
        proxyUrl: a.proxy_url,
        filename: a.filename,
        width: a.width,
        height: a.height,
        fromMessageId: messageId,
        kind: "unclassified",
      });
    }
  };
  const pushEmbed = (e: Embed, messageId: string) => {
    const img = e.image ?? e.thumbnail;
    if (img?.url) {
      out.push({
        url: img.url,
        proxyUrl: img.proxy_url,
        filename: img.url.split("/").pop()?.split("?")[0] ?? "embed",
        fromMessageId: messageId,
        kind: "unclassified",
      });
    }
  };
  for (const m of messages) {
    for (const a of m.attachments) pushAttachment(a, m.id);
    for (const e of m.embeds) pushEmbed(e, m.id);
    // Forwarded messages: dive into snapshots.
    for (const snap of m.message_snapshots ?? []) {
      for (const a of snap.message.attachments ?? []) pushAttachment(a, m.id);
      for (const e of snap.message.embeds ?? []) pushEmbed(e, m.id);
    }
  }
  return out;
}

// Cache channel names for nicer output.
const channelNameById = new Map<string, string>();
{
  const allChannels = await discord<Channel[]>(`/guilds/${GUILD}/channels`);
  for (const c of allChannels) channelNameById.set(c.id, c.name);
}

const records: ThreadRecord[] = [];

for (const channelId of channelIds) {
  const channelName = channelNameById.get(channelId) ?? channelId;
  console.log(
    `\nFetching threads in #${channelName} (${channelId})...`,
  );
  const threads = (await fetchAllThreads(channelId)).slice(0, limit);
  console.log(`Found ${threads.length} thread(s) in #${channelName}.`);

  let i = 0;
  for (const t of threads) {
    i += 1;
    const tag = `[#${channelName} ${i}/${threads.length}]`;
    process.stdout.write(`${tag} ${t.name} ... `);
    const warnings: string[] = [];
    const { name, username } = parseTitle(t.name);
    if (!username) warnings.push("Could not parse username from title");

    let resolved: DiscordUser | null = null;
    if (username) {
      resolved = await resolveUser(username);
      if (!resolved)
        warnings.push(
          `Username "${username}" not found in guild (unclaimed)`,
        );
    }

    let messages: Message[] = [];
    try {
      messages = await fetchAllMessages(t.id);
    } catch (err) {
      warnings.push(`Failed to fetch messages: ${(err as Error).message}`);
    }
    const opMsg = messages[0];
    const sheet = opMsg ? parseSheet(opMsg.content) : null;
    if (!opMsg) warnings.push("No OP message");
    else if (sheet && Object.keys(sheet.sections).length < 3)
      warnings.push(
        `Only ${Object.keys(sheet.sections).length} labeled section(s) parsed`,
      );

    const images = extractImages(messages);

    if (classifyImage && images.length > 0) {
      const classifier = classifyImage;
      await pMapBounded(
        images,
        async (img) => {
          img.kind = await classifier(img.url);
        },
        classifyConcurrency,
      );
    }

    records.push({
      threadId: t.id,
      threadTitle: t.name,
      sourceChannelId: channelId,
      sourceChannelName: channelName,
      archived: !!t.thread_metadata?.archived,
      parsedName: name,
      parsedUsername: username,
      resolvedDiscordId: resolved?.id ?? null,
      resolvedDisplayName: resolved?.global_name ?? resolved?.username ?? null,
      posterUsername: opMsg?.author.username ?? "(unknown)",
      sheet,
      images,
      warnings,
    });

    const stats = images.filter((im) => im.kind === "stats").length;
    const ports = images.filter((im) => im.kind === "portrait").length;
    console.log(
      `${resolved ? "linked" : "unclaimed"}, ${images.length} img (${ports}p/${stats}s), ${warnings.length} warn`,
    );
  }
}

// ---------- output ----------
const outDir = resolve(import.meta.dirname, "..", "output");
mkdirSync(outDir, { recursive: true });
const jsonPath = resolve(outDir, "character-sheets-preview.json");
const htmlPath = resolve(outDir, "character-sheets-preview.html");

writeFileSync(jsonPath, JSON.stringify(records, null, 2));

const summary = {
  total: records.length,
  linked: records.filter((r) => r.resolvedDiscordId).length,
  unclaimed: records.filter((r) => !r.resolvedDiscordId).length,
  withWarnings: records.filter((r) => r.warnings.length > 0).length,
  totalImages: records.reduce((s, r) => s + r.images.length, 0),
  statsImages: records.reduce(
    (s, r) => s + r.images.filter((i) => i.kind === "stats").length,
    0,
  ),
  portraitImages: records.reduce(
    (s, r) => s + r.images.filter((i) => i.kind === "portrait").length,
    0,
  ),
};

function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Character Sheet Import Preview</title>
<style>
  body { font-family: ui-monospace, Menlo, monospace; background: #0d0e12; color: #ccd; padding: 24px; line-height: 1.45; }
  h1, h2 { color: #6cf; }
  .summary { background: #14161d; padding: 16px; border-radius: 8px; margin-bottom: 24px; }
  .summary b { color: #6cf; }
  .thread { border: 1px solid #222; border-radius: 8px; padding: 16px; margin-bottom: 16px; background: #14161d; }
  .thread.unclaimed { border-left: 4px solid #c4a; }
  .thread.warn { border-left: 4px solid #fa3; }
  .meta { color: #889; font-size: 12px; margin-bottom: 8px; }
  .meta b { color: #ccd; }
  .warn { color: #fa3; font-size: 13px; }
  .section { margin: 8px 0; }
  .section-label { color: #6cf; font-weight: bold; }
  .section-body { white-space: pre-wrap; color: #ddd; margin-left: 16px; }
  .images { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .img { border: 1px solid #333; border-radius: 4px; padding: 4px; background: #0a0b0f; }
  .img img { display: block; max-width: 220px; max-height: 220px; }
  .img .kind { font-size: 11px; padding: 2px 6px; border-radius: 3px; display: inline-block; margin-top: 4px; }
  .kind.stats { background: #4a2; color: #000; }
  .kind.portrait { background: #6cf; color: #000; }
  .kind.other { background: #555; color: #ccc; }
  .kind.unclassified { background: #333; color: #999; }
  details { margin: 8px 0; }
  summary { cursor: pointer; color: #6cf; }
</style></head>
<body>
<h1>Character Sheet Import Preview</h1>
<div class="summary">
  <div><b>${summary.total}</b> threads scanned</div>
  <div><b>${summary.linked}</b> linked to a guild member, <b>${summary.unclaimed}</b> unclaimed</div>
  <div><b>${summary.withWarnings}</b> threads with warnings</div>
  <div><b>${summary.totalImages}</b> images total — <b>${summary.portraitImages}</b> classified as portraits, <b>${summary.statsImages}</b> classified as stats</div>
</div>
${records
  .map((r) => {
    const cls = !r.resolvedDiscordId
      ? "thread unclaimed"
      : r.warnings.length > 0
        ? "thread warn"
        : "thread";
    const sectionsHtml = r.sheet
      ? Object.entries(r.sheet.sections)
          .map(
            ([k, v]) =>
              `<div class="section"><div class="section-label">${esc(k)}</div><div class="section-body">${esc(v)}</div></div>`,
          )
          .join("")
      : "<div class='warn'>(no OP message)</div>";
    const imagesHtml = r.images
      .map(
        (i) =>
          `<div class="img"><a href="${esc(i.url)}" target="_blank"><img src="${esc(i.url)}" alt="${esc(i.filename)}" loading="lazy"></a><br><span class="kind ${i.kind}">${i.kind}</span></div>`,
      )
      .join("");
    return `<div class="${cls}">
  <h2>${esc(r.threadTitle)}</h2>
  <div class="meta">
    Parsed: <b>${esc(r.parsedName)}</b> — username <b>${esc(r.parsedUsername ?? "(none)")}</b><br>
    Resolved: <b>${esc(r.resolvedDisplayName ?? "UNCLAIMED")}</b> (id: ${esc(r.resolvedDiscordId ?? "—")})<br>
    From: <b>#${esc(r.sourceChannelName)}</b> • Posted by: ${esc(r.posterUsername)} • Thread id: ${esc(r.threadId)}${r.archived ? " • archived" : ""}
  </div>
  ${r.warnings.map((w) => `<div class="warn">! ${esc(w)}</div>`).join("")}
  ${r.sheet?.preamble ? `<details><summary>Pre-amble (unlabeled lines above first section)</summary><div class="section-body">${esc(r.sheet.preamble)}</div></details>` : ""}
  ${sectionsHtml}
  <div class="images">${imagesHtml}</div>
</div>`;
  })
  .join("\n")}
</body></html>`;

writeFileSync(htmlPath, html);

console.log("");
console.log("Wrote:");
console.log(`  ${jsonPath}`);
console.log(`  ${htmlPath}`);
console.log("");
console.log(
  `Summary: ${summary.linked} linked, ${summary.unclaimed} unclaimed, ${summary.withWarnings} with warnings, ${summary.totalImages} images (${summary.portraitImages} portraits, ${summary.statsImages} stats).`,
);

// ============================================================
// --apply mode: rehost images to object storage and upsert
// character rows by importedFromThreadId. Idempotent: re-running
// updates existing rows in place rather than duplicating.
// ============================================================
if (applyToDb) {
  console.log("\n--apply mode: rehosting images and writing to DB...");
  const { db, characters, users, characterStatus } = await import("@workspace/db");
  const { eq, sql } = await import("drizzle-orm");

  // Rehost one Discord CDN image -> /objects/<id> on our bucket. Returns
  // the stored path, or null on failure (caller drops the image).
  async function rehostImage(url: string, filename: string): Promise<string | null> {
    try {
      const dlCtl = new AbortController();
      const dlTimer = setTimeout(() => dlCtl.abort(), 20_000);
      let buf: Buffer;
      let contentType: string;
      try {
        const r = await fetch(url, { signal: dlCtl.signal });
        if (!r.ok) return null;
        contentType = r.headers.get("content-type") ?? "image/png";
        buf = Buffer.from(await r.arrayBuffer());
      } finally {
        clearTimeout(dlTimer);
      }
      if (buf.length === 0) return null;
      // Request a presigned upload URL from our API server.
      const reqRes = await fetch(`${apiBase}/api/storage/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: filename, size: buf.length, contentType }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!reqRes.ok) {
        console.warn(`  request-url failed (${reqRes.status}) for ${filename}`);
        return null;
      }
      const { uploadURL, objectPath } = (await reqRes.json()) as {
        uploadURL: string;
        objectPath: string;
      };
      // PUT the image bytes to the presigned URL.
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: buf,
        signal: AbortSignal.timeout(60_000),
      });
      if (!putRes.ok) {
        console.warn(`  PUT failed (${putRes.status}) for ${filename}`);
        return null;
      }
      return objectPath;
    } catch (err) {
      console.warn(`  rehost error for ${filename}: ${(err as Error).message}`);
      return null;
    }
  }

  // For each character record:
  //   1) Ensure a User row exists for the resolved Discord owner (if any).
  //   2) Rehost portraits + stats images in parallel (bounded).
  //   3) Upsert characters row by importedFromThreadId.
  //   4) Insert characterStatus row for new characters.
  let applied = 0;
  let skipped = 0;
  let mergedInPlace = 0;
  for (const r of records) {
    const sectionCount = r.sheet ? Object.keys(r.sheet.sections).length : 0;
    const hasContent = sectionCount > 0 || (r.sheet?.preamble?.length ?? 0) > 0 || r.images.length > 0;
    if (!hasContent) {
      skipped++;
      continue;
    }
    // Owner resolution: if the Discord user is in the guild, ensure a users
    // row exists. If not, ownerId stays null (unclaimed). User id matches
    // the OAuth+prod-importer convention: raw discord id, not `discord:<id>`.
    let ownerId: string | null = null;
    if (r.resolvedDiscordId) {
      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.discordId, r.resolvedDiscordId));
      if (existing) {
        ownerId = existing.id;
      } else {
        // Best-effort placeholder; the user will hydrate full fields on
        // their first OAuth login. discordId is the lookup key.
        await db
          .insert(users)
          .values({
            id: r.resolvedDiscordId,
            discordId: r.resolvedDiscordId,
            username: r.parsedUsername ?? r.resolvedDisplayName ?? "unknown",
            globalName: r.resolvedDisplayName,
          })
          .onConflictDoNothing();
        ownerId = r.resolvedDiscordId;
      }
    }

    // Rehost portraits and stats images (bounded concurrency).
    const portraits = r.images.filter((i) => i.kind === "portrait");
    const statsImgs = r.images.filter((i) => i.kind === "stats");
    const portraitUrls: string[] = [];
    const statsImageUrls: string[] = [];
    await pMapBounded(
      portraits,
      async (img) => {
        const p = await rehostImage(img.url, img.filename);
        if (p) portraitUrls.push(p);
      },
      rehostConcurrency,
    );
    await pMapBounded(
      statsImgs,
      async (img) => {
        const p = await rehostImage(img.url, img.filename);
        if (p) statsImageUrls.push(p);
      },
      rehostConcurrency,
    );

    // Pick a "primary" portrait so legacy single-portrait UIs still work.
    const primaryPortrait = portraitUrls[0] ?? null;

    // Extract a couple of convenience fields out of parsed sections.
    // Falls back to the raw OP preamble when the sheet has no labeled
    // sections (some old threads are free-form prose or image-only).
    const sections = r.sheet?.sections ?? {};
    const archetype =
      (sections["Occupation"] ?? sections["Occupation / Role in Night City"] ?? "")
        .split(/\r?\n/)[0]
        ?.trim()
        .slice(0, 200) || null;
    const background =
      (sections["Backstory"] ?? sections["Psychological Profile"] ?? r.sheet?.preamble ?? null)
        ?.toString()
        .trim()
        .slice(0, 8000) || null;

    const isRetired = r.sourceChannelName.toLowerCase().includes("retired");

    const values = {
      ownerId,
      claimed: ownerId !== null,
      legacyDiscordUsername: r.parsedUsername,
      name: r.parsedName.slice(0, 64),
      kind: (npcChannelIds.has(r.sourceChannelId) ? "npc" : "pc") as "pc" | "npc",
      archetype,
      background,
      portraitUrl: primaryPortrait,
      portraitUrls,
      statsImageUrls,
      sheetData: r.sheet,
      importedFromThreadId: r.threadId,
      importedFromChannelName: r.sourceChannelName,
      discordChannelId: r.threadId,
      approved: true,
      archived: isRetired,
      archivedAt: isRetired ? new Date() : null,
    };

    // Dedupe against rows the prod-DB importer created earlier. Those rows
    // have no importedFromThreadId, only (ownerId, name). If we find one,
    // enrich it in place rather than inserting a duplicate row that would
    // orphan wallet/inventory/housing data already attached to it.
    let existing:
      | {
          id: number;
          portraitUrl: string | null;
          portraitUrls: string[] | null;
          statsImageUrls: string[] | null;
        }
      | undefined;
    if (ownerId) {
      const dupes = await db
        .select({
          id: characters.id,
          importedFromThreadId: characters.importedFromThreadId,
          portraitUrl: characters.portraitUrl,
          portraitUrls: characters.portraitUrls,
          statsImageUrls: characters.statsImageUrls,
        })
        .from(characters)
        .where(
          sql`${characters.ownerId} = ${ownerId} and lower(${characters.name}) = lower(${values.name})`,
        );
      existing = dupes.find((d) => !d.importedFromThreadId);
    } else if (values.kind === "npc") {
      // NPCs have no owner. The cyberware-xlsx importer seeds kind='npc'
      // rows with ownerId=null and no importedFromThreadId; merge the
      // Discord forum thread into that row by name so we don't double up.
      const dupes = await db
        .select({
          id: characters.id,
          importedFromThreadId: characters.importedFromThreadId,
          portraitUrl: characters.portraitUrl,
          portraitUrls: characters.portraitUrls,
          statsImageUrls: characters.statsImageUrls,
        })
        .from(characters)
        .where(
          sql`${characters.kind} = 'npc' and ${characters.ownerId} is null and lower(${characters.name}) = lower(${values.name})`,
        );
      existing = dupes.find((d) => !d.importedFromThreadId);
    }

    let inserted: { id: number } | undefined;
    if (existing) {
      // Merge in JS so we never clobber prior portraits the player may have
      // hand-curated. The new arrays only land when the existing row is empty.
      const mergedPortraitUrls =
        existing.portraitUrls && existing.portraitUrls.length > 0
          ? existing.portraitUrls
          : values.portraitUrls;
      const mergedStatsUrls =
        existing.statsImageUrls && existing.statsImageUrls.length > 0
          ? existing.statsImageUrls
          : values.statsImageUrls;
      const [u] = await db
        .update(characters)
        .set({
          legacyDiscordUsername: values.legacyDiscordUsername,
          archetype: values.archetype,
          background: values.background,
          portraitUrl: existing.portraitUrl ?? values.portraitUrl,
          portraitUrls: mergedPortraitUrls,
          statsImageUrls: mergedStatsUrls,
          sheetData: values.sheetData,
          importedFromThreadId: values.importedFromThreadId,
          importedFromChannelName: values.importedFromChannelName,
          discordChannelId: values.discordChannelId,
          archived: values.archived,
          kind: values.kind,
          approved: true,
        })
        .where(eq(characters.id, existing.id))
        .returning({ id: characters.id });
      inserted = u;
      mergedInPlace++;
    } else {
      const [u] = await db
        .insert(characters)
        .values(values)
        .onConflictDoUpdate({
          target: characters.importedFromThreadId,
          set: {
            // Never clobber an existing owner on rerun: an admin may have
            // assigned the character since the first import. Only adopt the
            // resolved owner if the row currently has none.
            ownerId: sql`coalesce(${characters.ownerId}, excluded.owner_id)`,
            claimed: sql`(${characters.ownerId} is not null) or excluded.claimed`,
            legacyDiscordUsername: values.legacyDiscordUsername,
            name: values.name,
            archetype: values.archetype,
            background: values.background,
            portraitUrl: sql`coalesce(${characters.portraitUrl}, excluded.portrait_url)`,
            portraitUrls: sql`case when array_length(${characters.portraitUrls}, 1) is null or array_length(${characters.portraitUrls}, 1) = 0 then excluded.portrait_urls else ${characters.portraitUrls} end`,
            statsImageUrls: sql`case when array_length(${characters.statsImageUrls}, 1) is null or array_length(${characters.statsImageUrls}, 1) = 0 then excluded.stats_image_urls else ${characters.statsImageUrls} end`,
            sheetData: values.sheetData,
            importedFromChannelName: values.importedFromChannelName,
            archived: values.archived,
          },
        })
        .returning({ id: characters.id });
      inserted = u;
    }

    // Ensure a characterStatus row exists.
    if (inserted) {
      await db
        .insert(characterStatus)
        .values({ characterId: inserted.id })
        .onConflictDoNothing();
    }

    applied++;
    if (applied % 20 === 0) {
      console.log(`  applied ${applied}/${records.length}...`);
    }
  }
  console.log(
    `\nApply complete: ${applied} upserted (${mergedInPlace} merged into existing prod-import rows), ${skipped} skipped (no content).`,
  );
}
