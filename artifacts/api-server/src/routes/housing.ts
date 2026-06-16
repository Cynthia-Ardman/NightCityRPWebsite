import { Router, type IRouter } from "express";
import { and, eq, sql, ilike, inArray, desc } from "drizzle-orm";
import { db, housing, characters, catalogRent, activityEvents, characterUpdates, housingRequests, users, walletTransactions } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { recordAudit } from "../lib/audit";
import { endOfCurrentMonth } from "../lib/billingDates";
import { isAdmin, isFixerOrAdmin } from "../lib/roleChecks";

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
    // Delinquent when rent is past due OR the autobill cron has already flagged
    // it (delinquentSince is set even when paidThrough is null after a failed
    // debit). Previously a null paidThrough left this false while the eviction
    // clock (daysUntilEviction) was already ticking — a contradictory display.
    delinquent: row.delinquentSince != null || (!!row.paidThrough && row.paidThrough.getTime() < Date.now()),
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
  // Visibility: own or staff (fixers + admins). Staff manage other players'
  // property directly from the character-detail Property tab, so they must be
  // able to read the current leases too.
  if (c.ownerId !== req.user!.id && !isFixerOrAdmin(req.user!)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await selectLeasesWhere(eq(housing.characterId, cid));
  res.json(rows.map(shape));
});

// Staff-only audit view for a single catalog listing. Returns the listing
// summary, the CURRENT tenant (the housing row only tracks one), the rent
// ledger entries tied to it, and a best-effort occupancy/ownership timeline.
//
// Best-effort notes:
// - Payments: matched by the listing name appearing in the wallet_transactions
//   memo. The monthly_rent / shop-income jobs write "<label>: <address>" and
//   "Shop income: <address>", where <address> starts with the listing name.
//   Legacy bot balance_history rent rows are NOT included — they carry no
//   property reference and can't be attributed to a listing.
// - Timeline: reconstructed from activity_events whose message names this
//   listing (lease/vacate/request/approve/reject/delinquent). Past occupancy
//   isn't stored, so this feed is the only source of who lived here before.
router.get("/housing/listings/:id/history", requireAuth, async (req, res): Promise<void> => {
  if (!isFixerOrAdmin(req.user!)) {
    res.status(403).json({ error: "Staff only" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid listing id" });
    return;
  }
  const [listing] = await db.select().from(catalogRent).where(eq(catalogRent.id, id));
  if (!listing) {
    res.status(404).json({ error: "Listing not found" });
    return;
  }
  // Escape LIKE wildcards so a name containing % or _ doesn't overmatch the
  // best-effort memo/message search.
  const namePattern = `%${listing.name.replace(/([%_\\])/g, "\\$1")}%`;

  const [tenantRow, paymentRows, eventRows] = await Promise.all([
    // Current occupant of this listing (single-unit, so at most one).
    db
      .select({
        housingId: housing.id,
        characterId: housing.characterId,
        characterName: characters.name,
        ownerId: characters.ownerId,
        ownerName: users.username,
        monthlyRent: housing.monthlyRent,
        kind: housing.kind,
        paidThrough: housing.paidThrough,
        delinquentSince: housing.delinquentSince,
        since: housing.createdAt,
      })
      .from(housing)
      .innerJoin(characters, eq(characters.id, housing.characterId))
      .leftJoin(users, eq(users.id, characters.ownerId))
      .where(eq(housing.listingId, id))
      .orderBy(desc(housing.createdAt))
      .limit(1),
    // Rent / shop-income ledger rows whose memo references this listing.
    db
      .select({
        id: walletTransactions.id,
        amount: walletTransactions.amount,
        kind: walletTransactions.kind,
        memo: walletTransactions.memo,
        characterId: walletTransactions.characterId,
        characterName: characters.name,
        createdAt: walletTransactions.createdAt,
      })
      .from(walletTransactions)
      .leftJoin(characters, eq(characters.id, walletTransactions.characterId))
      .where(
        and(
          inArray(walletTransactions.kind, ["rent", "business_rent", "shop_income"]),
          ilike(walletTransactions.memo, namePattern),
        ),
      )
      .orderBy(desc(walletTransactions.createdAt))
      .limit(200),
    // Occupancy / ownership timeline from the activity feed (best-effort).
    db
      .select({
        id: activityEvents.id,
        kind: activityEvents.kind,
        message: activityEvents.message,
        actorName: activityEvents.actorName,
        createdAt: activityEvents.createdAt,
      })
      .from(activityEvents)
      .where(
        and(
          inArray(activityEvents.kind, [
            "transfer",
            "housing_request",
            "housing_approved",
            "housing_rejected",
            "housing_delinquent",
          ]),
          ilike(activityEvents.message, namePattern),
        ),
      )
      .orderBy(desc(activityEvents.createdAt))
      .limit(200),
  ]);

  const tenant = tenantRow[0];
  res.json({
    listing: {
      id: listing.id,
      name: listing.name,
      district: listing.district,
      tier: listing.tier,
      monthlyRent: listing.monthlyRent,
      kind: listing.kind,
    },
    currentTenant: tenant
      ? {
          housingId: tenant.housingId,
          characterId: tenant.characterId,
          characterName: tenant.characterName,
          ownerId: tenant.ownerId,
          ownerName: tenant.ownerName ?? null,
          monthlyRent: tenant.monthlyRent,
          kind: tenant.kind,
          paidThrough: tenant.paidThrough ? tenant.paidThrough.toISOString() : null,
          delinquentSince: tenant.delinquentSince ? tenant.delinquentSince.toISOString() : null,
          since: tenant.since.toISOString(),
        }
      : null,
    payments: paymentRows.map((p) => ({
      id: p.id,
      amount: p.amount,
      kind: p.kind,
      memo: p.memo ?? null,
      characterId: p.characterId ?? null,
      characterName: p.characterName ?? null,
      date: p.createdAt.toISOString(),
    })),
    timeline: eventRows.map((e) => ({
      id: e.id,
      kind: e.kind,
      message: e.message,
      actorName: e.actorName ?? null,
      date: e.createdAt.toISOString(),
    })),
  });
});

router.post("/housing/lease", requireAuth, async (req, res): Promise<void> => {
  // Direct lease creation. Admins/fixers can lease any listing for any
  // character. Players may self-lease RESIDENTIAL listings for their own
  // approved character; business spaces still require a reviewed request
  // (POST /requests, type "property").
  const staff = isFixerOrAdmin(req.user!);
  const { catalogRentId, characterId, notes } = req.body ?? {};
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
  // The lease kind is derived from the listing itself — staff cannot override
  // it via the request body, so housing stays consistent with the catalog.
  const leaseKind = listing.kind === "business" ? "business" : "residential";
  if (!staff) {
    if (c.ownerId !== req.user!.id) {
      res.status(403).json({ error: "You can only lease for your own character." });
      return;
    }
    if (!c.approved) {
      res.status(400).json({ error: "Character must be approved before leasing." });
      return;
    }
    if (leaseKind !== "residential") {
      res.status(400).json({ error: "Business spaces require a request — use the lease form." });
      return;
    }
  }
  // One residential + one business per district per PLAYER. Scoped to the
  // character's owner (so all of a player's characters share the cap) and only
  // enforced when we have both an owner and a district to scope by.
  if (c.ownerId && listing.district) {
    const [dup] = await db
      .select({ id: housing.id })
      .from(housing)
      .innerJoin(characters, eq(characters.id, housing.characterId))
      .innerJoin(catalogRent, eq(catalogRent.id, housing.listingId))
      .where(
        and(
          eq(characters.ownerId, c.ownerId),
          eq(catalogRent.district, listing.district),
          eq(housing.kind, leaseKind),
        ),
      )
      .limit(1);
    if (dup) {
      res.status(409).json({
        error: `This player already holds a ${leaseKind} property in ${listing.district}. Only one ${leaseKind} property per district is allowed.`,
      });
      return;
    }
  }
  const address = listing.district ? `${listing.name} — ${listing.district}` : listing.name;
  // Single-unit occupancy. Lock the listing row FOR UPDATE first so concurrent
  // lease attempts serialize: the occupancy re-check and insert happen while we
  // hold the lock, so two callers can't both pass the check and double-lease.
  let inserted: typeof housing.$inferSelect | undefined;
  let occupied = false;
  await db.transaction(async (tx) => {
    await tx.select({ id: catalogRent.id }).from(catalogRent).where(eq(catalogRent.id, lid)).for("update");
    const [existingLease] = await tx
      .select({ id: housing.id })
      .from(housing)
      .where(eq(housing.listingId, lid))
      .limit(1);
    if (existingLease) {
      occupied = true;
      return;
    }
    [inserted] = await tx
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
  });
  if (occupied || !inserted) {
    res.status(409).json({ error: "Listing is already occupied by another lease" });
    return;
  }
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
  await recordAudit({
    req,
    category: "housing",
    action: staff ? "lease_assign" : "lease_self",
    targetType: "housing",
    targetId: inserted.id,
    message: `${staff ? "Assigned" : "Self-leased"} ${listing.name} to ${c.name}`,
    after: {
      leaseId: inserted.id,
      listingId: lid,
      characterId: cid,
      characterName: c.name,
      address,
      monthlyRent: listing.monthlyRent,
      kind: leaseKind,
    },
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
  await recordAudit({
    req,
    category: "housing",
    action: "lease_edit",
    targetType: "housing",
    targetId: id,
    message: `Edited lease #${id} (${Object.keys(updates).join(", ")})`,
    before: Object.fromEntries(
      Object.keys(updates).map((k) => [k, (existing as Record<string, unknown>)[k]]),
    ),
    after: updates,
  });
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
  if (row.ownerId !== req.user!.id && !isFixerOrAdmin(req.user!)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const staffForced = row.ownerId !== req.user!.id;
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
  await recordAudit({
    req,
    category: "housing",
    action: staffForced ? "lease_remove" : "lease_vacate",
    targetType: "housing",
    targetId: id,
    message: `${staffForced ? "Removed" : "Vacated"} lease ${row.h.address} (${row.characterName})`,
    before: {
      leaseId: id,
      listingId: row.h.listingId,
      characterId: row.h.characterId,
      characterName: row.characterName,
      address: row.h.address,
      monthlyRent: row.h.monthlyRent,
      kind: row.h.kind,
    },
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
  // Reject requests against listings that already have an active lease —
  // these are single-unit, so an occupied listing can't accept another tenant.
  const [occupant] = await db
    .select({ id: housing.id })
    .from(housing)
    .where(eq(housing.listingId, lid))
    .limit(1);
  if (occupant) {
    res.status(409).json({ error: "Listing is already occupied" });
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
    // Lock the listing row (same as the direct /housing/lease path) so two
    // concurrent approvals of DIFFERENT pending requests for the SAME listing
    // serialize here — otherwise both could pass the occupancy check below and
    // double-lease the unit (there is no DB unique constraint on listing_id).
    const [listing] = await tx.select().from(catalogRent).where(eq(catalogRent.id, reqRow.listingId)).for("update");
    if (!listing) {
      return { error: { status: 400, body: { error: "Listing is missing" } } };
    }
    // Re-check occupancy at approval time: another request could have
    // been approved between when this one was submitted and now.
    const [occupant] = await tx
      .select({ id: housing.id })
      .from(housing)
      .where(eq(housing.listingId, reqRow.listingId))
      .limit(1);
    if (occupant) {
      return { error: { status: 409, body: { error: "Listing is already occupied by another lease" } } };
    }
    // One residential + one business per district per PLAYER (see /housing/lease).
    if (c.ownerId && listing.district) {
      const [dup] = await tx
        .select({ id: housing.id })
        .from(housing)
        .innerJoin(characters, eq(characters.id, housing.characterId))
        .innerJoin(catalogRent, eq(catalogRent.id, housing.listingId))
        .where(
          and(
            eq(characters.ownerId, c.ownerId),
            eq(catalogRent.district, listing.district),
            eq(housing.kind, reqRow.kind),
          ),
        )
        .limit(1);
      if (dup) {
        return {
          error: {
            status: 409,
            body: {
              error: `This player already holds a ${reqRow.kind} property in ${listing.district}. Only one ${reqRow.kind} property per district is allowed.`,
            },
          },
        };
      }
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
