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
 *   --forum-channel-id <id>   Required. The Discord forum channel id.
 *   --list-channels           List all forum channels in the guild, then exit.
 *   --limit <n>               Only process the first n threads (handy for testing).
 *   --no-classify             Skip Anthropic image classification.
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

const channelId = arg("--forum-channel-id");
if (!channelId) {
  console.error(
    "Pass --forum-channel-id <id>, or run with --list-channels to discover ids.",
  );
  process.exit(1);
}
const limit = arg("--limit") ? Number(arg("--limit")) : Infinity;
const noClassify = hasFlag("--no-classify");

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
      const client = new Anthropic({ baseURL, apiKey });
      classifyImage = async (url: string) => {
        try {
          const imgRes = await fetch(url);
          if (!imgRes.ok) throw new Error(`download ${imgRes.status}`);
          const ct = imgRes.headers.get("content-type") ?? "image/png";
          const mediaType = (
            ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(ct)
              ? ct
              : "image/png"
          ) as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
          const buf = Buffer.from(await imgRes.arrayBuffer());
          // Skip anything over ~4MB to keep request size sane; classifier
          // doesn't need full resolution to tell a stats panel from a portrait.
          if (buf.length > 4 * 1024 * 1024) return "other";
          const b64 = buf.toString("base64");
          const resp = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 16,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: mediaType, data: b64 },
                  },
                  {
                    type: "text",
                    text: 'This image is from a character sheet for a Cyberpunk roleplay community. Classify it as exactly one of: STATS, PORTRAIT, OTHER. STATS = a VRChat or game-engine performance/stats panel showing labels like "DOWNLOAD SIZE", "TEXTURE MEMORY", "TRIANGLES", "BONES", "PHYSBONE", "MATERIAL SLOTS", "MESHES". PORTRAIT = a screenshot of a character avatar, outfit, or face. OTHER = anything else (logos, memes, maps, equipment shots). Reply with one word only.',
                  },
                ],
              },
            ],
          });
          const block = resp.content[0];
          const text =
            block && block.type === "text" ? block.text : "";
          const up = text.trim().toUpperCase();
          if (up.startsWith("STATS")) return "stats";
          if (up.startsWith("PORTRAIT")) return "portrait";
          return "other";
        } catch (err) {
          console.warn(
            `  classify failed for ${url}: ${(err as Error).message}`,
          );
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

function extractImages(messages: Message[]): ImageRecord[] {
  const out: ImageRecord[] = [];
  for (const m of messages) {
    for (const a of m.attachments) {
      if ((a.content_type ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(a.filename)) {
        out.push({
          url: a.url,
          proxyUrl: a.proxy_url,
          filename: a.filename,
          width: a.width,
          height: a.height,
          fromMessageId: m.id,
          kind: "unclassified",
        });
      }
    }
    for (const e of m.embeds) {
      const img = e.image ?? e.thumbnail;
      if (img?.url) {
        out.push({
          url: img.url,
          proxyUrl: img.proxy_url,
          filename: img.url.split("/").pop()?.split("?")[0] ?? "embed",
          fromMessageId: m.id,
          kind: "unclassified",
        });
      }
    }
  }
  return out;
}

console.log(`Fetching threads in channel ${channelId}...`);
const threads = (await fetchAllThreads(channelId)).slice(0, limit);
console.log(`Found ${threads.length} thread(s) (active + archived).`);

const records: ThreadRecord[] = [];
let i = 0;
for (const t of threads) {
  i += 1;
  process.stdout.write(`[${i}/${threads.length}] ${t.name} ... `);
  const warnings: string[] = [];
  const { name, username } = parseTitle(t.name);
  if (!username) warnings.push("Could not parse username from title");

  let resolved: DiscordUser | null = null;
  if (username) {
    resolved = await resolveUser(username);
    if (!resolved)
      warnings.push(`Username "${username}" not found in guild (unclaimed)`);
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
    for (const img of images) {
      img.kind = await classifyImage(img.url);
    }
  }

  records.push({
    threadId: t.id,
    threadTitle: t.name,
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

  console.log(
    `${resolved ? "linked" : "unclaimed"}, ${images.length} image(s), ${warnings.length} warning(s)`,
  );
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
    Posted by: ${esc(r.posterUsername)} • Thread id: ${esc(r.threadId)}${r.archived ? " • archived" : ""}
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
