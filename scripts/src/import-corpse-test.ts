/**
 * One-off test: find Corpse's thread in #character-sheets, parse it,
 * rehost images to object storage, and write the parsed sheet + images
 * to characters row id=4. Read-only against Discord; writes to local DB
 * via DATABASE_URL and to object storage via the local api-server's
 * /api/storage/uploads/request-url endpoint.
 */
import pg from "pg";

const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GUILD = process.env.DISCORD_GUILD_ID!;
const CHANNEL = "1366901669316657224"; // #character-sheets
const TARGET_NAME = "Corpse";
const TARGET_CHAR_ID = 4;
const API_BASE = process.env.PUBLIC_BASE_URL ?? "http://localhost:5000";

if (!TOKEN || !GUILD) throw new Error("DISCORD_BOT_TOKEN / DISCORD_GUILD_ID required");

async function dc<T>(path: string): Promise<T> {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bot ${TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 429) {
      const ra = Number(r.headers.get("retry-after") ?? "1");
      await new Promise((res) => setTimeout(res, (ra + 0.2) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`Discord ${path} ${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }
  throw new Error(`rate-limited: ${path}`);
}

type Thread = { id: string; name: string; parent_id?: string | null; thread_metadata?: { archived: boolean; archive_timestamp?: string } };
type Attachment = { id: string; url: string; proxy_url?: string; filename: string; content_type?: string; width?: number; height?: number };
type Embed = { image?: { url: string }; thumbnail?: { url: string } };
type Message = {
  id: string; content: string; timestamp: string;
  author: { id: string; username: string };
  attachments: Attachment[]; embeds: Embed[];
  message_snapshots?: Array<{ message: { content?: string; attachments?: Attachment[]; embeds?: Embed[] } }>;
};

async function findThread(): Promise<Thread> {
  const all = new Map<string, Thread>();
  const active = await dc<{ threads: Thread[] }>(`/guilds/${GUILD}/threads/active`);
  for (const t of active.threads) if (t.parent_id === CHANNEL) all.set(t.id, t);
  let before: string | undefined;
  for (let p = 0; p < 50; p++) {
    const q = new URLSearchParams({ limit: "100" });
    if (before) q.set("before", before);
    const res = await dc<{ threads: Thread[]; has_more: boolean }>(`/channels/${CHANNEL}/threads/archived/public?${q}`);
    for (const t of res.threads) all.set(t.id, t);
    if (!res.has_more || !res.threads.length) break;
    before = res.threads.at(-1)!.thread_metadata?.archive_timestamp;
    if (!before) break;
  }
  const matches = [...all.values()].filter((t) => t.name.toLowerCase().includes(TARGET_NAME.toLowerCase()));
  console.log(`Found ${all.size} threads in #character-sheets; ${matches.length} match "${TARGET_NAME}":`);
  for (const m of matches) console.log(`  ${m.id}  ${m.name}  archived=${!!m.thread_metadata?.archived}`);
  if (matches.length === 0) throw new Error(`No thread matched ${TARGET_NAME}`);
  return matches[0];
}

async function fetchOp(threadId: string): Promise<Message> {
  // The OP of a forum thread shares the thread's id.
  // The Get Channel Message endpoint returns just that one.
  const msgs = await dc<Message[]>(`/channels/${threadId}/messages?limit=100`);
  msgs.sort((a, b) => a.id.localeCompare(b.id));
  if (!msgs.length) throw new Error("empty thread");
  return msgs[0];
}

// ---- sheet parser ----
// Many threads (like Corpse's) use markdown headings as section dividers,
// not inline "Label:" lines. We handle both:
//   - "# Heading", "## **Heading**", "### Heading:" => new section
//   - "Label: value" (inline, see LABEL_RE)        => new section
const SECTION_LABELS = ["Name","Age","Pronouns","Occupation / Role in Night City","Occupation","Psychological Profile","Physical Description","Chrome / Implants","Total Cyberware Points","Skills / Talents / Abilities","Skills","Equipment / Armor / Weapons","Equipment","Backstory","Known Affiliations","Affiliations","Reference Image(s)","Reference Images","RP Hooks","Additional Notes","Real Name","Alias","Cyberware"];
const LABEL_RE = new RegExp(`^[^\\p{L}\\n]{0,8}(${SECTION_LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")).join("|")})\\s*:\\s*(.*)$`, "iu");
// Strip markdown emphasis/heading markers from a heading line to get the
// raw label, e.g. "## **Real Name**:" -> "Real Name", "# Backstory:" -> "Backstory".
function stripMd(s: string): string {
  return s.replace(/^#{1,6}\s*/, "").replace(/\*\*/g, "").replace(/[:：]\s*$/, "").trim();
}
function canon(l: string): string {
  const s = l.toLowerCase();
  if (s.startsWith("occupation")) return "Occupation";
  if (s.startsWith("psychological")) return "Psychological Profile";
  if (s.startsWith("physical")) return "Physical Description";
  if (s.startsWith("chrome")) return "Chrome / Implants";
  if (s.startsWith("cyberware") && !s.includes("point")) return "Chrome / Implants";
  if (s.startsWith("total cyberware")) return "Total Cyberware Points";
  if (s.startsWith("skills")) return "Skills / Talents / Abilities";
  if (s.startsWith("equipment")) return "Equipment / Armor / Weapons";
  if (s.startsWith("backstory")) return "Backstory";
  if (s.startsWith("known affiliations") || s.startsWith("affiliations")) return "Known Affiliations";
  if (s.startsWith("reference")) return "Reference Images";
  if (s.startsWith("rp hooks")) return "RP Hooks";
  if (s.startsWith("additional")) return "Additional Notes";
  if (s === "real name") return "Real Name";
  if (s === "alias") return "Alias";
  // Title-case unknowns so they look nice in the UI.
  return l.split(/\s+/).map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}
function parseSheet(text: string) {
  const sections: Record<string, string> = {};
  const order: string[] = [];
  const lines = text.split(/\r?\n/);
  const preamble: string[] = [];
  let cur: string | null = null; let buf: string[] = [];
  const flush = () => {
    if (cur) {
      const k = canon(cur);
      if (!(k in sections)) order.push(k);
      const prev = sections[k];
      const j = buf.join("\n").trim();
      sections[k] = prev ? `${prev}\n\n${j}`.trim() : j;
    }
  };
  for (const raw of lines) {
    const line = raw;
    const inline = line.match(LABEL_RE);
    // Treat any markdown heading line (#, ##, ###) as a new section, using
    // its stripped text as the label. Headings without trailing ":" still
    // count — many threads style them that way.
    const isHeading = /^\s*#{1,6}\s+\S/.test(line);
    if (isHeading) {
      flush();
      cur = stripMd(line);
      buf = [];
    } else if (inline) {
      flush();
      cur = inline[1];
      buf = [inline[2] ?? ""];
    } else if (cur) {
      buf.push(line);
    } else if (line.trim()) {
      preamble.push(line);
    }
  }
  flush();
  // Drop empty sections (heading with no body underneath).
  for (const k of Object.keys(sections)) if (!sections[k]) delete sections[k];
  return { preamble: preamble.join("\n").trim(), sections, order };
}

// ---- image extraction ----
function extractImages(msgs: Message[]): { url: string; filename: string }[] {
  const out: { url: string; filename: string }[] = [];
  const push = (url: string, filename: string) => {
    if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)) out.push({ url, filename });
  };
  const pushAtt = (a: Attachment) => {
    if ((a.content_type ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(a.filename)) push(a.url, a.filename);
  };
  const pushEmbed = (e: Embed) => {
    const u = e.image?.url ?? e.thumbnail?.url;
    if (u) push(u, u.split("/").pop()?.split("?")[0] ?? "embed.png");
  };
  for (const m of msgs) {
    for (const a of m.attachments) pushAtt(a);
    for (const e of m.embeds) pushEmbed(e);
    for (const s of m.message_snapshots ?? []) {
      for (const a of s.message.attachments ?? []) pushAtt(a);
      for (const e of s.message.embeds ?? []) pushEmbed(e);
    }
  }
  return out;
}

// ---- rehost to object storage ----
async function rehost(srcUrl: string, filename: string): Promise<string | null> {
  try {
    const dl = await fetch(srcUrl, { signal: AbortSignal.timeout(20_000) });
    if (!dl.ok) { console.warn(`  download ${dl.status}: ${filename}`); return null; }
    const ct = dl.headers.get("content-type") ?? "image/png";
    const buf = Buffer.from(await dl.arrayBuffer());
    const req = await fetch(`${API_BASE}/api/storage/uploads/request-url`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: filename, size: buf.length, contentType: ct }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!req.ok) { console.warn(`  request-url ${req.status}`); return null; }
    const { uploadURL, objectPath } = (await req.json()) as { uploadURL: string; objectPath: string };
    const put = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": ct }, body: buf, signal: AbortSignal.timeout(30_000) });
    if (!put.ok) { console.warn(`  PUT ${put.status}`); return null; }
    return objectPath;
  } catch (e) { console.warn(`  rehost failed: ${(e as Error).message}`); return null; }
}

// ---- classify (best-effort) ----
type Kind = "portrait" | "stats" | "other";
async function classify(url: string): Promise<Kind> {
  const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  if (!baseURL || !apiKey) return "other";
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ baseURL, apiKey, maxRetries: 1 });
    const dl = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!dl.ok) return "other";
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length > 4_500_000) return "other";
    const ct = (dl.headers.get("content-type") ?? "image/png") as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    const r = await client.messages.create({
      model: "claude-haiku-4-5", max_tokens: 16,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: ct, data: buf.toString("base64") } },
        { type: "text", text: 'Cyberpunk RP character sheet image. Reply with exactly one word: STATS (VRChat stats panel: DOWNLOAD SIZE/TEXTURE MEMORY/TRIANGLES/BONES/PHYSBONE/MATERIAL SLOTS), PORTRAIT (avatar/face/outfit screenshot), or OTHER.' },
      ]}],
    }, { timeout: 25_000 });
    const t = (r.content[0]?.type === "text" ? r.content[0].text : "").trim().toUpperCase();
    if (t.startsWith("STATS")) return "stats";
    if (t.startsWith("PORTRAIT")) return "portrait";
    return "other";
  } catch { return "other"; }
}

// ---- main ----
const t = await findThread();
console.log(`\nUsing thread ${t.id}: ${t.name}`);
const msgs: Message[] = [];
{
  let before: string | undefined;
  for (let p = 0; p < 10; p++) {
    const q = new URLSearchParams({ limit: "100" });
    if (before) q.set("before", before);
    const batch = await dc<Message[]>(`/channels/${t.id}/messages?${q}`);
    if (!batch.length) break;
    msgs.push(...batch);
    if (batch.length < 100) break;
    before = batch.at(-1)!.id;
  }
  msgs.sort((a, b) => a.id.localeCompare(b.id));
}
const op = msgs[0];
const opAuthor = op.author.id;
// Concatenate every message by the thread's original author — many threads
// continue the sheet across follow-up posts because of Discord's 2k char limit.
const sheetText = msgs
  .filter((m) => m.author.id === opAuthor && m.content.trim().length > 0)
  .map((m) => m.content)
  .join("\n\n");
console.log(`OP by @${op.author.username} at ${op.timestamp}; ${msgs.length} total messages; concatenated sheet text = ${sheetText.length} chars`);

const { preamble, sections } = parseSheet(sheetText);
console.log(`Parsed sections (${Object.keys(sections).length}):`, Object.keys(sections));
if (preamble) console.log(`Preamble: ${preamble.slice(0, 120)}...`);

const imgs = extractImages(msgs);
console.log(`\nFound ${imgs.length} images. Classifying + rehosting...`);
const portraits: string[] = [];
const stats: string[] = [];
for (const im of imgs) {
  const kind = await classify(im.url);
  const hosted = await rehost(im.url, im.filename);
  console.log(`  [${kind.padEnd(8)}] ${hosted ?? "FAILED"}  <- ${im.filename}`);
  if (!hosted) continue;
  if (kind === "stats") stats.push(hosted);
  else if (kind === "portrait") portraits.push(hosted);
}

// ---- write to DB ----
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// Build sheet_data with sections; preserve any existing keys
const { rows: existing } = await client.query(`SELECT sheet_data FROM characters WHERE id=$1`, [TARGET_CHAR_ID]);
const prevSheet = (existing[0]?.sheet_data ?? {}) as Record<string, unknown>;
const newSheet = { ...prevSheet, sections, ...(preamble ? { preamble } : {}) };

const backstory = sections["Backstory"] ?? preamble ?? null;

await client.query(`
  UPDATE characters SET
    background = COALESCE($1, background),
    sheet_data = $2::jsonb,
    portrait_url = COALESCE($3, portrait_url),
    portrait_urls = CASE WHEN array_length($4::text[], 1) > 0 THEN $4::text[] ELSE portrait_urls END,
    stats_image_urls = CASE WHEN array_length($5::text[], 1) > 0 THEN $5::text[] ELSE stats_image_urls END,
    imported_from_thread_id = $6,
    imported_from_channel_name = 'character-sheets'
  WHERE id = $7
`, [backstory, JSON.stringify(newSheet), portraits[0] ?? null, portraits, stats, t.id, TARGET_CHAR_ID]);

const { rows: after } = await client.query(`
  SELECT name, length(background) bg_len,
         (SELECT count(*) FROM jsonb_object_keys(coalesce(sheet_data->'sections','{}'::jsonb))) sec_count,
         array_length(portrait_urls,1) ports, array_length(stats_image_urls,1) stats_n,
         portrait_url
  FROM characters WHERE id=$1
`, [TARGET_CHAR_ID]);
console.log(`\nDB after:`, after[0]);
await client.end();
