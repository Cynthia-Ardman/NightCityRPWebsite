import { eq } from "drizzle-orm";
import { db, guidebookPages, type GuidebookPage } from "@workspace/db";
import {
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  fetchDiscordUser,
} from "./discord";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Guidebook importer
// ---------------------------------------------------------------------------
// Pulls a fixed set of announcement-style Discord channels (NOT forum threads)
// by id, concatenates their messages chronologically, cleans Discord-flavoured
// formatting into web Markdown (resolves user/channel mentions, custom emoji,
// timestamps), re-hosts any Discord CDN images to object storage (CDN urls are
// signed and expire after ~24h), and upserts the result DIRECTLY into the live
// guidebook_pages table keyed by discordChannelId.
//
// Idempotent upsert per source:
//   - no page for this channel        -> insert a new page          (created)
//   - page exists, not edited on site -> overwrite body in place    (updated)
//   - page exists, edited on site     -> stash in pendingImport for
//                                        admin review, don't clobber (conflict)
//   - page exists, content unchanged  -> no-op                       (unchanged)

const API = "https://discord.com/api/v10";

export interface GuidebookSource {
  channelId: string;
  section: string;
  title: string;
  /** Human-readable channel name, used for display + search. */
  sourceLabel: string;
  /** Ordering within the section. */
  position: number;
}

// Channel/post id -> target section, per the task's content mapping. Character
// Creation Help has no source channel (it is curated cross-links authored in
// the app), so it is intentionally absent here.
export const GUIDEBOOK_SOURCES: GuidebookSource[] = [
  { channelId: "1386132844258267156", section: "getting_started", title: "Getting Started with NCRP", sourceLabel: "getting-started-with-ncrp", position: 0 },
  { channelId: "1354586004601835700", section: "faq", title: "FAQ", sourceLabel: "faq", position: 0 },
  { channelId: "1349207148659478538", section: "rules", title: "RP Rules", sourceLabel: "rp-rules", position: 0 },
  { channelId: "1349482890051981462", section: "rules", title: "Avatar Restrictions", sourceLabel: "avatar-restrictions", position: 1 },
  { channelId: "1348654324124880926", section: "schedule", title: "Schedule & Events", sourceLabel: "schedule", position: 0 },
  { channelId: "1384036684760616980", section: "systems", title: "Detailed Systems Explanation", sourceLabel: "detailed-systems-explanation", position: 0 },
  { channelId: "1349139640128376913", section: "setup", title: "VRChat Group Link", sourceLabel: "vrc-group-link", position: 0 },
  { channelId: "1351682248453259264", section: "setup", title: "Discord Invite Link", sourceLabel: "discord-invite-link", position: 1 },
  { channelId: "1351049157875339274", section: "setup", title: "Link VRChat & Discord", sourceLabel: "link-vrc-and-discord", position: 2 },
  { channelId: "1386137184486293644", section: "npc_acting", title: "NPC Acting", sourceLabel: "npc-acting", position: 0 },
];

export interface GuidebookSourceRef {
  label: string;
  url: string;
}

export type GuidebookSourceStatus =
  | "created"
  | "updated"
  | "conflict"
  | "unchanged"
  | "error";

export interface GuidebookSourceResult {
  channelId: string;
  section: string;
  title: string;
  sourceLabel: string;
  status: GuidebookSourceStatus;
  pageId: number | null;
  error: string | null;
}

export interface GuidebookImportRunResult {
  created: number;
  updated: number;
  conflicts: number;
  unchanged: number;
  errors: number;
  sources: GuidebookSourceResult[];
}

// --- low-level Discord helpers ---------------------------------------------

async function botFetch(path: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
}

interface RawAttachment {
  id: string;
  filename: string;
  content_type?: string | null;
  size?: number;
  url: string;
}

interface RawEmbed {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  image?: { url?: string | null } | null;
  thumbnail?: { url?: string | null } | null;
}

interface RawMessage {
  id: string;
  content: string;
  attachments?: RawAttachment[];
  embeds?: RawEmbed[];
}

// Fetch a channel's messages oldest-first (announcement channels keep the
// reference content as one or more staff posts). Paginated to a sane cap.
async function fetchChannelMessages(channelId: string): Promise<RawMessage[]> {
  const collected: RawMessage[] = [];
  let before: string | null = null;
  for (let page = 0; page < 10; page++) {
    const q = before ? `?limit=100&before=${before}` : `?limit=100`;
    const res = await botFetch(`/channels/${channelId}/messages${q}`);
    if (!res.ok) {
      throw new Error(`Discord channel fetch failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const msgs = (await res.json()) as RawMessage[];
    if (msgs.length === 0) break;
    collected.push(...msgs);
    if (msgs.length < 100) break;
    before = msgs[msgs.length - 1].id;
  }
  // Discord returns newest-first; flip to chronological reading order.
  collected.reverse();
  return collected;
}

// Discord channel type 15 = GUILD_FORUM. Forum channels hold no top-level
// messages; their content lives in threads (forum posts), one per topic.
const FORUM_CHANNEL_TYPE = 15;

async function fetchChannelType(channelId: string): Promise<number | null> {
  try {
    const res = await botFetch(`/channels/${channelId}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { type?: number };
    return typeof json.type === "number" ? json.type : null;
  } catch (err) {
    logger.warn({ err, channelId }, "fetchChannelType failed");
    return null;
  }
}

interface ForumThread {
  id: string;
  name: string;
}

// List a forum channel's threads (active + archived public), deduped and
// ordered oldest-first by snowflake id so the imported page reads top-to-bottom.
async function fetchForumThreads(channelId: string): Promise<ForumThread[]> {
  const byId = new Map<string, ForumThread>();

  if (DISCORD_GUILD_ID) {
    const res = await botFetch(`/guilds/${DISCORD_GUILD_ID}/threads/active`);
    if (!res.ok) {
      throw new Error(
        `Discord active-threads fetch failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as { threads?: Array<{ id: string; name: string; parent_id?: string }> };
    for (const t of data.threads ?? []) {
      if (t.parent_id === channelId) byId.set(t.id, { id: t.id, name: t.name });
    }
  }

  let before: string | null = null;
  for (let page = 0; page < 10; page++) {
    const q = before ? `?limit=100&before=${encodeURIComponent(before)}` : `?limit=100`;
    const res = await botFetch(`/channels/${channelId}/threads/archived/public${q}`);
    if (!res.ok) {
      throw new Error(
        `Discord archived-threads fetch failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as {
      threads?: Array<{ id: string; name: string; thread_metadata?: { archive_timestamp?: string } }>;
      has_more?: boolean;
    };
    const threads = data.threads ?? [];
    for (const t of threads) byId.set(t.id, { id: t.id, name: t.name });
    const last = threads[threads.length - 1];
    if (!data.has_more || threads.length === 0 || !last?.thread_metadata?.archive_timestamp) break;
    before = last.thread_metadata.archive_timestamp;
  }

  return [...byId.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
}

// --- cleaning ---------------------------------------------------------------

const IMAGE_CDN_RE =
  /https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/[^\s)]+?\.(?:png|jpe?g|gif|webp)(?:\?[^\s)]*)?/gi;

const MENTION_RE = /<@!?(\d+)>/g;
const CHANNEL_MENTION_RE = /<#(\d+)>/g;
const ROLE_MENTION_RE = /<@&(\d+)>/g;
const CUSTOM_EMOJI_RE = /<a?:(\w+):\d+>/g;
const TIMESTAMP_RE = /<t:(\d+)(?::([tTdDfFR]))?>/g;

// Discord channel deep-links that appear in the imported text. The negative
// lookbehind skips URLs already used as a markdown link destination `](url)` or
// wrapped in an autolink `<url>`, so we never corrupt existing link syntax.
const DISCORD_DEEPLINK_RE =
  /(?<![<(])https?:\/\/(?:discord\.com|discordapp\.com)\/channels\/(\d+)\/(\d+)(?:\/\d+)?/g;

// Map of Discord channel id -> portal path for content that now lives on the
// website. Mentions/links to these channels are rewritten to point at the
// portal; channels not listed here keep their original Discord link.
const CHANNEL_LINK_MAP: Record<string, string> = {
  // Guidebook sections (anchors on the /guidebook browse page)
  "1386132844258267156": "/guidebook#getting_started", // getting-started-with-ncrp
  "1354586004601835700": "/guidebook#faq", // faq
  "1386137184486293644": "/guidebook#npc_acting", // npc-acting
  "1348654324124880926": "/guidebook#schedule", // schedule
  "1349207148659478538": "/guidebook#rules", // rp-rules
  "1349482890051981462": "/guidebook#rules", // avatar-restrictions
  "1351049157875339274": "/guidebook#setup", // link-vrc-and-discord
  "1351682248453259264": "/guidebook#setup", // discord-invite-link
  "1349139640128376913": "/guidebook#setup", // vrc-group-link
  "1384036684760616980": "/guidebook#systems", // detailed-systems-explanation
  "1387192935308591256": "/guidebook#schedule", // event-announcements
  // Other portal areas
  "1384441172180729981": "/directory/lore", // lore
  "1348603380821528626": "/characters", // character-creation
  "1379934118799736884": "/catalog/rent", // business-creation -> Property section
  "1379934227499454616": "/catalog/rent", // request-lease-or-rental
  "1384033835280240640": "/guidebook#systems", // systems-explanation
};

// Section bucket the converted Google Docs/Sheets pages live in. Only pages in
// this section are valid link targets for buildDocLinkMap (so an unrelated page
// that happens to carry a Google url in its sources can't hijack a mapping).
export const LIBRARY_SECTION = "library";

// A resolved Google-file-id -> portal-target lookup for a single import run.
// `label` is used when turning a bare (non-markdown) Google url into a link.
export type DocLinkTarget = { path: string; label: string };
export type DocLinkMap = Map<string, DocLinkTarget>;

// Static: Google file ids whose data the site already covers natively, so links
// point at the existing page instead of duplicating it into a new page. Both the
// "Master Cyberware List" and "NCRP: Cyberware pricing" sheets are the on-site
// Cyberware catalog.
const CATALOG_DOC_LINKS: Record<string, DocLinkTarget> = {
  "1Uicc1mFBiWozgGhVnj2inVh1UbqeDZtiCfMX66kd9rc": { path: "/catalog/cyberware", label: "Cyberware catalog" },
  "1Rj-poH7xE-nz1ZEAV43B9uoxhTGzaTH2FTUPvkBDN_0": { path: "/catalog/cyberware", label: "Cyberware catalog" },
};

// Matches a Google Docs/Sheets/etc. file id within a docs.google.com URL so we
// can look it up. e.g. https://docs.google.com/spreadsheets/d/<id>/edit
const GOOGLE_DOC_ID_RE = /docs\.google\.com\/[a-z]+\/d\/([A-Za-z0-9_-]+)/i;

// Build the Google-file-id -> portal-target map for an import run. Combines the
// static already-covered catalog links with the converted Reference Library
// pages. Those pages' numeric ids differ per environment, so we resolve them
// from the DB at run time: a converted page records its origin Google url in
// `sources`, which we key off to map the id -> /guidebook/<that page's id>.
export async function buildDocLinkMap(): Promise<DocLinkMap> {
  const map: DocLinkMap = new Map();
  for (const [id, target] of Object.entries(CATALOG_DOC_LINKS)) map.set(id, target);

  // Restrict to the Reference Library section and order by id so the result is
  // deterministic; first library page wins if two ever share a Google file id.
  const pages = await db
    .select({ id: guidebookPages.id, title: guidebookPages.title, sources: guidebookPages.sources })
    .from(guidebookPages)
    .where(eq(guidebookPages.section, LIBRARY_SECTION))
    .orderBy(guidebookPages.id);
  for (const p of pages) {
    const sources = Array.isArray(p.sources) ? (p.sources as GuidebookSourceRef[]) : [];
    for (const s of sources) {
      const m = typeof s?.url === "string" ? s.url.match(GOOGLE_DOC_ID_RE) : null;
      // A static catalog mapping always wins; first library page wins ties.
      if (m && !CATALOG_DOC_LINKS[m[1]] && !map.has(m[1])) {
        map.set(m[1], { path: `/guidebook/${p.id}`, label: p.title });
      }
    }
  }
  return map;
}

// Rewrite the destination of any markdown link `[label](url)` (and bare
// docs.google.com urls) whose Google file id is in `docLinks` to the portal
// path, preserving the original label. Runs after channel rewriting.
function rewriteMappedDocUrls(text: string, docLinks: DocLinkMap): string {
  // Markdown links first: keep the label, swap the destination.
  let out = text.replace(/\]\((https?:\/\/[^)]+)\)/g, (full, url: string) => {
    const m = url.match(GOOGLE_DOC_ID_RE);
    const mapped = m ? docLinks.get(m[1]) : undefined;
    return mapped ? `](${mapped.path})` : full;
  });
  // Bare (non-markdown) docs.google.com urls -> a labelled portal link.
  out = out.replace(
    /(?<![<([])https?:\/\/docs\.google\.com\/[a-z]+\/d\/([A-Za-z0-9_-]+)[^\s)]*/gi,
    (full, id: string) => {
      const mapped = docLinks.get(id);
      return mapped ? `[${mapped.label}](${mapped.path})` : full;
    },
  );
  return out;
}

async function resolveChannelName(
  channelId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(channelId)) return cache.get(channelId) ?? null;
  let name: string | null = null;
  try {
    const res = await botFetch(`/channels/${channelId}`);
    if (res.ok) {
      const data = (await res.json()) as { name?: string };
      name = data.name ?? null;
    }
  } catch (err) {
    logger.warn({ err, channelId }, "resolveChannelName failed");
  }
  cache.set(channelId, name);
  return name;
}

// Escape characters that are special inside a Markdown link label so a Discord
// display/channel name can never break out of `[label](url)` syntax (e.g. a `]`
// in a name closing the link early and injecting a different destination).
function escapeMdLabel(s: string): string {
  return s.replace(/([\\[\]()<>])/g, "\\$1");
}

// Turn Discord-flavoured text into clean Markdown:
//   - user mentions  -> [@name](https://discord.com/users/<id>) (opens profile)
//   - channel deep-links / mentions -> portal links when the content has moved
//     to the website (CHANNEL_LINK_MAP), otherwise the original Discord link/name
//   - role mentions  -> dropped (no public role display)
//   - custom emoji   -> :name:
//   - unix timestamps -> a `[t=secs:fmt]` token the client renders in the
//     viewer's local timezone (see remarkDiscordTime on the frontend)
// Standard Discord markdown (bold/italic/lists/quotes/links/code) already renders.
async function cleanContent(
  text: string,
  userCache: Map<string, string | null>,
  channelCache: Map<string, string | null>,
  docLinks: DocLinkMap,
): Promise<string> {
  let out = text;

  // User mentions -> link to the person's Discord profile.
  const userIds = new Set<string>();
  for (const m of out.matchAll(MENTION_RE)) userIds.add(m[1]);
  for (const id of userIds) {
    if (userCache.has(id)) continue;
    const u = await fetchDiscordUser(id);
    userCache.set(id, u ? u.globalName || u.username : null);
  }
  out = out.replace(MENTION_RE, (_full, id: string) => {
    const name = userCache.get(id);
    return `[@${escapeMdLabel(name ?? "discord-user")}](https://discord.com/users/${id})`;
  });

  // Discord channel deep-links -> portal link when the content has moved here,
  // otherwise a clean labelled link back to the Discord channel.
  const deepIds = new Set<string>();
  for (const m of out.matchAll(DISCORD_DEEPLINK_RE)) deepIds.add(m[2]);
  for (const id of deepIds) await resolveChannelName(id, channelCache);
  out = out.replace(DISCORD_DEEPLINK_RE, (_full, guild: string, channel: string) => {
    const name = channelCache.get(channel);
    const label = `#${escapeMdLabel(name ?? "channel")}`;
    const target = CHANNEL_LINK_MAP[channel] ?? `https://discord.com/channels/${guild}/${channel}`;
    return `[${label}](${target})`;
  });

  // Inline channel mentions -> portal link when mapped, else #name.
  const channelIds = new Set<string>();
  for (const m of out.matchAll(CHANNEL_MENTION_RE)) channelIds.add(m[1]);
  for (const id of channelIds) await resolveChannelName(id, channelCache);
  out = out.replace(CHANNEL_MENTION_RE, (full, id: string) => {
    const name = channelCache.get(id);
    if (!name) return full;
    const label = `#${escapeMdLabel(name)}`;
    const mapped = CHANNEL_LINK_MAP[id];
    if (mapped) return `[${label}](${mapped})`;
    return DISCORD_GUILD_ID ? `[${label}](https://discord.com/channels/${DISCORD_GUILD_ID}/${id})` : label;
  });

  // Role mentions -> drop (no public role display).
  out = out.replace(ROLE_MENTION_RE, "");

  // Custom emoji -> :name:
  out = out.replace(CUSTOM_EMOJI_RE, (_full, name: string) => `:${name}:`);

  // Unix timestamps -> a token rendered in the viewer's local timezone client-side.
  out = out.replace(TIMESTAMP_RE, (_full, secs: string, fmt?: string) => {
    return Number.isNaN(Number(secs)) ? _full : `[t=${secs}${fmt ? `:${fmt}` : ""}]`;
  });

  // Google Docs/Sheets links that now have a portal equivalent.
  out = rewriteMappedDocUrls(out, docLinks);

  return out;
}

// --- image re-hosting -------------------------------------------------------

const storage = new ObjectStorageService();

// Fetch a Discord CDN image and re-host it to object storage, returning the
// app-relative path (or null on failure so the import continues).
async function rehostImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "image/png";
    if (!ct.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 12 * 1024 * 1024) return null;
    return await storage.uploadBuffer(buf, ct);
  } catch (err) {
    logger.warn({ err, url }, "guidebook rehostImage failed");
    return null;
  }
}

// --- build a page payload from a source channel -----------------------------

interface BuiltPage {
  body: string;
  images: string[];
  sources: GuidebookSourceRef[];
}

// Turn one Discord message into a clean Markdown block, re-hosting any inline
// or attached images into `images`. Returns "" when the message has no content.
async function processMessage(
  msg: RawMessage,
  images: string[],
  userCache: Map<string, string | null>,
  channelCache: Map<string, string | null>,
  docLinks: DocLinkMap,
): Promise<string> {
  let block = await cleanContent(msg.content ?? "", userCache, channelCache, docLinks);

  // Embed text (announcements sometimes live in embeds).
  for (const e of msg.embeds ?? []) {
    const parts: string[] = [];
    if (e.title) parts.push(`### ${e.title}`);
    if (e.description) {
      parts.push(await cleanContent(e.description, userCache, channelCache, docLinks));
    }
    if (parts.length) block += (block ? "\n\n" : "") + parts.join("\n\n");
  }

  // Re-host inline CDN image links embedded in the text.
  const inlineUrls = new Set<string>();
  for (const m of block.matchAll(IMAGE_CDN_RE)) inlineUrls.add(m[0]);
  for (const url of inlineUrls) {
    const hosted = await rehostImage(url);
    if (hosted) {
      images.push(hosted);
      block = block.split(url).join(hosted);
    }
  }

  // Re-host attachments + embed images, append as markdown images.
  const attachUrls: string[] = [];
  for (const a of msg.attachments ?? []) {
    const ct = (a.content_type ?? "").toLowerCase();
    if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename)) {
      attachUrls.push(a.url);
    }
  }
  for (const e of msg.embeds ?? []) {
    if (e.image?.url) attachUrls.push(e.image.url);
  }
  for (const url of attachUrls) {
    const hosted = await rehostImage(url);
    if (hosted) {
      images.push(hosted);
      block += `${block ? "\n\n" : ""}![image](${hosted})`;
    }
  }

  return block.trim();
}

async function buildPage(
  src: GuidebookSource,
  userCache: Map<string, string | null>,
  channelCache: Map<string, string | null>,
  docLinks: DocLinkMap,
): Promise<BuiltPage> {
  const images: string[] = [];
  const blocks: string[] = [];

  const channelType = await fetchChannelType(src.channelId);
  if (channelType === FORUM_CHANNEL_TYPE) {
    // Forum channel: content lives in threads (one post per topic). Each thread
    // becomes a "## <thread name>" section followed by its messages in order.
    const threads = await fetchForumThreads(src.channelId);
    for (const thread of threads) {
      const messages = await fetchChannelMessages(thread.id);
      const threadBlocks: string[] = [];
      const normName = thread.name.replace(/[#*_~`\s]/g, "").toLowerCase();
      for (const msg of messages) {
        const block = await processMessage(msg, images, userCache, channelCache, docLinks);
        if (!block) continue;
        // Skip a message that is just the thread title repeated (the heading
        // below already covers it), so the page doesn't show the name twice.
        if (block.replace(/[#*_~`\s]/g, "").toLowerCase() === normName) continue;
        threadBlocks.push(block);
      }
      if (threadBlocks.length) {
        blocks.push(`## ${thread.name}`);
        blocks.push(...threadBlocks);
      }
    }
  } else {
    const messages = await fetchChannelMessages(src.channelId);
    for (const msg of messages) {
      const block = await processMessage(msg, images, userCache, channelCache, docLinks);
      if (block) blocks.push(block);
    }
  }

  const body = blocks.join("\n\n").trim();
  const sources: GuidebookSourceRef[] = [
    {
      label: `#${src.sourceLabel}`,
      url: DISCORD_GUILD_ID
        ? `https://discord.com/channels/${DISCORD_GUILD_ID}/${src.channelId}`
        : `https://discord.com/channels/@me/${src.channelId}`,
    },
  ];
  return { body, images, sources };
}

// --- slug -------------------------------------------------------------------

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "page"
  );
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base);
  let candidate = root;
  for (let n = 2; n < 1000; n++) {
    const [hit] = await db
      .select({ id: guidebookPages.id })
      .from(guidebookPages)
      .where(eq(guidebookPages.slug, candidate))
      .limit(1);
    if (!hit) return candidate;
    candidate = `${root}-${n}`;
  }
  return `${root}-${Date.now()}`;
}

function sameContent(page: GuidebookPage, built: BuiltPage): boolean {
  const a = JSON.stringify((page.images ?? []) as unknown[]);
  const b = JSON.stringify(built.images);
  return page.body === built.body && a === b;
}

// --- run --------------------------------------------------------------------

/**
 * Import a single source channel. Exposed so the route can report per-source
 * outcomes. `actorId` is recorded as the created/updated author.
 */
export async function importGuidebookSource(
  src: GuidebookSource,
  actorId: string | null,
  userCache: Map<string, string | null>,
  channelCache: Map<string, string | null>,
  docLinks: DocLinkMap,
): Promise<GuidebookSourceResult> {
  const base: Omit<GuidebookSourceResult, "status" | "pageId" | "error"> = {
    channelId: src.channelId,
    section: src.section,
    title: src.title,
    sourceLabel: src.sourceLabel,
  };
  try {
    const built = await buildPage(src, userCache, channelCache, docLinks);
    if (!built.body) {
      return { ...base, status: "error", pageId: null, error: "No content found in source channel" };
    }

    const [existing] = await db
      .select()
      .from(guidebookPages)
      .where(eq(guidebookPages.discordChannelId, src.channelId));

    if (!existing) {
      const slug = await uniqueSlug(src.title);
      const [created] = await db
        .insert(guidebookPages)
        .values({
          section: src.section,
          title: src.title,
          slug,
          body: built.body,
          images: built.images as never,
          sources: built.sources as never,
          position: src.position,
          discordChannelId: src.channelId,
          sourceLabel: src.sourceLabel,
          importedAt: new Date(),
          editedSinceImport: false,
          createdById: actorId,
          updatedById: actorId,
        })
        .returning();
      return { ...base, status: "created", pageId: created.id, error: null };
    }

    if (sameContent(existing, built)) {
      // Refresh the import marker + source label but skip a no-op rewrite.
      await db
        .update(guidebookPages)
        .set({ importedAt: new Date(), sourceLabel: src.sourceLabel, sources: built.sources as never })
        .where(eq(guidebookPages.id, existing.id));
      return { ...base, status: "unchanged", pageId: existing.id, error: null };
    }

    if (existing.editedSinceImport) {
      // Don't clobber on-site edits — stash for admin review.
      await db
        .update(guidebookPages)
        .set({
          pendingImport: {
            body: built.body,
            images: built.images,
            sources: built.sources,
            sourceLabel: src.sourceLabel,
          } as never,
          pendingImportAt: new Date(),
        })
        .where(eq(guidebookPages.id, existing.id));
      return { ...base, status: "conflict", pageId: existing.id, error: null };
    }

    // Safe to overwrite the body in place.
    await db
      .update(guidebookPages)
      .set({
        body: built.body,
        images: built.images as never,
        sources: built.sources as never,
        sourceLabel: src.sourceLabel,
        importedAt: new Date(),
        editedSinceImport: false,
        updatedById: actorId,
        updatedAt: new Date(),
      })
      .where(eq(guidebookPages.id, existing.id));
    return { ...base, status: "updated", pageId: existing.id, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, channelId: src.channelId }, "importGuidebookSource failed");
    return { ...base, status: "error", pageId: null, error: msg };
  }
}

/**
 * Run the full Guidebook import across every configured source. Admin-triggered
 * (no cron). Each source is independent — one failure doesn't abort the rest.
 */
export async function runGuidebookImport(actorId: string | null): Promise<GuidebookImportRunResult> {
  if (!DISCORD_BOT_TOKEN) {
    return {
      created: 0,
      updated: 0,
      conflicts: 0,
      unchanged: 0,
      errors: GUIDEBOOK_SOURCES.length,
      sources: GUIDEBOOK_SOURCES.map((s) => ({
        channelId: s.channelId,
        section: s.section,
        title: s.title,
        sourceLabel: s.sourceLabel,
        status: "error" as const,
        pageId: null,
        error: "Discord bot token not configured",
      })),
    };
  }

  const userCache = new Map<string, string | null>();
  const channelCache = new Map<string, string | null>();
  const docLinks = await buildDocLinkMap();
  const sources: GuidebookSourceResult[] = [];
  for (const src of GUIDEBOOK_SOURCES) {
    sources.push(await importGuidebookSource(src, actorId, userCache, channelCache, docLinks));
  }
  return {
    created: sources.filter((s) => s.status === "created").length,
    updated: sources.filter((s) => s.status === "updated").length,
    conflicts: sources.filter((s) => s.status === "conflict").length,
    unchanged: sources.filter((s) => s.status === "unchanged").length,
    errors: sources.filter((s) => s.status === "error").length,
    sources,
  };
}
