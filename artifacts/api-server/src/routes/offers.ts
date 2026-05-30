import { Router, type IRouter } from "express";
import { and, desc, eq, or } from "drizzle-orm";
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
import { hasRole } from "../lib/discord";
import { approveOffer, denyOffer, type OfferKind } from "../lib/saleOffers";

const router: IRouter = Router();

// Attach the venue name + buyer/seller names to an offer for display.
async function shapeOffer(offer: typeof saleOffers.$inferSelect) {
  const kind = offer.kind as OfferKind;
  const venueId = kind === "store" ? offer.storeId : offer.ripperdocId;
  let venueName: string | null = null;
  if (venueId != null) {
    const [v] = kind === "store"
      ? await db.select({ name: stores.name }).from(stores).where(eq(stores.id, venueId))
      : await db.select({ name: ripperdocs.name }).from(ripperdocs).where(eq(ripperdocs.id, venueId));
    venueName = v?.name ?? null;
  }
  const [buyer] = await db.select({ name: characters.name }).from(characters).where(eq(characters.id, offer.buyerCharacterId));
  return { ...offer, venueName, buyerName: buyer?.name ?? null };
}

// Buyer's offers (the in-portal pending-approvals surface). Returns all of the
// caller's offers, newest first, so the UI can show pending + recent history.
router.get("/offers/mine", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(saleOffers)
    .where(eq(saleOffers.buyerUserId, req.user!.id))
    .orderBy(desc(saleOffers.createdAt));
  res.json(await Promise.all(rows.map(shapeOffer)));
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
  let authorized = venue.ownerId === req.user!.id || hasRole(req.user!.roles, "ADMIN") || hasRole(req.user!.roles, "FIXER");
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
  res.json(await Promise.all(rows.map(shapeOffer)));
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
  const isStaff = hasRole(req.user!.roles, "ADMIN") || hasRole(req.user!.roles, "FIXER");
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
  res.json(await shapeOffer(offer));
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
