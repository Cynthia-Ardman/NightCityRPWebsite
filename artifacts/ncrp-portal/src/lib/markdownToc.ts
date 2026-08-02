// Table-of-contents extraction for guidebook markdown bodies, plus the shared
// heading-id slugger. The Markdown component (headingAnchors mode) derives ids
// from rendered heading text with the SAME slugify + dedupe rules, so the ids
// produced here always match the anchors in the rendered page.

export type TocEntry = { level: number; text: string; id: string };

// "**📜 Server Rules**" -> "server-rules". Drops markdown emphasis markers,
// emoji and any other non-alphanumerics.
export function slugifyHeading(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[*_`~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Strip inline markdown decoration for display text.
function displayText(raw: string): string {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

/** Dedupe helper shared by extractor and renderer: same base slug appearing
 * again gets a -2 / -3 … suffix. */
export function makeSlugDeduper(): (base: string) => string {
  const seen = new Map<string, number>();
  return (base) => {
    const b = base || "section";
    const n = (seen.get(b) ?? 0) + 1;
    seen.set(b, n);
    return n === 1 ? b : `${b}-${n}`;
  };
}

/** Parse ATX headings (levels 1-4) from a markdown body, skipping fenced code
 * blocks. Returns entries in document order with deduped anchor ids. */
export function extractToc(body: string): TocEntry[] {
  const out: TocEntry[] = [];
  const dedupe = makeSlugDeduper();
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = displayText(m[2]);
    if (!text) continue;
    out.push({ level: m[1].length, text, id: dedupe(slugifyHeading(m[2])) });
  }
  return out;
}
