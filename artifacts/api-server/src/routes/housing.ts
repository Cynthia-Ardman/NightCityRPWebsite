import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, housing, characters, catalogRent, activityEvents, characterUpdates, housingRequests, users } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole } from "../lib/discord";

function isAdmin(user: { roles: string[] }) {
  return hasRole(user.roles, "ADMIN");
}

const router: IRouter = Router();

type LeaseRow = {
  id: number;
  characterId: number;
  characterName: string;
  listingId: number | null;
  address: string;
  district: string | null;
  tier: string | null;
  monthlyRent: number;
  paidThrough: Date | null;
  notes: string | null;
  kind: string;
  delinquentSince: Date | null;
  createdAt: Date;
};

// End-of-current-month timestamp in UTC. Used to set initial paid_through
// when a lease starts so the first full month is already "paid up" until
// the monthly_rent cron rolls it forward.
function endOfCurrentMonth(now: Date = new Date()): Date {
  // First of next month at 00:00:00 UTC = end of current month exclusive.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}

const HOUSING_GRACE_DAYS = Number(process.env.HOUSING_GRACE_DAYS ?? 7);

function shape(row: LeaseRow): Record<string, unknown> {
  // Two delinquency signals:
  //   - paidThrough < now → the rolling-month meter is overdue (informational)
  //   - delinquentSince  → the monthly_rent cron actively failed a charge
  //                        and started the eviction grace clock
  // We surface both so the UI can show "paid through stale" without
  // implying eviction unless delinquentSince is set.
  const delinquentSinceMs = row.delinquentSince ? row.delinquentSince.getTime() : null;
  const daysUntilEviction = delinquentSinceMs != null
    ? Math.max(0, Math.ceil((delinquentSinceMs + HOUSING_GRACE_DAYS * 86400000 - Date.now()) / 86400000))
    : null;
  return {
    id: row.id,
    characterId: row.characterId,
    characterName: row.characterName,
    listingId: row.listingId,
    address: row.address,
    district: row.district,
    tier: row.tier,
    monthlyRent: row.monthlyRent,
    paidThrough: row.paidThrough ? row.paidThrough.toISOString() : null,
    notes: row.notes,
    kind: row.kind,
    delinquent: !!row.paidThrough && row.paidThrough.getTime() < Date.now(),
    delinquentSince: row.delinquentSince ? row.delinquentSince.toISOString() : null,
    daysUntilEviction,
    createdAt: row.createdAt.toISOString(),
  };
}

async function selectLeasesWhere(predicate: ReturnType<typeof and> | ReturnType<typeof eq>) {
  const rows = (await db
    .select({
      id: housing.id,
      characterId: housing.characterId,
      characterName: characters.name,
      listingId: housing.listingId,
      address: housing.address,
      district: catalogRent.district,
      tier: catalogRent.tier,
      monthlyRent: housing.monthlyRent,
      paidThrough: housing.paidThrough,
      notes: housing.notes,
      kind: housing.kind,
      delinquentSince: housing.delinquentSince,
      createdAt: housing.createdAt,
    })
    .from(housing)
    .innerJoin(characters, eq(characters.id, housing.characterId))
    .leftJoin(catalogRent, eq(catalogRent.id, housing.listingId))
    .where(predicate)) as LeaseRow[];
  return rows;
}

router.get("/housing/mine", requireAuth, async (req, res): Promise<void> => {
  const ownerId = req.user!.id;
  const rows = await selectLeasesWhere(eq(characters.ownerId, ownerId));
  res.json(rows.map(shape));
});

router.get("/characters/:id/housing", requireAuth, async (req, res): Promise<void> => {
  const cid = parseInt(String(req.params.id), 10);
  const [c] = await db.select().from(characters).where(eq(characters.id, cid));
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Visibility: own or admin
  if (c.ownerId !== req.user!.id && !isAdmin(req.user!)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await selectLeasesWhere(eq(housing.characterId, cid));
  res.json(rows.map(shape));
});

router.post("/housing/lease", requireAuth, async (req, res): Promise<void> => {
  // Admin-only direct lease creation. Players must use the request workflow
  // (POST /housing/requests). This endpoint exists for admin overrides only.
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Admin only. Players must submit a housing request." });
    return;
  }
  const { catalogRentId, characterId, notes, kind } = req.body ?? {};
  const leaseKind = kind === "business" ? "business" : "residential";
  const lid = parseInt(String(catalogRentId), 10);
  const cid = parseInt(String(characterId), 10);
  if (!lid || !cid) {
    res.status(400).json({ error: "catalogRentId and characterId required" });
    return;
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, cid));
  if (!c) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (c.archived) {
    res.status(400).json({ error: "Cannot lease for an archived character" });
    return;
  }
  const [listing] = await db.select().from(catalogRent).where(eq(catalogRent.id, lid));
  if (!listing) {
    res.status(404).json({ error: "Listing not found" });
    return;
  }
  const address = listing.district ? `${listing.name} — ${listing.district}` : listing.name;
  const [inserted] = await db
    .insert(housing)
    .values({
      characterId: cid,
      listingId: lid,
      address,
      monthlyRent: listing.monthlyRent,
      paidThrough: endOfCurrentMonth(),
      notes: notes ?? null,
      kind: leaseKind,
    })
    .returning();
  await db.insert(activityEvents).values({
    kind: "transfer",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${c.name} leased ${listing.name} (€$${listing.monthlyRent}/mo)`,
  });
  await db.insert(characterUpdates).values({
    characterId: cid,
    authorId: req.user!.id,
    note: `Leased housing: ${listing.name} (€$${listing.monthlyRent.toLocaleString()}/mo)`,
  });
  const [row] = await selectLeasesWhere(eq(housing.id, inserted.id));
  res.status(201).json(shape(row));
});

// Admin-only update of lease metadata. Used to flip residential <->
// business (LOA billing semantics differ), nudge the monthly rent, or
// edit the internal notes field. The lease address / listing / character
// are not editable here — vacate and re-lease for those.
router.patch("/housing/:id", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const { kind, notes, monthlyRent } = req.body ?? {};
  const updates: Record<string, unknown> = {};
  if (kind !== undefined) {
    if (kind !== "residential" && kind !== "business") {
      res.status(400).json({ error: "kind must be residential or business" });
      return;
    }
    updates.kind = kind;
  }
  if (notes !== undefined) updates.notes = notes;
  if (monthlyRent !== undefined) {
    const mr = parseInt(String(monthlyRent), 10);
    if (Number.isNaN(mr) || mr < 0) {
      res.status(400).json({ error: "monthlyRent must be a non-negative integer" });
      return;
    }
    updates.monthlyRent = mr;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No changes" });
    return;
  }
  const [existing] = await db.select().from(housing).where(eq(housing.id, id));
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.update(housing).set(updates).where(eq(housing.id, id));
  const [row] = await selectLeasesWhere(eq(housing.id, id));
  res.json(shape(row));
});

router.delete("/housing/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [row] = await db
    .select({ h: housing, ownerId: characters.ownerId, characterName: characters.name })
    .from(housing)
    .innerJoin(characters, eq(characters.id, housing.characterId))
    .where(eq(housing.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (row.ownerId !== req.user!.id && !isAdmin(req.user!)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(housing).where(eq(housing.id, id));
  await db.insert(activityEvents).values({
    kind: "transfer",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${row.characterName} vacated ${row.h.address}`,
  });
  await db.insert(characterUpdates).values({
    characterId: row.h.characterId,
    authorId: req.user!.id,
    note: `Vacated housing: ${row.h.address}`,
  });
  res.sendStatus(204);
});

// ---------------- Housing rental request workflow ---------------------
// Players don't materialize housing rows directly. They POST a request
// here; admins triage the queue at /admin and either approve (creates the
// lease) or reject (closes the request with a reviewer note). This mirrors
// the existing pending-edits and sheet-approval flows.

type RequestRow = {
  id: number;
  characterId: number;
  characterName: string;
  characterArchived: boolean;
  listingId: number;
  listingName: string;
  district: string | null;
  tier: string | null;
  monthlyRent: number;
  requestedById: string;
  requestedByName: string | null;
  kind: string;
  notes: string | null;
  status: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  reviewerNote: string | null;
  createdAt: Date;
};

function shapeRequest(row: RequestRow) {
  return {
    id: row.id,
    characterId: row.characterId,
    characterName: row.characterName,
    listingId: row.listingId,
    listingName: row.listingName,
    district: row.district,
    tier: row.tier,
    monthlyRent: row.monthlyRent,
    requestedById: row.requestedById,
    requestedByName: row.requestedByName,
    kind: row.kind,
    notes: row.notes,
    status: row.status,
    reviewedById: row.reviewedById,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewerNote: row.reviewerNote,
    createdAt: row.createdAt.toISOString(),
  };
}

async function selectRequestsWhere(predicate: ReturnType<typeof and> | ReturnType<typeof eq>) {
  return (await db
    .select({
      id: housingRequests.id,
      characterId: housingRequests.characterId,
      characterName: characters.name,
      characterArchived: characters.archived,
      listingId: housingRequests.listingId,
      listingName: catalogRent.name,
      district: catalogRent.district,
      tier: catalogRent.tier,
      monthlyRent: catalogRent.monthlyRent,
      requestedById: housingRequests.requestedById,
      requestedByName: users.username,
      kind: housingRequests.kind,
      notes: housingRequests.notes,
      status: housingRequests.status,
      reviewedById: housingRequests.reviewedById,
      reviewedAt: housingRequests.reviewedAt,
      reviewerNote: housingRequests.reviewerNote,
      createdAt: housingRequests.createdAt,
    })
    .from(housingRequests)
    .innerJoin(characters, eq(characters.id, housingRequests.characterId))
    .innerJoin(catalogRent, eq(catalogRent.id, housingRequests.listingId))
    .innerJoin(users, eq(users.id, housingRequests.requestedById))
    .where(predicate)) as RequestRow[];
}

router.post("/housing/requests", requireAuth, async (req, res): Promise<void> => {
  const { catalogRentId, characterId, notes, kind } = req.body ?? {};
  const leaseKind = kind === "business" ? "business" : "residential";
  const lid = parseInt(String(catalogRentId), 10);
  const cid = parseInt(String(characterId), 10);
  if (!lid || !cid) {
    res.status(400).json({ error: "catalogRentId and characterId required" });
    return;
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, cid));
  if (!c) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (c.ownerId !== req.user!.id && !isAdmin(req.user!)) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (c.archived) {
    res.status(400).json({ error: "Cannot request housing for an archived character" });
    return;
  }
  const [listing] = await db.select().from(catalogRent).where(eq(catalogRent.id, lid));
  if (!listing) {
    res.status(404).json({ error: "Listing not found" });
    return;
  }
  // Reject duplicate pending request for the same (character, listing)
  // pair — rejected requests don't block, so the player can resubmit
  // after a denial.
  const [dup] = await db
    .select()
    .from(housingRequests)
    .where(and(
      eq(housingRequests.characterId, cid),
      eq(housingRequests.listingId, lid),
      eq(housingRequests.status, "pending"),
    ));
  if (dup) {
    res.status(409).json({ error: "A pending request already exists for this character and listing" });
    return;
  }
  const [inserted] = await db
    .insert(housingRequests)
    .values({
      characterId: cid,
      listingId: lid,
      requestedById: req.user!.id,
      kind: leaseKind,
      notes: notes ?? null,
    })
    .returning();
  await db.insert(activityEvents).values({
    kind: "housing_request",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${c.name} requested ${listing.name} (€$${listing.monthlyRent}/mo, ${leaseKind})`,
  });
  const [row] = await selectRequestsWhere(eq(housingRequests.id, inserted.id));
  res.status(201).json(shapeRequest(row));
});

router.get("/housing/requests/mine", requireAuth, async (req, res): Promise<void> => {
  const rows = await selectRequestsWhere(eq(housingRequests.requestedById, req.user!.id));
  res.json(rows.map(shapeRequest));
});

router.get("/housing/requests", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  const status = String(req.query.status ?? "pending");
  const rows = await selectRequestsWhere(eq(housingRequests.status, status));
  res.json(rows.map(shapeRequest));
});

router.post("/housing/requests/:id/approve", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  const rid = parseInt(String(req.params.id), 10);
  // Wrap the read-check-insert in a transaction with FOR UPDATE so two admins
  // approving the same request concurrently can't both materialize leases.
  const txResult = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`SELECT * FROM housing_requests WHERE id = ${rid} FOR UPDATE`);
    const reqRow = (locked.rows ?? locked)[0] as typeof housingRequests.$inferSelect | undefined;
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    if (reqRow.status !== "pending") {
      return { error: { status: 409, body: { error: `Request already ${reqRow.status}` } } };
    }
    const [c] = await tx.select().from(characters).where(eq(characters.id, reqRow.characterId));
    if (!c || c.archived) {
      return { error: { status: 400, body: { error: "Character is missing or archived" } } };
    }
    if (!c.approved) {
      return { error: { status: 400, body: { error: "Character is not approved; cannot bill rent" } } };
    }
    const [listing] = await tx.select().from(catalogRent).where(eq(catalogRent.id, reqRow.listingId));
    if (!listing) {
      return { error: { status: 400, body: { error: "Listing is missing" } } };
    }
    const address = listing.district ? `${listing.name} — ${listing.district}` : listing.name;
    const [inserted] = await tx
      .insert(housing)
      .values({
        characterId: reqRow.characterId,
        listingId: reqRow.listingId,
        address,
        monthlyRent: listing.monthlyRent,
        paidThrough: endOfCurrentMonth(),
        notes: reqRow.notes ?? null,
        kind: reqRow.kind,
      })
      .returning();
    await tx.update(housingRequests).set({
      status: "approved",
      reviewedById: req.user!.id,
      reviewedAt: new Date(),
      reviewerNote: req.body?.reviewerNote ?? null,
    }).where(eq(housingRequests.id, rid));
    return { ok: { reqRow, c, listing, inserted } };
  });
  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const { reqRow, c, listing, inserted } = txResult.ok;
  await db.insert(activityEvents).values({
    kind: "housing_approved",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${c.name} approved for ${listing.name} (€$${listing.monthlyRent}/mo)`,
  });
  await db.insert(characterUpdates).values({
    characterId: reqRow.characterId,
    authorId: req.user!.id,
    note: `Housing request approved: ${listing.name} (€$${listing.monthlyRent.toLocaleString()}/mo)`,
  });
  const [row] = await selectLeasesWhere(eq(housing.id, inserted.id));
  res.json(shape(row));
});

router.post("/housing/requests/:id/reject", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  const rid = parseInt(String(req.params.id), 10);
  const [reqRow] = await db.select().from(housingRequests).where(eq(housingRequests.id, rid));
  if (!reqRow) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  if (reqRow.status !== "pending") {
    res.status(409).json({ error: `Request already ${reqRow.status}` });
    return;
  }
  const note = typeof req.body?.reviewerNote === "string" ? req.body.reviewerNote : null;
  await db.update(housingRequests).set({
    status: "rejected",
    reviewedById: req.user!.id,
    reviewedAt: new Date(),
    reviewerNote: note,
  }).where(eq(housingRequests.id, rid));
  await db.insert(activityEvents).values({
    kind: "housing_rejected",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `Housing request #${rid} rejected${note ? `: ${note}` : ""}`,
  });
  const [row] = await selectRequestsWhere(eq(housingRequests.id, rid));
  res.json(shapeRequest(row));
});

// suppress unused export warning for sql
void sql;

export default router;
