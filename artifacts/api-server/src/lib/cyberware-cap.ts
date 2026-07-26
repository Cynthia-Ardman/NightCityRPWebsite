// Pure cyberware-CWP helpers used by sheet submission validation.
//
// These are intentionally kept free of any database or framework imports so the
// 6-CWP creation cap can be exercised by fast, isolated unit tests. The catalog
// is the single source of truth for an install's cost: the client never sends a
// trustworthy CWP value for catalog items, so a crafted payload cannot bypass
// the cap by under-reporting (or negating) the cost of a catalog install.

import { normalizeName } from "./strings";

export const MAX_CREATION_CWP = 6;

// Total cyberware-points a character may carry once they exist in-world.
// PCs are capped; NPCs (kind === "npc") are unlimited (story chrome, gangs,
// ripperdoc rigs, etc. are not balance-constrained).
export const MAX_PC_CWP = 15;

export type CwpCapacity = {
  ok: boolean;
  // null = unlimited (NPC).
  max: number | null;
  used: number;
  add: number;
  // null = unlimited (NPC).
  available: number | null;
  reason?: string;
};

// Pure capacity check for installing `add` CWP onto a character that already
// carries `used`. NPCs are never blocked; PCs may not exceed MAX_PC_CWP total.
export function checkCwpCapacity(opts: { kind: string | null | undefined; used: number; add: number }): CwpCapacity {
  const used = Math.max(0, opts.used || 0);
  const add = Math.max(0, opts.add || 0);
  if (opts.kind === "npc") {
    return { ok: true, max: null, used, add, available: null };
  }
  const max = MAX_PC_CWP;
  const available = max - used;
  const ok = used + add <= max;
  return {
    ok,
    max,
    used,
    add,
    available,
    reason: ok ? undefined : `Installing ${add} CWP would exceed the ${max} CWP limit (already at ${used}; ${Math.max(0, available)} free)`,
  };
}

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
    const key = normalizeName(r.name);
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
  const key = normalizeName(c.name ?? "");
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
