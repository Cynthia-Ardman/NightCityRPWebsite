import { db, loreEntries, loreImportDrafts } from "@workspace/db";
import { eq } from "drizzle-orm";
import { DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, fetchDiscordUser } from "./discord";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Lore importer
// ---------------------------------------------------------------------------
// Scans the Discord lore forum(s) + any PUBLIC Google Docs linked inside the
// posts, then groups/dedups the candidates and writes one row per proposed
// entry into loreImportDrafts (a staff review queue). NOTHING is published
// directly — staff confirm category/fixer, set the public-vs-fixer split and
// optionally merge into an existing entry before approving a draft into a live
// loreEntries row. Re-running is idempotent for still-pending drafts: a group
// that already has a pending draft is counted as a duplicate and skipped.

const API = "https://discord.com/api/v10";

// Forum channels to scan. The main lore forum has mixed content (category is
// inferred per-thread); the Approved Factions forum is faction-only so we seed
// that category for everything found there.
const LORE_SOURCES: Array<{ channelId: string; defaultCategory: LoreCategory | null; label: string }> = [
  { channelId: "1384441172180729981", defaultCategory: null, label: "Lore Forum" },
  { channelId: "1377825185654247586", defaultCategory: "faction", label: "Approved Factions" },
];

// Thread that maps an entry name to its responsible "Story Lead" fixer.
const STORY_LEADS_THREAD_ID = "1437189951971393708";

type LoreCategory = "corporation" | "gang" | "faction" | "misc";

export interface LoreSourceRef {
  label: string;
  url: string;
}

interface Candidate {
  groupKey: string;
  name: string;
  aliases: string[];
  category: LoreCategory;
  fixer: string | null;
  summary: string | null;
  publicBody: string;
  fixerBody: string | null;
  sources: LoreSourceRef[];
}

export interface LoreImportRunResult {
  scanned: number;
  created: number;
  duplicates: number;
  errors: string[];
}

// --- low-level Discord helpers ---------------------------------------------

async function botFetch(path: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
}

interface ForumThread {
  id: string;
  name: string;
  appliedTagIds: string[];
  archiveTimestamp: string | null;
}

interface RawThread {
  id: string;
  name: string;
  parent_id?: string | null;
  applied_tags?: string[];
  thread_metadata?: { archive_timestamp?: string | null };
}

// Active (non-archived) threads live at the guild level; filter to the forum.
async function listActiveThreads(channelId: string): Promise<ForumThread[]> {
  if (!DISCORD_GUILD_ID) return [];
  const res = await botFetch(`/guilds/${DISCORD_GUILD_ID}/threads/active`);
  if (!res.ok) {
    logger.warn({ status: res.status, channelId }, "listActiveThreads failed");
    return [];
  }
  const data = (await res.json()) as { threads?: RawThread[] };
  return (data.threads ?? [])
    .filter((t) => t.parent_id === channelId)
    .map(toForumThread);
}

// Archived public threads are paginated by archive timestamp.
async function listArchivedThreads(channelId: string): Promise<ForumThread[]> {
  const out: ForumThread[] = [];
  let before: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q = before ? `?limit=100&before=${encodeURIComponent(before)}` : `?limit=100`;
    const res = await botFetch(`/channels/${channelId}/threads/archived/public${q}`);
    if (!res.ok) {
      if (res.status !== 404) logger.warn({ status: res.status, channelId }, "listArchivedThreads failed");
      break;
    }
    const data = (await res.json()) as { threads?: RawThread[]; has_more?: boolean };
    const threads = (data.threads ?? []).map(toForumThread);
    out.push(...threads);
    const last = threads[threads.length - 1];
    if (!data.has_more || !last?.archiveTimestamp) break;
    before = last.archiveTimestamp;
  }
  return out;
}

function toForumThread(t: RawThread): ForumThread {
  return {
    id: t.id,
    name: t.name,
    appliedTagIds: t.applied_tags ?? [],
    archiveTimestamp: t.thread_metadata?.archive_timestamp ?? null,
  };
}

// Forum tag id -> tag name, used to infer category from a thread's tags.
async function fetchForumTags(channelId: string): Promise<Map<string, string>> {
  const res = await botFetch(`/channels/${channelId}`);
  if (!res.ok) return new Map();
  const data = (await res.json()) as { available_tags?: Array<{ id: string; name: string }> };
  return new Map((data.available_tags ?? []).map((t) => [t.id, t.name.toLowerCase()]));
}

interface RawMessage {
  id: string;
  content: string;
  author?: { id: string };
}

// Concatenate the thread's opening post plus any continuation posts by the same
// author (lore write-ups are often split across several OP-author messages).
async function fetchThreadBody(threadId: string): Promise<string> {
  const collected: RawMessage[] = [];
  let before: string | null = null;
  let opAuthorId: string | null = null;
  for (let page = 0; page < 5; page++) {
    const q = before ? `?limit=100&before=${before}` : `?limit=100`;
    const res = await botFetch(`/channels/${threadId}/messages${q}`);
    if (!res.ok) break;
    const msgs = (await res.json()) as RawMessage[];
    if (msgs.length === 0) break;
    collected.push(...msgs);
    if (msgs.length < 100) break;
    before = msgs[msgs.length - 1].id;
  }
  // Messages come back newest-first; flip to chronological. The oldest message
  // is the OP; its author defines who the continuation posts belong to.
  collected.reverse();
  const op = collected[0];
  if (!op) return "";
  opAuthorId = op.author?.id ?? null;
  const parts = collected
    .filter((m) => !opAuthorId || m.author?.id === opAuthorId)
    .map((m) => m.content?.trim())
    .filter((c): c is string => !!c);
  return parts.join("\n\n");
}

// --- Google Docs ------------------------------------------------------------

const GDOC_RE = /https?:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/g;

function extractGoogleDocIds(text: string): string[] {
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  GDOC_RE.lastIndex = 0;
  while ((m = GDOC_RE.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}

// Fetch a PUBLIC ("anyone with the link") Google Doc as plain text via the
// export endpoint. No Google auth — relies on the doc being link-shared.
async function fetchGoogleDocText(docId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://docs.google.com/document/d/${docId}/export?format=txt`, {
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    // A non-public doc redirects to an HTML login page; reject those.
    if (ct.includes("text/html")) return null;
    const text = await res.text();
    return text.slice(0, 50_000);
  } catch (err) {
    logger.warn({ err, docId }, "fetchGoogleDocText failed");
    return null;
  }
}

// --- heuristics -------------------------------------------------------------

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function inferCategory(name: string, body: string, tagNames: string[]): LoreCategory {
  const hay = `${tagNames.join(" ")} ${name} ${body.slice(0, 500)}`.toLowerCase();
  if (/\bcorp(oration)?s?\b/.test(hay)) return "corporation";
  if (/\bgangs?\b/.test(hay)) return "gang";
  if (/\bfactions?\b|\bcrew\b|\borg(anization)?s?\b/.test(hay)) return "faction";
  return "misc";
}

// Thread titles are often prefixed with a category label ("Corporations - X",
// "Gangs - X", "Organization- X", "Proposal: X") and/or suffixed with a status
// qualifier ("(Final)", "- IN DEVELOPMENT"). Stripping these gives a stable
// grouping/display name so the same entity from different threads dedups into
// one entry, and the prefix itself is a strong category signal.
const CATEGORY_PREFIX_RE =
  /^\s*(corporations?|corps?|gangs?|factions?|organizations?|organisations?|orgs?|crew|ncrp faction|proposal)\s*[-–—:.]+\s*/i;

const STATUS_SUFFIX_RE =
  /\s*[-–—(\[]+\s*(final(ized|ised)?|finished|complete[d]?|in[- ]?development|in[- ]?progress|wip|draft|tba|ongoing|background info(rmation)?)\s*[)\]]*\s*$/i;

// Derive a category purely from a leading category label, if present.
function categoryFromPrefix(name: string): LoreCategory | null {
  const m = /^\s*(corporations?|corps?|gangs?|factions?|organizations?|organisations?|orgs?|crew)\b/i.exec(name);
  if (!m) return null;
  const w = m[1].toLowerCase();
  if (w.startsWith("corp")) return "corporation";
  if (w.startsWith("gang")) return "gang";
  return "faction"; // faction / organization / org / crew
}

// Remove a leading category/proposal label and trailing status qualifiers to
// produce the canonical display name used for grouping.
function cleanDisplayName(name: string): string {
  let n = name.trim();
  n = n.replace(CATEGORY_PREFIX_RE, "");
  n = n.replace(/^\s*proposal\s*[-–—:.]+\s*/i, "");
  for (let i = 0; i < 3; i++) {
    const next = n.replace(STATUS_SUFFIX_RE, "").trim();
    if (next === n) break;
    n = next;
  }
  return n.trim() || name.trim();
}

// Split a body into public vs fixer-only halves at the first "fixer/staff
// only" style heading. Everything before the marker is public; the marker line
// and everything after it is fixer-only.
const FIXER_MARKER_RE =
  /^[^\S\r\n]*#*[^\S\r\n]*(fixer[- ]?only|fixer[- ]?info(rmation)?|staff[- ]?only|gm[- ]?only|ooc(\s+only)?|hidden|behind[- ]the[- ]scenes|secret[s]?|for[- ]fixers)\b.*$/im;

function splitBody(body: string): { publicBody: string; fixerBody: string | null } {
  const m = FIXER_MARKER_RE.exec(body);
  if (!m || m.index === undefined) return { publicBody: body.trim(), fixerBody: null };
  const publicBody = body.slice(0, m.index).trim();
  const fixerBody = body.slice(m.index).trim();
  return { publicBody, fixerBody: fixerBody || null };
}

function firstParagraph(body: string): string | null {
  const para = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 0);
  if (!para) return null;
  const oneLine = para.replace(/\s+/g, " ");
  return oneLine.length > 280 ? `${oneLine.slice(0, 277)}...` : oneLine;
}

// Discord user mention: <@123> or <@!123>.
const MENTION_RE = /<@!?(\d+)>/g;

// Replace raw Discord user mentions with readable display names, caching each
// lookup so a user fetched once is reused across the whole import run. `prefix`
// controls whether the resolved name keeps an "@" (natural in body prose) or
// not (cleaner for the responsible-fixer field). Unresolvable ids are left as-is.
async function resolveMentions(
  text: string,
  cache: Map<string, string | null>,
  prefix: "@" | "" = "@",
): Promise<string> {
  if (!text || !text.includes("<@")) return text;
  const ids = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) ids.add(m[1]);
  for (const id of ids) {
    if (cache.has(id)) continue;
    const u = await fetchDiscordUser(id);
    cache.set(id, u ? u.globalName || u.username : null);
  }
  return text.replace(MENTION_RE, (full, id: string) => {
    const name = cache.get(id);
    return name ? `${prefix}${name}` : full;
  });
}

// Parse the Story Leads thread into name -> lead fixer mapping. Accepts lines
// like "Arasaka — Medusa", "Arasaka: Medusa", "Arasaka - Medusa".
async function fetchStoryLeads(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const body = await fetchThreadBody(STORY_LEADS_THREAD_ID);
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = /^[-*•\d.)\s]*(.+?)\s*[—:–-]\s*(.+)$/.exec(line);
      if (!m) continue;
      const entry = normalizeName(m[1]);
      const lead = m[2].trim();
      if (entry && lead && lead.length < 80) map.set(entry, lead);
    }
  } catch (err) {
    logger.warn({ err }, "fetchStoryLeads failed");
  }
  return map;
}

// --- scan -------------------------------------------------------------------

async function scanChannel(
  channelId: string,
  defaultCategory: LoreCategory | null,
  sourceLabel: string,
  leads: Map<string, string>,
  errors: string[],
  mentionCache: Map<string, string | null>,
): Promise<Candidate[]> {
  const tagMap = await fetchForumTags(channelId);
  const [active, archived] = await Promise.all([
    listActiveThreads(channelId).catch((e) => {
      errors.push(`${sourceLabel}: active threads — ${e instanceof Error ? e.message : String(e)}`);
      return [] as ForumThread[];
    }),
    listArchivedThreads(channelId).catch((e) => {
      errors.push(`${sourceLabel}: archived threads — ${e instanceof Error ? e.message : String(e)}`);
      return [] as ForumThread[];
    }),
  ]);
  const byId = new Map<string, ForumThread>();
  for (const t of [...active, ...archived]) byId.set(t.id, t);

  const candidates: Candidate[] = [];
  for (const thread of byId.values()) {
    // The Story Leads index thread is parsed separately for lead mappings; it
    // is not itself a lore entry.
    if (thread.id === STORY_LEADS_THREAD_ID) continue;
    try {
      const discordBody = await fetchThreadBody(thread.id);
      const tagNames = thread.appliedTagIds.map((id) => tagMap.get(id)).filter((n): n is string => !!n);

      // Pull in any linked public Google Docs as additional body text + sources.
      const sources: LoreSourceRef[] = [
        { label: `Discord: ${thread.name}`, url: `https://discord.com/channels/${DISCORD_GUILD_ID}/${thread.id}` },
      ];
      let combinedBody = discordBody;
      for (const docId of extractGoogleDocIds(discordBody)) {
        const docText = await fetchGoogleDocText(docId);
        const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
        sources.push({ label: "Google Doc", url: docUrl });
        if (docText) combinedBody += `\n\n${docText}`;
      }

      // Convert raw Discord user mentions to readable names before splitting so
      // both public + fixer bodies (and the derived summary) read cleanly.
      combinedBody = await resolveMentions(combinedBody, mentionCache);
      const { publicBody, fixerBody } = splitBody(combinedBody);
      const displayName = cleanDisplayName(thread.name);
      const category =
        defaultCategory ??
        categoryFromPrefix(thread.name) ??
        inferCategory(displayName, combinedBody, tagNames);
      const groupKey = normalizeName(displayName);
      const rawFixer = leads.get(groupKey) ?? leads.get(normalizeName(thread.name)) ?? null;
      const fixer = rawFixer ? await resolveMentions(rawFixer, mentionCache, "") : null;

      candidates.push({
        groupKey,
        name: displayName,
        aliases: [],
        category,
        fixer,
        summary: firstParagraph(publicBody),
        publicBody,
        fixerBody,
        sources,
      });
    } catch (err) {
      errors.push(`${sourceLabel}/${thread.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return candidates;
}

// Merge candidates that share a groupKey (same name from multiple sources) into
// a single proposed entry: longest public body wins, fixer bodies + sources +
// aliases are unioned.
function groupCandidates(candidates: Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate>();
  for (const c of candidates) {
    const existing = groups.get(c.groupKey);
    if (!existing) {
      groups.set(c.groupKey, { ...c, sources: [...c.sources], aliases: [...c.aliases] });
      continue;
    }
    if (c.publicBody.length > existing.publicBody.length) existing.publicBody = c.publicBody;
    if (c.fixerBody && (!existing.fixerBody || c.fixerBody.length > existing.fixerBody.length)) {
      existing.fixerBody = c.fixerBody;
    }
    existing.summary = existing.summary ?? c.summary;
    existing.fixer = existing.fixer ?? c.fixer;
    if (existing.category === "misc" && c.category !== "misc") existing.category = c.category;
    for (const s of c.sources) {
      if (!existing.sources.some((e) => e.url === s.url)) existing.sources.push(s);
    }
    if (c.name !== existing.name && !existing.aliases.includes(c.name)) existing.aliases.push(c.name);
  }
  return [...groups.values()];
}

/**
 * Run the full import: scan all forum sources + linked docs, group/dedup, and
 * write pending drafts. Idempotent for pending drafts (a group that already has
 * a pending draft is skipped and counted as a duplicate). Admin-triggered.
 */
export async function runLoreImport(): Promise<LoreImportRunResult> {
  const errors: string[] = [];
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) {
    return { scanned: 0, created: 0, duplicates: 0, errors: ["Discord bot token or guild id not configured"] };
  }

  const leads = await fetchStoryLeads();
  const mentionCache = new Map<string, string | null>();
  const allCandidates: Candidate[] = [];
  for (const src of LORE_SOURCES) {
    const found = await scanChannel(src.channelId, src.defaultCategory, src.label, leads, errors, mentionCache);
    allCandidates.push(...found);
  }
  const grouped = groupCandidates(allCandidates);

  // Existing live entries (for merge suggestions) keyed by normalized name +
  // aliases. Existing pending drafts (for idempotent re-runs) keyed by groupKey.
  const liveEntries = await db
    .select({ id: loreEntries.id, name: loreEntries.name, aliases: loreEntries.aliases })
    .from(loreEntries);
  const liveByKey = new Map<string, number>();
  for (const e of liveEntries) {
    liveByKey.set(normalizeName(e.name), e.id);
    for (const a of e.aliases ?? []) liveByKey.set(normalizeName(a), e.id);
  }
  const pendingDrafts = await db
    .select({ groupKey: loreImportDrafts.groupKey })
    .from(loreImportDrafts)
    .where(eq(loreImportDrafts.status, "pending"));
  const pendingKeys = new Set(pendingDrafts.map((d) => d.groupKey));

  let created = 0;
  let duplicates = 0;
  for (const c of grouped) {
    if (pendingKeys.has(c.groupKey)) {
      duplicates++;
      continue;
    }
    const mergeId = liveByKey.get(c.groupKey) ?? null;
    // The in-memory pendingKeys check dedups within/against a prior run, but a
    // concurrent import could race past it. The partial unique index on
    // (group_key) WHERE status='pending' is the real guard: onConflictDoNothing
    // makes a losing racer a no-op (returns []) which we count as a duplicate.
    const inserted = await db
      .insert(loreImportDrafts)
      .values({
        groupKey: c.groupKey,
        proposedName: c.name,
        proposedCategory: c.category,
        proposedFixer: c.fixer,
        aliases: c.aliases,
        summary: c.summary,
        publicBody: c.publicBody,
        fixerBody: c.fixerBody,
        sources: c.sources as never,
        suggestedMergeEntryId: mergeId,
        sourceKey: c.sources.map((s) => s.url).join(","),
      })
      .onConflictDoNothing({
        target: loreImportDrafts.groupKey,
        where: eq(loreImportDrafts.status, "pending"),
      })
      .returning({ id: loreImportDrafts.id });
    if (inserted.length === 0) {
      duplicates++;
      continue;
    }
    pendingKeys.add(c.groupKey);
    created++;
  }

  return { scanned: grouped.length, created, duplicates, errors };
}
