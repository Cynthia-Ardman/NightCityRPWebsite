import { and, eq, inArray } from "drizzle-orm";
import { db, inventoryItems } from "@workspace/db";

// Importer always emits "CWP <n> · ..." at the start of notes (keyword
// first, then the value). We also accept "<n> CWP" / "<n> points" /
// "<n> pts" as a fallback in case anyone hand-types it the other way.
// Anchor on word boundaries so "CWP" inside another token can't double-
// match a stray number.
const CWP_PATTERNS = [
  /\bcwp\b[\s:=-]*?(\d+(?:\.\d+)?)/i,            // "CWP 1", "CWP: 2", "CWP-3"
  /\bc\.w\.p\.?\b[\s:=-]*?(\d+(?:\.\d+)?)/i,
  /(\d+(?:\.\d+)?)\s*(?:cwp|c\.w\.p\.?|points?|pts?\.?)\b/i, // "2 CWP", "3 pts"
];

export function parseCwp(notes: string | null | undefined): number | null {
  if (!notes) return null;
  for (const re of CWP_PATTERNS) {
    const m = notes.match(re);
    if (m) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// CWP cost for one inventory row. Items with an explicit "CWP n" token in
// notes are counted at face value (multiplied by quantity). Anything
// untagged is treated as 0 — the spreadsheet only bills points-bearing
// items, and most untagged rows are placeholders ("Fully Organic",
// "Has basic implants", legacy-import stubs, junk test entries). A real
// piece of chrome will always carry a CWP tag from the importer; if one
// shows up without it, the fix is to stamp the CWP value, not silently
// charge the player 1 point.
export function cwpForItem(item: { name: string | null; notes: string | null; quantity: number | null }): number {
  const parsed = parseCwp(item.notes);
  if (parsed != null) return parsed * Math.max(1, item.quantity ?? 1);
  return 0;
}

export async function sumCwpByCharacter(characterIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (characterIds.length === 0) return out;
  const rows = await db
    .select({
      characterId: inventoryItems.characterId,
      name: inventoryItems.name,
      notes: inventoryItems.notes,
      quantity: inventoryItems.quantity,
    })
    .from(inventoryItems)
    .where(and(inArray(inventoryItems.characterId, characterIds), eq(inventoryItems.category, "cyberware")));
  for (const r of rows) {
    if (r.characterId == null) continue;
    const cur = out.get(r.characterId) ?? 0;
    out.set(r.characterId, cur + cwpForItem(r));
  }
  return out;
}
