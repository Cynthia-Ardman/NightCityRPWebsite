import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db, customRequests } from "@workspace/db";

type DbConn = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// An on-map venue request (store/ripperdoc) reserves a real business building
// from the rent catalog while the ticket is LIVE. A reservation is live while
// the request is `pending` (in the review queue) or `approved` (decided but not
// yet closed — the lease is committed on close). Once the request is closed (a
// lease now points at the building), rejected, or cancelled, the row leaves the
// live set and the reservation is released, so the building is available again.
export const LIVE_RESERVATION_STATUSES = ["pending", "approved"] as const;

// Catalog_rent ids currently held by a live venue reservation. Used to flag
// buildings as occupied in the catalog and to exclude them from the on-map
// available-buildings dropdown.
export async function loadReservedListingIds(conn: DbConn = db): Promise<Set<number>> {
  const rows = await conn
    .select({ listingId: customRequests.reservedListingId })
    .from(customRequests)
    .where(
      and(
        isNotNull(customRequests.reservedListingId),
        inArray(customRequests.status, LIVE_RESERVATION_STATUSES as unknown as string[]),
      ),
    );
  const out = new Set<number>();
  for (const r of rows) if (r.listingId != null) out.add(r.listingId);
  return out;
}

// Whether a single building currently has a live reservation. `excludeRequestId`
// lets a request's own approval/close path ignore itself when re-checking.
export async function isListingReserved(
  listingId: number,
  conn: DbConn = db,
  excludeRequestId?: number,
): Promise<boolean> {
  const conds = [
    eq(customRequests.reservedListingId, listingId),
    inArray(customRequests.status, LIVE_RESERVATION_STATUSES as unknown as string[]),
  ];
  if (excludeRequestId != null) conds.push(ne(customRequests.id, excludeRequestId));
  const [row] = await conn
    .select({ id: customRequests.id })
    .from(customRequests)
    .where(and(...conds))
    .limit(1);
  return !!row;
}
