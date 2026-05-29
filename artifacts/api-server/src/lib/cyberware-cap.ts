// Pure cyberware-CWP helpers used by sheet submission validation.
//
// These are intentionally kept free of any database or framework imports so the
// 6-CWP creation cap can be exercised by fast, isolated unit tests. The catalog
// is the single source of truth for an install's cost: the client never sends a
// trustworthy CWP value for catalog items, so a crafted payload cannot bypass
// the cap by under-reporting (or negating) the cost of a catalog install.

export const MAX_CREATION_CWP = 6;

export type CyberwareEntry = { name?: string; points?: number };

// Collects every cyberware entry regardless of which (current or legacy) field
// it lives in, so CWP totals stay correct for older records too.
export function collectCyberware(d: Record<string, unknown>): CyberwareEntry[] {
  const current = Array.isArray(d.cyberware) ? (d.cyberware as CyberwareEntry[]) : [];
  if (current.length > 0) return current.filter((c) => typeof c.name === "string" && c.name.trim().length > 0);
  // Legacy fallback: foundational-by-slot + misc lists.
  const bySlot = Array.isArray(d.cyberwareBySlot) ? (d.cyberwareBySlot as CyberwareEntry[]) : [];
  const misc = Array.isArray(d.cyberwareMisc) ? (d.cyberwareMisc as CyberwareEntry[]) : [];
  return [...bySlot, ...misc].filter((c) => typeof c.name === "string" && c.name.trim().length > 0);
}

// Builds a lookup of catalog cyberware CWP cost keyed by normalized name. Where
// multiple catalog rows share a name the highest CWP wins, so a crafted payload
// can't pick a cheaper duplicate or dodge the match with a tampered slot. The
// catalog stores cwp as nullable text, so non-numeric / null values resolve to 0.
export function buildCyberwareCostMap(rows: Array<{ name: string; cwp: string | null }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (!key) continue;
    const cost = Number(r.cwp) || 0;
    const prev = map.get(key);
    if (prev === undefined || cost > prev) map.set(key, cost);
  }
  return map;
}

// Resolves the CWP an entry actually costs. For any entry whose name matches a
// catalog item, the catalog's CWP is authoritative and the client-sent `points`
// is ignored — this is what makes the 6-CWP creation cap tamper-proof. Custom
// (non-catalog) entries fall back to their client-sent value.
export function entryPoints(c: CyberwareEntry, costMap: Map<string, number>): number {
  const key = (c.name ?? "").trim().toLowerCase();
  const catalogCost = costMap.get(key);
  if (catalogCost !== undefined) return catalogCost;
  return Number(c.points) || 0;
}

// Validates the cyberware portion of a sheet against the creation cap. Returns
// null on success, or an error message on failure. Catalog costs override the
// client-sent value; negatives are rejected so they can't offset over-cap entries.
export function validateCyberware(entries: CyberwareEntry[], costMap: Map<string, number>): string | null {
  const effective = entries.map((c) => entryPoints(c, costMap));
  if (effective.some((p) => p < 0)) {
    return "Cyberware CWP cannot be negative";
  }
  const points = effective.reduce((s, p) => s + p, 0);
  if (points > MAX_CREATION_CWP) return `Max ${MAX_CREATION_CWP} cyberware points (CWP) at creation`;
  return null;
}
