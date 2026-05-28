import { useMemo } from "react";

// Canonical slot list (from catalog_cyberware). Order matters — this is the
// order rendered. Aliases below normalize free-form sheet headings to one of
// these canonical names.
const SLOTS = [
  "Neural",
  "Ocular System",
  "Auditory System",
  "Integumentary System",
  "Circulatory & Immune Systems",
  "Skeleton & Torso Musculature",
  "Universal Muscular (Arms/Legs/Tail)",
  "Arms & Arm Attachments",
  "Hands & Feet",
  "Legs & Mobility",
  "Miscellaneous",
] as const;

type Slot = (typeof SLOTS)[number];

const ALIASES: Record<string, Slot> = {
  // exact canonical
  ...Object.fromEntries(SLOTS.map((s) => [normalize(s), s])) as Record<string, Slot>,
  // common variants / typos
  [normalize("Skeleton & Torso Muscolature")]: "Skeleton & Torso Musculature",
  [normalize("Skeleton and Torso Musculature")]: "Skeleton & Torso Musculature",
  [normalize("Torso & Skeleton")]: "Skeleton & Torso Musculature",
  [normalize("Arms")]: "Arms & Arm Attachments",
  [normalize("Arm Attachments")]: "Arms & Arm Attachments",
  [normalize("Arms and Arm Attachments")]: "Arms & Arm Attachments",
  [normalize("Hands and Feet")]: "Hands & Feet",
  [normalize("Feet")]: "Hands & Feet",
  [normalize("Hands")]: "Hands & Feet",
  [normalize("Legs")]: "Legs & Mobility",
  [normalize("Legs and Mobility")]: "Legs & Mobility",
  [normalize("Mobility")]: "Legs & Mobility",
  [normalize("Ocular")]: "Ocular System",
  [normalize("Eyes")]: "Ocular System",
  [normalize("Auditory")]: "Auditory System",
  [normalize("Ears")]: "Auditory System",
  [normalize("Skin")]: "Integumentary System",
  [normalize("Integumentary")]: "Integumentary System",
  [normalize("Circulatory")]: "Circulatory & Immune Systems",
  [normalize("Circulatory and Immune")]: "Circulatory & Immune Systems",
  [normalize("Immune")]: "Circulatory & Immune Systems",
  [normalize("Muscular")]: "Universal Muscular (Arms/Legs/Tail)",
  [normalize("Universal Muscular")]: "Universal Muscular (Arms/Legs/Tail)",
  [normalize("Misc")]: "Miscellaneous",
  [normalize("Other")]: "Miscellaneous",
  [normalize("Cyberdeck")]: "Neural",
  [normalize("Brain")]: "Neural",
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveSlot(label: string): Slot | null {
  return ALIASES[normalize(label)] ?? null;
}

type Item = { name: string; cwp: number | null; description: string | null };

// Pull a "<n> CWP" / "<n> point(s)" cost out of an item line. Returns the
// numeric cost (if any) and the remaining line text with that token removed.
function extractCwp(raw: string): { cwp: number | null; remainder: string } {
  // Match (2 CWP), [2 CWP], - 2 CWP, 2 CWP, 2 Points, 2 pts, etc.
  const patterns = [
    /[\s\-–—(\[]\s*(\d+(?:\.\d+)?)\s*(?:cwp|c\.w\.p\.?|points?|pts?\.?)\s*[)\]]?/i,
    /[\s(\[]\s*(\d+(?:\.\d+)?)\s*(?:cwp|c\.w\.p\.?|points?|pts?\.?)\s*[)\]]/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m.index !== undefined) {
      const cwp = parseFloat(m[1]);
      const remainder = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length))
        .replace(/\(\s*\)|\[\s*\]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      return { cwp: Number.isFinite(cwp) ? cwp : null, remainder };
    }
  }
  return { cwp: null, remainder: raw.trim() };
}

// Split an item line into name + description on the first dash/em-dash that
// looks like a separator (surrounded by spaces).
function splitNameDesc(line: string): { name: string; description: string | null } {
  const m = line.match(/^(.*?)\s+[-–—:]\s+(.+)$/);
  if (m) return { name: m[1].trim().replace(/[.,;:]+$/, ""), description: m[2].trim() };
  return { name: line.trim().replace(/[.,;:]+$/, ""), description: null };
}

function parseItemLine(raw: string): Item | null {
  // Strip bullet markers, leading dashes, list markers, surrounding emoji.
  let s = raw
    .replace(/^[\s>•·▪●◦*+\-–—]+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
  // Strip standalone emoji prefix (preserves emoji in body if any).
  s = s.replace(/^[\p{Extended_Pictographic}\u200d\uFE0F]+\s*/u, "").trim();
  if (!s) return null;
  if (/^none\b\.?$/i.test(s)) return null;
  const { cwp, remainder } = extractCwp(s);
  if (!remainder) return null;
  const { name, description } = splitNameDesc(remainder);
  if (!name) return null;
  return { name, cwp, description };
}

type ParseResult = {
  preamble: string | null;
  groups: { slot: Slot; items: Item[] }[];
  uncategorized: Item[];
  rawFallback: string | null;
};

export function parseCyberwareBody(body: string): ParseResult {
  const lines = body.replace(/\r\n/g, "\n").split("\n");

  // Detect "Slot: items" prefix on a line. We split on the FIRST colon and
  // check if the lhs maps to a canonical slot.
  function detectSlotPrefix(line: string): { slot: Slot; rest: string } | null {
    const cleaned = line.replace(/^[\s>•·▪●◦*+\-–—]+/, "").trim();
    // Allow optional leading bold/markdown wrappers around the label.
    const m = cleaned.match(/^(?:\*+|__|>+)?\s*([^:]+?)\s*(?:\*+|__)?\s*:\s*(.*)$/);
    if (!m) return null;
    const slot = resolveSlot(m[1]);
    if (!slot) return null;
    return { slot, rest: m[2].trim() };
  }

  let currentSlot: Slot | null = null;
  const preambleLines: string[] = [];
  const byslot = new Map<Slot, Item[]>();
  const uncategorized: Item[] = [];
  let sawAnySlot = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      currentSlot = null;
      continue;
    }
    const prefix = detectSlotPrefix(line);
    if (prefix) {
      sawAnySlot = true;
      currentSlot = prefix.slot;
      if (!byslot.has(currentSlot)) byslot.set(currentSlot, []);
      if (prefix.rest) {
        // Inline item(s) on the same line as the slot header. Split on
        // common list separators when multiple items share a line.
        const inline = prefix.rest
          .split(/\s+(?:,|;|\band\b|\/)\s+/i)
          .map(parseItemLine)
          .filter((x): x is Item => !!x);
        byslot.get(currentSlot)!.push(...inline);
      }
      continue;
    }
    const item = parseItemLine(line);
    if (!item) continue;
    if (currentSlot) {
      byslot.get(currentSlot)!.push(item);
    } else if (sawAnySlot) {
      uncategorized.push(item);
    } else {
      preambleLines.push(line);
    }
  }

  // Build the rendered slot order, only including slots that have items.
  const groups: { slot: Slot; items: Item[] }[] = [];
  for (const slot of SLOTS) {
    const items = byslot.get(slot);
    if (items && items.length > 0) groups.push({ slot, items });
  }

  // If we never saw a recognizable slot prefix AND parsed nothing useful,
  // fall back to rendering the raw body so we don't blank the section.
  const rawFallback =
    !sawAnySlot && groups.length === 0 && uncategorized.length === 0 ? body.trim() || null : null;

  return {
    preamble: preambleLines.length > 0 ? preambleLines.join("\n") : null,
    groups,
    uncategorized,
    rawFallback,
  };
}

function totalCwp(parsed: ParseResult): number | null {
  let any = false;
  let sum = 0;
  for (const g of parsed.groups) {
    for (const it of g.items) if (it.cwp != null) { sum += it.cwp; any = true; }
  }
  for (const it of parsed.uncategorized) if (it.cwp != null) { sum += it.cwp; any = true; }
  return any ? sum : null;
}

export default function CyberwareSection({ body }: { body: string }) {
  const parsed = useMemo(() => parseCyberwareBody(body), [body]);
  const total = totalCwp(parsed);
  const hasAny = parsed.groups.length > 0 || parsed.uncategorized.length > 0;

  if (parsed.rawFallback) {
    return (
      <div className="font-mono text-sm whitespace-pre-wrap text-foreground/90" data-testid="cyberware-raw">
        {parsed.rawFallback}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="cyberware-section">
      {parsed.preamble ? (
        <p className="font-mono text-sm italic text-muted-foreground whitespace-pre-wrap">{parsed.preamble}</p>
      ) : null}

      {!hasAny ? (
        <div className="font-mono text-sm italic text-muted-foreground">No chrome installed.</div>
      ) : (
        <>
          {parsed.groups.map((g) => (
            <SlotGroup key={g.slot} slot={g.slot} items={g.items} />
          ))}
          {parsed.uncategorized.length > 0 ? (
            <SlotGroup slot={"Miscellaneous" as Slot} items={parsed.uncategorized} label="UNCATEGORIZED" />
          ) : null}
        </>
      )}

      {total != null ? (
        <div
          className="flex items-center justify-between border-t border-border pt-3 font-display tracking-widest text-sm"
          data-testid="cyberware-total"
        >
          <span className="text-muted-foreground">TOTAL CWP</span>
          <span className="text-nc-cyan">{total}</span>
        </div>
      ) : null}
    </div>
  );
}

function SlotGroup({ slot, items, label }: { slot: Slot; items: Item[]; label?: string }) {
  return (
    <div className="border border-border/60 bg-background/30" data-testid={`cw-slot-${normalize(slot)}`}>
      <div className="flex items-center justify-between border-b border-border/60 bg-card/40 px-3 py-1.5">
        <span className="font-display text-xs tracking-widest text-nc-cyan">{label ?? slot.toUpperCase()}</span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {items.length} ITEM{items.length === 1 ? "" : "S"}
        </span>
      </div>
      <ul className="divide-y divide-border/40">
        {items.map((it, i) => (
          <li
            key={`${it.name}-${i}`}
            className="flex items-start gap-3 px-3 py-2 text-sm font-mono"
            data-testid={`cw-item-${i}`}
          >
            <div className="flex-1 min-w-0">
              <div className="text-foreground">{it.name}</div>
              {it.description ? (
                <div className="mt-0.5 text-xs text-muted-foreground">{it.description}</div>
              ) : null}
            </div>
            <span
              className={`shrink-0 font-display tracking-widest text-xs px-2 py-0.5 border ${
                it.cwp != null
                  ? "border-nc-cyan/60 text-nc-cyan"
                  : "border-border text-muted-foreground"
              }`}
            >
              {it.cwp != null ? `${it.cwp} CWP` : "— CWP"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Heuristic: does this sheet section heading look like the cyberware bucket?
export function isCyberwareHeading(heading: string): boolean {
  const n = normalize(heading);
  return (
    n.includes("chrome") ||
    n.includes("implant") ||
    n.includes("cyberware") ||
    n.includes("cyberwear")
  );
}
