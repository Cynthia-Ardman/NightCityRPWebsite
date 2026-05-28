import { and, eq, inArray } from "drizzle-orm";
import { db, inventoryItems } from "@workspace/db";

const CWP_PATTERNS = [
  /[\s\-–—(\[]\s*(\d+(?:\.\d+)?)\s*(?:cwp|c\.w\.p\.?|points?|pts?\.?)\s*[)\]]?/i,
  /[\s(\[]\s*(\d+(?:\.\d+)?)\s*(?:cwp|c\.w\.p\.?|points?|pts?\.?)\s*[)\]]/i,
];

export function parseCwp(notes: string | null | undefined): number | null {
  if (!notes) return null;
  const padded = ` ${notes}`;
  for (const re of CWP_PATTERNS) {
    const m = padded.match(re);
    if (m) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export function cwpForItem(item: { name: string | null; notes: string | null; quantity: number | null }): number {
  const parsed = parseCwp(item.notes);
  if (parsed != null) return parsed * Math.max(1, item.quantity ?? 1);
  if (item.name && /fully\s*organic/i.test(item.name)) return 0;
  return Math.max(1, item.quantity ?? 1);
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
