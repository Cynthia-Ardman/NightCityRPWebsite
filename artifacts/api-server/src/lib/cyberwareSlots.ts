import { and, eq, ne, sql } from "drizzle-orm";
import { db, catalogCyberware, inventoryItems } from "@workspace/db";
import { parseCwp } from "./cyberware";

// Canonical CAPPED cyberware slots. A character may hold at most ONE installed
// cyberware item per capped slot. Stored normalized (lowercase, parenthetical
// qualifiers stripped) so catalog variants like "Universal Muscular
// (Arms/Legs/Tail)" collapse onto "universal muscular".
//
// Intentionally UNCAPPED (can stack): "Miscellaneous", any Custom/one-off
// slot, and anything we can't resolve to a known slot (legacy free-text). The
// rule is "1 per capped slot" — anything not in this set is unlimited.
export const CAPPED_SLOTS = [
  "neural",
  "ocular system",
  "auditory system",
  "hands & feet",
  "arms & arm attachments",
  "legs & mobility",
  "integumentary system",
  "circulatory & immune systems",
  "skeleton & torso musculature",
  "universal muscular",
] as const;

const CAPPED_SET = new Set<string>(CAPPED_SLOTS);

// Collapse a slot string to a canonical key: lowercase, drop "(...)"
// qualifiers, squeeze whitespace. Empty/unknown slots normalize to "".
export function normalizeSlot(slot: string | null | undefined): string {
  return (slot ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Same normalization applied to item/catalog names for fuzzy slot recovery.
function normalizeName(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// True when the slot counts toward the 1-per-slot cap. Miscellaneous, Custom,
// and unknown/unresolved slots are NOT capped.
export function isCappedSlot(slot: string | null | undefined): boolean {
  return CAPPED_SET.has(normalizeSlot(slot));
}

// Pull the slot out of an inventory note. The cyberware note convention is
// "CWP <n> · <user notes> · slot: <slot>" with " · " separators (see
// CyberwareEditor.buildCyberNotes); the slot segment, when present, is last.
export function slotFromNotes(notes: string | null | undefined): string {
  const parts = (notes ?? "").split(" · ");
  for (const p of parts) {
    const m = p.match(/^slot:\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return "";
}

// Load a normalized-name -> slot map from the cyberware catalog. ~87% of
// installed cyberware items carry no slot in their notes but DO match a catalog
// entry by name, so this recovers the slot for them.
export async function loadCyberwareSlotByName(): Promise<Map<string, string>> {
  const rows = await db
    .select({ name: catalogCyberware.name, slot: catalogCyberware.slot })
    .from(catalogCyberware);
  const map = new Map<string, string>();
  for (const r of rows) {
    const key = normalizeName(r.name);
    if (key && r.slot) map.set(key, r.slot);
  }
  return map;
}

// Resolve the slot for an installed cyberware item: prefer the explicit
// "slot:" note, otherwise fall back to a catalog name match. Returns the RAW
// slot string (catalog casing) or "" when unknown. Run through normalizeSlot /
// isCappedSlot for comparisons.
export function resolveSlotForItem(
  item: { name: string | null; notes: string | null },
  catalogByName: Map<string, string>,
): string {
  const fromNotes = slotFromNotes(item.notes);
  if (fromNotes) return fromNotes;
  return catalogByName.get(normalizeName(item.name)) ?? "";
}

// One-per-capped-slot guard shared by every install write path (manual add,
// ripperdoc stock install, install-owned). Returns a user-facing error string
// when the install would violate the cap, or null when it is allowed.
// NPCs are exempt (staff manage their chrome freely). Pass a tx as `executor`
// to run the existing-rows read inside a locked transaction (race-safe
// re-check at offer completion); `excludeItemId` skips the item being
// installed itself (install-owned: the row already sits in the inventory).
export async function installSlotClashError(opts: {
  executor?: Pick<typeof db, "select">;
  buyer: { id: number; kind: string | null };
  item: { name: string | null; notes: string | null };
  qty: number;
  excludeItemId?: number | null;
}): Promise<string | null> {
  const { buyer, item, qty } = opts;
  if (buyer.kind === "npc") return null;
  const catalogByName = await loadCyberwareSlotByName();
  const slot = resolveSlotForItem(item, catalogByName);
  if (!isCappedSlot(slot)) return null;
  if (qty > 1) {
    return `Only one ${item.name ?? "item"} can be installed — the ${slot} slot holds a single piece of cyberware.`;
  }
  const ex = opts.executor ?? db;
  const conds = [
    eq(inventoryItems.characterId, buyer.id),
    sql`lower(trim(${inventoryItems.category})) = 'cyberware'`,
  ];
  if (opts.excludeItemId != null) conds.push(ne(inventoryItems.id, opts.excludeItemId));
  const existing = await ex
    .select({ name: inventoryItems.name, notes: inventoryItems.notes })
    .from(inventoryItems)
    .where(and(...conds));
  const targetKey = normalizeSlot(slot);
  // Only INSTALLED chrome (rows carrying a "CWP n" tag) occupies a slot —
  // loose, uninstalled pieces in the stash don't block an install.
  const clash = existing.some(
    (e) =>
      parseCwp(e.notes) != null &&
      normalizeSlot(resolveSlotForItem(e, catalogByName)) === targetKey,
  );
  return clash
    ? `This character already has cyberware in the ${slot} slot. Only Miscellaneous and Custom cyberware can stack.`
    : null;
}
