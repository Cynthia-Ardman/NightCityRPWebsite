/**
 * Re-fetch OP text from Discord for every prod character whose
 * imported_from_thread_id is set but whose sheet_data ended up empty
 * (the original parser didn't find any labeled sections AND threw the
 * raw OP text away). Try parseSheet again; if it still finds nothing,
 * stuff the raw OP text into sheet_data.preamble and background so the
 * player at least has their content back.
 *
 *   DATABASE_URL="$LIVE_PROD_DATABASE_URL" \
 *     pnpm --filter @workspace/scripts exec tsx src/refetch-empty-sheets.ts [--dry-run]
 */
import { db, characters } from "@workspace/db";
import { eq, inArray, isNotNull, sql } from "drizzle-orm";

const DRY = process.argv.includes("--dry-run");
// --all: re-parse every imported character (including ones that already have
// some sections). Used to fix characters whose previous parse swallowed
// subsections into a previous section because the player used emoji-prefixed
// headings without trailing ":".
const REPARSE_ALL = process.argv.includes("--all");
function argInt(name: string, fallback: number): number {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  if (!a) return fallback;
  const n = parseInt(a.split("=")[1], 10);
  return Number.isFinite(n) ? n : fallback;
}
const OFFSET = argInt("offset", 0);
const LIMIT = argInt("limit", Number.POSITIVE_INFINITY);
const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN missing");
  process.exit(1);
}

const API = "https://discord.com/api/v10";
async function discord<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bot ${TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 429) {
      const body = await r.json().catch(() => ({ retry_after: 2 }));
      await new Promise((res) =>
        setTimeout(res, Math.ceil((body.retry_after ?? 2) * 1000)),
      );
      continue;
    }
    if (r.status === 404) return null as T;
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`discord ${r.status}: ${path} ${text.slice(0, 200)}`);
    }
    return (await r.json()) as T;
  }
  throw new Error(`discord rate-limit retries exhausted: ${path}`);
}

type Message = {
  id: string;
  author: { id: string; username: string };
  content: string;
  message_snapshots?: Array<{ message: { content?: string } }>;
};

async function fetchAllMessages(threadId: string): Promise<Message[]> {
  const out: Message[] = [];
  let before: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ limit: "100" });
    if (before) q.set("before", before);
    const batch = await discord<Message[] | null>(
      `/channels/${threadId}/messages?${q.toString()}`,
    );
    if (!batch || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
    before = batch[batch.length - 1].id;
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// --- sheet parser (copy of import-character-sheets.ts) ---
const SECTION_LABELS = [
  "Name", "Age", "Pronouns",
  "Occupation / Role in Night City", "Occupation",
  "Psychological Profile", "Physical Description",
  "Chrome / Implants", "Total Cyberware Points",
  "Skills / Talents / Abilities", "Skills",
  "Equipment / Armor / Weapons", "Equipment",
  "Backstory", "Known Affiliations", "Affiliations",
  "Reference Image(s)", "Reference Images",
  "RP Hooks", "Additional Notes",
];
// Matches lines like:
//   "Backstory:" or "Backstory: some text"
//   "🦾 Chrome / Implants"            (no colon, label alone on line)
//   "🔧 Equipment (Weapons and Other Gear):"  (parenthetical annotation)
// Up to 8 leading non-letter chars covers emoji + space prefixes.
const LABEL_RE = new RegExp(
  `^[^\\p{L}\\n]{0,8}(${SECTION_LABELS.map((l) =>
    l.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"),
  ).join("|")})(?:\\s*\\([^)]*\\))?\\s*(?::\\s*(.*)|\\s*)$`,
  "iu",
);
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
function parseSheet(text: string) {
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

// Strip [legacy:uuid] anchors from background.
function stripLegacyTag(s: string | null): string {
  return (s ?? "").replace(/\[legacy:[a-f0-9-]+\]/gi, "").trim();
}

// Players sometimes paste the same backstory multiple times into the thread
// (cross-channel re-posts, edits, the original importer concatenating
// duplicate messages). Split into paragraphs and drop later copies of any
// long-enough paragraph we've already seen. Short paragraphs (single
// sentences, separators like "---") are left alone — they can legitimately
// repeat.
function dedupeParagraphs(text: string): string {
  const paras = text.split(/\n{2,}/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paras) {
    const key = p.trim().replace(/\s+/g, " ");
    if (key.length >= 100 && seen.has(key)) continue;
    if (key.length >= 100) seen.add(key);
    out.push(p);
  }
  return out.join("\n\n").trim();
}

// Strip Discord/markdown emphasis markers around a short label so a value
// like "**  \nBio-engineered tracker" reduces to "Bio-engineered tracker".
function cleanLabelValue(s: string | null | undefined): string {
  if (!s) return "";
  // Drop empty bold runs ("** **" or "** \n"), then collapse remaining `**`
  // bold markers (we keep the text inside), then trim.
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/\*\*\s*\*\*/g, "").replace(/[*_~`]+/g, "").trim())
    .filter((l) => l.length > 0)[0] ?? "";
}

function deriveArchetype(sections: Record<string, string>): string | null {
  const raw = sections["Occupation"] ?? sections["Occupation / Role in Night City"] ?? "";
  const v = cleanLabelValue(raw).slice(0, 200);
  return v || null;
}

// --- main ---
const empties = await db
  .select({
    id: characters.id,
    name: characters.name,
    ownerId: characters.ownerId,
    threadId: characters.importedFromThreadId,
    archetype: characters.archetype,
    background: characters.background,
    sheetData: characters.sheetData,
  })
  .from(characters)
  .where(
    REPARSE_ALL
      ? sql`${characters.importedFromThreadId} IS NOT NULL`
      : sql`${characters.importedFromThreadId} IS NOT NULL
        AND (${characters.sheetData} IS NULL
             OR ${characters.sheetData} = '{"preamble":"","sections":{}}'::jsonb
             OR (${characters.sheetData}->>'preamble' = ''
                 AND (SELECT count(*) FROM jsonb_object_keys(${characters.sheetData}->'sections')) = 0))`,
  );

console.log(`Found ${empties.length} characters to ${REPARSE_ALL ? "re-parse" : "recover"}.`);

// Stable order so --offset/--limit slices are reproducible across runs.
empties.sort((a, b) => a.id - b.id);
const slice = empties.slice(OFFSET, OFFSET + LIMIT);
console.log(`Processing slice offset=${OFFSET} limit=${LIMIT === Number.POSITIVE_INFINITY ? "all" : LIMIT} -> ${slice.length} characters.`);

let recovered = 0;
let parsedSections = 0;
let noText = 0;
let errors = 0;

for (let i = 0; i < slice.length; i++) {
  const c = slice[i];
  const tag = `[${i + 1}/${slice.length} abs=${OFFSET + i + 1}] #${c.id} "${c.name}"`;
  try {
    const msgs = await fetchAllMessages(c.threadId!);
    if (msgs.length === 0) {
      console.log(`${tag} no messages (thread gone?)`);
      noText++;
      continue;
    }
    // Take text from the thread creator (== first message author),
    // or from any message whose author matches the character's ownerId.
    const firstAuthor = msgs[0].author.id;
    const opAuthor = c.ownerId ?? firstAuthor;
    const opMessages = msgs.filter((m) => m.author.id === opAuthor);
    const fallback = opMessages.length === 0 ? msgs.filter((m) => m.author.id === firstAuthor) : opMessages;
    const text = fallback
      .map((m) => {
        const parts = [m.content];
        for (const s of m.message_snapshots ?? []) {
          if (s.message.content) parts.push(s.message.content);
        }
        return parts.filter(Boolean).join("\n");
      })
      .filter((s) => s.trim().length > 0)
      .join("\n\n")
      .trim();

    if (!text) {
      console.log(`${tag} no OP text (only images?)`);
      noText++;
      continue;
    }

    const parsed = parseSheet(text);
    const hasSections = Object.keys(parsed.sections).length > 0;
    const hasPreamble = parsed.preamble.length > 0;

    if (!hasSections && !hasPreamble) {
      console.log(`${tag} parser+preamble both empty (?)`);
      noText++;
      continue;
    }

    // Build a usable background: prefer parsed Backstory section, falling back
    // to preamble or existing stored background. Then dedupe repeated
    // paragraphs from re-posts. We rebuild from the freshly-fetched OP rather
    // than concatenating existing+new — concatenating is what produced the 3x
    // duplicates in the first place.
    const existingBg = stripLegacyTag(c.background);
    const bgSource =
      parsed.sections["Backstory"]?.trim() ||
      parsed.preamble?.trim() ||
      existingBg ||
      text.slice(0, 4000);
    const newBackground = dedupeParagraphs(bgSource).slice(0, 16000);

    // Re-derive archetype only if currently empty — never clobber an
    // admin/player-set value.
    const currentArchetype = (c.archetype ?? "").trim();
    const derivedArchetype = deriveArchetype(parsed.sections);
    const newArchetype =
      currentArchetype.length === 0 && derivedArchetype ? derivedArchetype : null;

    if (DRY) {
      console.log(
        `${tag} would-set sections=${Object.keys(parsed.sections).length} preambleLen=${parsed.preamble.length} bgLen=${newBackground.length}${newArchetype ? ` archetype="${newArchetype.slice(0, 40)}"` : ""}`,
      );
      recovered++;
      if (hasSections) parsedSections++;
      continue;
    }

    await db
      .update(characters)
      .set({
        sheetData: parsed,
        background: newBackground,
        ...(newArchetype ? { archetype: newArchetype } : {}),
      })
      .where(eq(characters.id, c.id));

    console.log(
      `${tag} updated sections=${Object.keys(parsed.sections).length} preambleLen=${parsed.preamble.length} bgLen=${newBackground.length}${newArchetype ? ` archetype="${newArchetype.slice(0, 40)}"` : ""}`,
    );
    recovered++;
    if (hasSections) parsedSections++;
  } catch (e: any) {
    console.log(`${tag} ERROR ${e.message}`);
    errors++;
  }
  // small pause to be nice to Discord
  await new Promise((r) => setTimeout(r, 200));
}

console.log(
  `\nDone. recovered=${recovered} withSections=${parsedSections} noText=${noText} errors=${errors}`,
);
process.exit(0);
