// One-off operational script (Task #188): snapshot the public Google Docs/Sheets
// that the guidebook links out to into native on-site "Reference Library" pages.
// Docs become readable prose; sheets become on-site Markdown tables. The cyberware
// sheets are intentionally NOT converted here — the site already covers that data
// via /catalog/cyberware, so the importer maps those links to the catalog instead.
//
// Each created page records its origin Google url in `sources`; the guidebook
// importer (buildDocLinkMap) reads that to rewrite the original Google links to
// the new on-site page. Run this BEFORE re-running import-guidebook so the pages
// exist when the importer resolves the links.
//
// Idempotent: re-running upserts by slug (refreshes body/sources in place).
//
// Usage (from repo root):
//   GUIDEBOOK_IMPORT_TARGET=dev  pnpm --filter @workspace/api-server exec tsx src/scripts/apply-task188-pages.ts
//   GUIDEBOOK_IMPORT_TARGET=prod pnpm --filter @workspace/api-server exec tsx src/scripts/apply-task188-pages.ts
//
// Targeting prod requires LIVE_PROD_DATABASE_URL and is refused otherwise.

export {};

const target = (process.env.GUIDEBOOK_IMPORT_TARGET ?? "").toLowerCase();
if (target === "prod") {
  if (!process.env.LIVE_PROD_DATABASE_URL) {
    console.error("GUIDEBOOK_IMPORT_TARGET=prod requires LIVE_PROD_DATABASE_URL; refusing to run.");
    process.exit(1);
  }
  process.env.DATABASE_URL = process.env.LIVE_PROD_DATABASE_URL;
} else if (target === "dev") {
  const url = process.env.DATABASE_URL ?? "";
  const looksProd =
    !!process.env.LIVE_PROD_DATABASE_URL && url === process.env.LIVE_PROD_DATABASE_URL;
  if (looksProd) {
    console.error("GUIDEBOOK_IMPORT_TARGET=dev but DATABASE_URL points at the prod DB; refusing to run.");
    process.exit(1);
  }
} else {
  console.error("Set GUIDEBOOK_IMPORT_TARGET=dev or prod");
  process.exit(1);
}

// NOTE: do not statically import modules that pull in @workspace/db here — the
// db pool reads DATABASE_URL at module load, which must happen only AFTER the
// dev/prod guard above reassigns it. SECTION is resolved via dynamic import in
// main() for the same reason (keeps it in lockstep with LIBRARY_SECTION).

type Resource = {
  slug: string;
  title: string;
  description: string;
  kind: "doc" | "sheet";
  fileId: string;
  sourceLabel: string;
  position: number;
  // Drop the first content line of a doc when it merely repeats the title.
  dropFirstTitle?: boolean;
};

const RESOURCES: Resource[] = [
  {
    slug: "strong-character-guide",
    title: "Creating a Strong Character for Night City RP",
    description: "A guide to building a deep, immersive character that fits Night City.",
    kind: "doc",
    fileId: "1GHwRh0lz4-PSGR1S3_SEygHcX7kI4i3ZsuOmiScKUtU",
    sourceLabel: "Strong Character Guide",
    position: 0,
    dropFirstTitle: true,
  },
  {
    slug: "character-concepts-list",
    title: "Character Concepts List",
    description: "Ready-made character concepts to spark ideas for your build.",
    kind: "doc",
    fileId: "1Ba_Q_33xKExFM5GaEpQOL-5gwMrGbsZx7ZJdc_0r6pI",
    sourceLabel: "Character Concepts List",
    position: 1,
  },
  {
    slug: "housing-business-status",
    title: "Housing & Business Status",
    description: "Current ownership and occupancy snapshot for housing and businesses.",
    kind: "sheet",
    fileId: "1Z9RfZfYWM0xASx-0wDbCwLlzX2G6DLxgW1bwO65EedA",
    sourceLabel: "Housing & Business Status",
    position: 2,
  },
];

function docExportUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/export?format=txt`;
}
function sheetExportUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}
// Canonical url stored as provenance; the file id is what the importer keys off.
function docSourceUrl(r: Resource): string {
  const kind = r.kind === "doc" ? "document" : "spreadsheets";
  return `https://docs.google.com/${kind}/d/${r.fileId}/edit`;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  return await res.text();
}

// --- Google Doc plain text -> readable Markdown ----------------------------
// The txt export keeps paragraph/section structure but loses styling, so we
// re-derive light structure heuristically: numbered headings, bullets, labelled
// lines (`Role: ...`), lead-in sub-headings (`...:`), quotes, and `----` rules.
function docTextToMarkdown(raw: string, dropFirstTitle: boolean): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let prevType = "";
  let firstSeen = false;

  const push = (type: string, text: string) => {
    if (out.length) {
      // Keep consecutive list items adjacent; separate everything else.
      if (!(type === "li" && prevType === "li")) out.push("");
    }
    out.push(text);
    prevType = type;
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    if (!firstSeen) {
      firstSeen = true;
      if (dropFirstTitle) continue; // first line repeats the page title
    }

    if (/^_{3,}$/.test(t) || /^—{3,}$/.test(t)) {
      if (prevType !== "hr") push("hr", "---");
      continue;
    }
    if (/^\d+\.\s+\S/.test(t)) {
      push("h2", `## ${t}`);
      continue;
    }
    if (/^[*•‣◦·-]\s+/.test(t)) {
      push("li", `- ${t.replace(/^[*•‣◦·-]\s+/, "")}`);
      continue;
    }
    if (/^[✅✔☑]/.test(t)) {
      push("li", `- ${t}`);
      continue;
    }
    const labelled = t.match(/^([A-Z][A-Za-z0-9 '&/().-]{0,40}?):\s+(.+)$/);
    if (labelled) {
      push("p", `**${labelled[1]}:** ${labelled[2]}`);
      continue;
    }
    // Short lead-in line ending in a colon -> bold sub-heading.
    if (/:$/.test(t) && t.length <= 80 && !/[.!?]/.test(t.slice(0, -1))) {
      push("p", `**${t}**`);
      continue;
    }
    if (/^["“]/.test(t)) {
      push("quote", `> ${t}`);
      continue;
    }
    push("p", t);
  }

  return out.join("\n").trim();
}

// --- CSV parsing + Google Sheet -> Markdown table --------------------------
function parseCsv(text: string): string[][] {
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

function cleanCell(v: string): string {
  return (v ?? "")
    .replace(/\s*\n\s*/g, " / ") // collapse intra-cell line breaks
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|") // never break out of the table
    .trim();
}

function csvToMarkdownTable(
  csv: string,
  opts: { dropHeaders?: string[]; forwardFill?: string[] },
): string {
  const rows = parseCsv(csv).filter((r) => r.some((c) => (c ?? "").trim() !== ""));
  if (rows.length === 0) return "";
  const headers = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1);

  const dropSet = new Set((opts.dropHeaders ?? []).map((h) => h.toLowerCase()));
  // Keep a column unless it is explicitly dropped or empty across every row.
  const keepIdx: number[] = [];
  for (let c = 0; c < headers.length; c++) {
    if (dropSet.has(headers[c].toLowerCase())) continue;
    const hasData = dataRows.some((r) => (r[c] ?? "").trim() !== "");
    if (!hasData) continue;
    keepIdx.push(c);
  }

  const fillSet = new Set((opts.forwardFill ?? []).map((h) => h.toLowerCase()));
  const lastFill = new Map<number, string>();

  const headerLine = `| ${keepIdx.map((c) => cleanCell(headers[c]) || " ").join(" | ")} |`;
  const sepLine = `| ${keepIdx.map(() => "---").join(" | ")} |`;
  const bodyLines: string[] = [];

  for (const r of dataRows) {
    const cells = keepIdx.map((c) => {
      let v = cleanCell(r[c] ?? "");
      if (fillSet.has(headers[c].toLowerCase())) {
        if (v) lastFill.set(c, v);
        else v = lastFill.get(c) ?? "";
      }
      return v || " ";
    });
    bodyLines.push(`| ${cells.join(" | ")} |`);
  }

  return [headerLine, sepLine, ...bodyLines].join("\n");
}

async function buildBody(r: Resource): Promise<string> {
  if (r.kind === "doc") {
    const txt = await fetchText(docExportUrl(r.fileId));
    return docTextToMarkdown(txt, !!r.dropFirstTitle);
  }
  const csv = await fetchText(sheetExportUrl(r.fileId));
  const table = csvToMarkdownTable(csv, {
    dropHeaders: ["Pic", "UserID"],
    forwardFill: ["Tier", "Building"],
  });
  const note =
    "*Snapshot of the community housing & business sheet — not live. See the source link for the latest.*";
  return `${note}\n\n${table}`;
}

async function main() {
  const dbMod = await import("@workspace/db");
  const { db, guidebookPages, pool } = dbMod;
  const { eq, sql } = await import("drizzle-orm");
  const { LIBRARY_SECTION: SECTION } = await import("../lib/guidebookImport");

  let host = "unknown";
  try {
    host = new URL(process.env.DATABASE_URL!).host;
  } catch {
    /* ignore */
  }
  console.log(`Target: ${host} (${target.toUpperCase()})`);

  const before = await db.select({ n: sql<number>`count(*)::int` }).from(guidebookPages);
  console.log(`Existing pages before: ${before[0]?.n ?? 0}\n`);

  for (const r of RESOURCES) {
    try {
      const body = await buildBody(r);
      if (!body.trim()) throw new Error("converted body was empty");
      const sources = [{ label: `${r.sourceLabel} (Google ${r.kind === "doc" ? "Doc" : "Sheet"})`, url: docSourceUrl(r) }];

      const [existing] = await db
        .select({
          id: guidebookPages.id,
          section: guidebookPages.section,
          editedSinceImport: guidebookPages.editedSinceImport,
        })
        .from(guidebookPages)
        .where(eq(guidebookPages.slug, r.slug));

      if (existing && existing.section !== SECTION) {
        console.error(
          `  [ERROR]    ${r.slug} (page #${existing.id}) — slug already used by section "${existing.section}"; refusing to overwrite`,
        );
        continue;
      }

      if (!existing) {
        const [created] = await db
          .insert(guidebookPages)
          .values({
            section: SECTION,
            title: r.title,
            slug: r.slug,
            description: r.description,
            body,
            images: [] as never,
            sources: sources as never,
            position: r.position,
            discordChannelId: null,
            sourceLabel: r.sourceLabel,
            importedAt: new Date(),
            editedSinceImport: false,
          })
          .returning({ id: guidebookPages.id });
        console.log(`  [CREATED]  ${r.slug} (page #${created.id})`);
        continue;
      }

      if (existing.editedSinceImport) {
        console.log(`  [SKIPPED]  ${r.slug} (page #${existing.id}) — edited on-site, not overwriting`);
        continue;
      }

      await db
        .update(guidebookPages)
        .set({
          section: SECTION,
          title: r.title,
          description: r.description,
          body,
          images: [] as never,
          sources: sources as never,
          position: r.position,
          sourceLabel: r.sourceLabel,
          importedAt: new Date(),
          editedSinceImport: false,
          updatedAt: new Date(),
        })
        .where(eq(guidebookPages.id, existing.id));
      console.log(`  [UPDATED]  ${r.slug} (page #${existing.id})`);
    } catch (err) {
      console.error(`  [ERROR]    ${r.slug} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const after = await db.select({ n: sql<number>`count(*)::int` }).from(guidebookPages);
  console.log(`\nPages now: ${after[0]?.n ?? 0}`);
  await pool.end();
}

main().catch((err) => {
  console.error("apply-task188-pages failed:", err);
  process.exit(1);
});
