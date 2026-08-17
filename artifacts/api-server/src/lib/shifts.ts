import { and, eq, sql } from "drizzle-orm";
import { db, storeShifts } from "@workspace/db";

// Bar shifts last exactly this long from clock-in; scheduledEndAt is stamped
// at clock-in and never extended.
export const SHIFT_HOURS = 4;

// Lazily close shifts whose window has passed: clockOutAt is stamped to
// scheduledEndAt (the shift ends when the window does, regardless of when we
// notice). Called on every shift read/write path and by the periodic sweep;
// the wage-split query in saleOffers independently filters scheduledEndAt >
// now(), so a stale open row can never earn even between sweeps.
export async function expireStaleShifts(storeId?: number): Promise<number> {
  const conds = [sql`${storeShifts.clockOutAt} IS NULL`, sql`${storeShifts.scheduledEndAt} <= now()`];
  if (storeId != null) conds.push(eq(storeShifts.storeId, storeId));
  const rows = await db
    .update(storeShifts)
    .set({ clockOutAt: sql`${storeShifts.scheduledEndAt}` })
    .where(and(...conds))
    .returning({ id: storeShifts.id });
  return rows.length;
}
