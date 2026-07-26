import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  saleOffers,
  stores,
  ripperdocs,
  storeEmployees,
  ripperdocEmployees,
  characters,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { isStaffRoles } from "../lib/roleChecks";
import { approveOffer, denyOffer, type OfferKind } from "../lib/saleOffers";

const router: IRouter = Router();

type Offer = typeof saleOffers.$inferSelect;
type ShapedOffer = Offer & { venueName: string | null; buyerName: string | null; sellerName: string | null };

// Attach venue + buyer names to a batch of offers for display. Resolves all
// names in a fixed number of queries (one per stores/ripperdocs/characters)
// regardless of how many offers there are, instead of 2 queries per offer.
async function shapeOffers(offers: Offer[]): Promise<ShapedOffer[]> {
  if (offers.length === 0) return [];

  const storeIds = new Set<number>();
  const ripperdocIds = new Set<number>();
  const buyerIds = new Set<number>();
  for (const o of offers) {
    if (o.kind === "store") {
      if (o.storeId != null) storeIds.add(o.storeId);
    } else if (o.ripperdocId != null) {
      ripperdocIds.add(o.ripperdocId);
    }
    if (o.buyerCharacterId != null) buyerIds.add(o.buyerCharacterId);
    if (o.sellerCharacterId != null) buyerIds.add(o.sellerCharacterId);
  }

  const [storeRows, ripperdocRows, buyerRows] = await Promise.all([
    storeIds.size
      ? db.select({ id: stores.id, name: stores.name }).from(stores).where(inArray(stores.id, [...storeIds]))
      : Promise.resolve([] as { id: number; name: string }[]),
    ripperdocIds.size
      ? db.select({ id: ripperdocs.id, name: ripperdocs.name }).from(ripperdocs).where(inArray(ripperdocs.id, [...ripperdocIds]))
      : Promise.resolve([] as { id: number; name: string }[]),
    buyerIds.size
      ? db.select({ id: characters.id, name: characters.name }).from(characters).where(inArray(characters.id, [...buyerIds]))
      : Promise.resolve([] as { id: number; name: string }[]),
  ]);

  const storeName = new Map(storeRows.map((r) => [r.id, r.name]));
  const ripperdocName = new Map(ripperdocRows.map((r) => [r.id, r.name]));
  const buyerName = new Map(buyerRows.map((r) => [r.id, r.name]));

  return offers.map((o) => {
    const kind = o.kind as OfferKind;
    const venueId = kind === "store" ? o.storeId : o.ripperdocId;
    const venueName =
      venueId == null ? null : (kind === "store" ? storeName.get(venueId) : ripperdocName.get(venueId)) ?? null;
    return {
      ...o,
      venueName,
      buyerName: o.buyerCharacterId == null ? null : buyerName.get(o.buyerCharacterId) ?? null,
      sellerName: o.sellerCharacterId == null ? null : buyerName.get(o.sellerCharacterId) ?? null,
    };
  });
}

// Buyer's offers (the in-portal pending-approvals surface). Returns all of the
// caller's offers, newest first, so the UI can show pending + recent history.
router.get("/offers/mine", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(saleOffers)
    .where(eq(saleOffers.buyerUserId, req.user!.id))
    .orderBy(desc(saleOffers.createdAt));
  res.json(await shapeOffers(rows));
});

// Offers for a venue the caller operates (owner/admin/employee), so the seller
// side can see offer states + commission in history.
async function listVenueOffers(
  req: import("express").Request,
  res: import("express").Response,
  kind: OfferKind,
): Promise<void> {
  const venueId = parseInt(String(req.params.id), 10);
  const venueTable = kind === "store" ? stores : ripperdocs;
  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  let authorized = venue.ownerId === req.user!.id || isStaffRoles(req.user!.roles);
  if (!authorized) {
    const empTable = kind === "store" ? storeEmployees : ripperdocEmployees;
    const empVenueCol = kind === "store" ? storeEmployees.storeId : ripperdocEmployees.ripperdocId;
    const emp = await db
      .select({ id: empTable.id })
      .from(empTable)
      .innerJoin(characters, eq(characters.id, empTable.characterId))
      .where(and(eq(empVenueCol, venueId), eq(characters.ownerId, req.user!.id)));
    authorized = emp.length > 0;
  }
  if (!authorized) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const col = kind === "store" ? saleOffers.storeId : saleOffers.ripperdocId;
  const rows = await db.select().from(saleOffers).where(eq(col, venueId)).orderBy(desc(saleOffers.createdAt));
  res.json(await shapeOffers(rows));
}

router.get("/stores/:id/offers", requireAuth, (req, res) => listVenueOffers(req, res, "store"));
router.get("/ripperdocs/:id/offers", requireAuth, (req, res) => listVenueOffers(req, res, "ripperdoc"));

// Single offer — visible to the buyer, the venue operator, or staff.
router.get("/offers/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [offer] = await db.select().from(saleOffers).where(eq(saleOffers.id, id));
  if (!offer) {
    res.status(404).json({ error: "Offer not found" });
    return;
  }
  const kind = offer.kind as OfferKind;
  const venueId = kind === "store" ? offer.storeId : offer.ripperdocId;
  const venueTable = kind === "store" ? stores : ripperdocs;
  const [venue] = venueId != null ? await db.select().from(venueTable).where(eq(venueTable.id, venueId)) : [undefined];
  const isStaff = isStaffRoles(req.user!.roles);
  const isBuyer = offer.buyerUserId === req.user!.id;
  const isOwner = venue?.ownerId === req.user!.id;
  let authorized = isStaff || isBuyer || isOwner;
  if (!authorized && venueId != null) {
    const empTable = kind === "store" ? storeEmployees : ripperdocEmployees;
    const empVenueCol = kind === "store" ? storeEmployees.storeId : ripperdocEmployees.ripperdocId;
    const emp = await db
      .select({ id: empTable.id })
      .from(empTable)
      .innerJoin(characters, eq(characters.id, empTable.characterId))
      .where(and(eq(empVenueCol, venueId), eq(characters.ownerId, req.user!.id)));
    authorized = emp.length > 0;
  }
  if (!authorized) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json((await shapeOffers([offer]))[0]);
});

router.post("/offers/:id/approve", requireAuth, async (req, res): Promise<void> => {
  const result = await approveOffer(parseInt(String(req.params.id), 10), req.user!);
  res.status(result.status).json(result.body);
});

router.post("/offers/:id/deny", requireAuth, async (req, res): Promise<void> => {
  const result = await denyOffer(parseInt(String(req.params.id), 10), req.user!);
  res.status(result.status).json(result.body);
});

export default router;
