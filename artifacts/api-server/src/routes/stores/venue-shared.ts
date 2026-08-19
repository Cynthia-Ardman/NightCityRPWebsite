import type { Request, Response } from "express";
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  stores,
  storeEmployees,
  ripperdocs,
  ripperdocEmployees,
  characters,
  activityEvents,
  auditLog,
  users,
  customRequests,
  housing,
  catalogRent,
} from "@workspace/db";
import { hasRole, sendDirectMessage } from "../../lib/discord";
import { logger } from "../../lib/logger";
import { isStaffRoles as isStaff } from "../../lib/roleChecks";
import { announceRequest } from "../requests";

// ===== Shared management helpers =====
// Stores and ripperdocs are near-identical siblings. Both are managed by their
// owner OR by staff (fixers/admins). "Staff" is admin OR fixer (isStaffRoles) —
// never trust a client-sent role, always derive from the session user's roles.

export function auditMeta(req: Request): { ip: string | null; ua: string | null } {
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : (fwd?.toString().split(",")[0] ?? req.ip)) ?? null;
  const ua = req.headers["user-agent"]?.toString().slice(0, 500) ?? null;
  return { ip, ua };
}

// Coerce an incoming commission percentage to an integer in [0, 100]. Undefined
// or non-numeric input defaults to 0 so a missing field never throws.
export function clampPct(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// Shared PATCH for store/ripperdoc employees — updates role and/or commission
// percentage (owner or staff, enforced by the caller's load* guard) and writes
// a shop audit row. Both venue kinds use identical employee columns.
export async function patchVenueEmployee(args: {
  req: Request;
  res: Response;
  table: typeof storeEmployees | typeof ripperdocEmployees;
  venueCol: typeof storeEmployees.storeId | typeof ripperdocEmployees.ripperdocId;
  venueId: number;
  employeeId: number;
  targetType: "store" | "ripperdoc";
  action: string;
}): Promise<void> {
  const { req, res, table, venueCol, venueId, employeeId, targetType, action } = args;
  const [emp] = await db.select().from(table).where(and(eq(table.id, employeeId), eq(venueCol, venueId)));
  if (!emp) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  const patch: { role?: string; commissionPct?: number } = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (typeof req.body?.role === "string" && req.body.role.trim() && req.body.role !== emp.role) {
    patch.role = req.body.role.trim();
    before.role = emp.role;
    after.role = patch.role;
  }
  if (req.body?.commissionPct !== undefined) {
    const next = clampPct(req.body.commissionPct);
    if (next !== emp.commissionPct) {
      patch.commissionPct = next;
      before.commissionPct = emp.commissionPct;
      after.commissionPct = next;
    }
  }
  if (Object.keys(patch).length === 0) {
    res.json(emp);
    return;
  }
  const { ip, ua } = auditMeta(req);
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(table).set(patch).where(eq(table.id, employeeId)).returning();
    await tx.insert(auditLog).values({
      category: "shop",
      action,
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: `${targetType}_employee`,
      targetId: String(employeeId),
      message: `Updated ${targetType} employee #${employeeId}`,
      beforeJson: before as never,
      afterJson: after as never,
    });
    return u;
  });
  res.json(updated);
}

export type StoreRow = typeof stores.$inferSelect;
export type RipperdocRow = typeof ripperdocs.$inferSelect;

// True when the actor may operate (sell / buy stock) for a venue: the owner,
// an admin, or any employee linked via one of the actor's characters.
export async function isVenueOperator(
  kind: "store" | "ripperdoc",
  venue: { ownerId: string },
  venueId: number,
  actor: { id: string; roles: string[] },
): Promise<boolean> {
  if (venue.ownerId === actor.id || hasRole(actor.roles, "ADMIN") || hasRole(actor.roles, "FIXER"))
    return true;
  const empTable = kind === "store" ? storeEmployees : ripperdocEmployees;
  const empVenueCol = kind === "store" ? storeEmployees.storeId : ripperdocEmployees.ripperdocId;
  const employed = await db
    .select({ id: empTable.id })
    .from(empTable)
    .innerJoin(characters, eq(characters.id, empTable.characterId))
    .where(and(eq(empVenueCol, venueId), eq(characters.ownerId, actor.id)));
  return employed.length > 0;
}

// Load a store by :id and enforce that the caller is its owner or staff.
// Writes the 404/403 response and returns null when the caller may not manage
// it, so handlers can early-return.
export async function loadManageableStore(req: Request, res: Response): Promise<StoreRow | null> {
  const id = parseInt(String(req.params.id), 10);
  const [s] = await db.select().from(stores).where(eq(stores.id, id));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (s.ownerId !== req.user!.id && !isStaff(req.user!.roles)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return s;
}

export async function loadManageableRipperdoc(req: Request, res: Response): Promise<RipperdocRow | null> {
  const id = parseInt(String(req.params.id), 10);
  const [r] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, id));
  if (!r) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (r.ownerId !== req.user!.id && !isStaff(req.user!.roles)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return r;
}

// The business lease a venue is associated with, hydrated with the catalog
// building (district/tier) and tenant character name for display. Returns null
// when the venue isn't linked to a lease (off-map / legacy venues).
export async function loadVenueLease(housingId: number | null | undefined) {
  if (!housingId) return null;
  const [row] = await db
    .select({
      id: housing.id,
      address: housing.address,
      monthlyRent: housing.monthlyRent,
      listingId: housing.listingId,
      characterId: housing.characterId,
      characterName: characters.name,
      district: catalogRent.district,
      tier: catalogRent.tier,
    })
    .from(housing)
    .leftJoin(characters, eq(characters.id, housing.characterId))
    .leftJoin(catalogRent, eq(catalogRent.id, housing.listingId))
    .where(eq(housing.id, housingId));
  return row ?? null;
}

// Build a before/after diff for an edit. Only fields whose value actually
// changes are recorded, so the audit log captures exactly what the editor
// touched.
export function buildDiff(
  current: Record<string, unknown>,
  body: Record<string, unknown>,
  fields: string[],
): { patch: Record<string, unknown>; before: Record<string, unknown>; after: Record<string, unknown> } {
  const patch: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const field of fields) {
    const next = body[field];
    if (next === undefined) continue;
    const prev = current[field];
    if (JSON.stringify(prev ?? null) === JSON.stringify(next ?? null)) continue;
    patch[field] = next;
    before[field] = prev ?? null;
    after[field] = next ?? null;
  }
  return { patch, before, after };
}

// Resolve a staff "associate with lease" edit. When the PATCH changes housingId
// to a non-null value, validate it points at a business lease and pin the
// venue location to that lease's address (unless the same PATCH set location
// explicitly). Mutates patch/before/after so the change is audited. Returns an
// error message when the lease is invalid, else null. A null housingId clears
// the association and is always allowed.
export async function resolveLeaseAssociation(
  current: { location: string | null },
  patch: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<string | null> {
  if (!("housingId" in patch)) return null;
  const hid = patch.housingId;
  if (hid == null) return null;
  const [lease] = await db.select().from(housing).where(eq(housing.id, Number(hid)));
  if (!lease || lease.kind !== "business") return "Not a valid business lease";
  patch.housingId = lease.id;
  if (!("location" in patch)) {
    patch.location = lease.address;
    before.location = current.location ?? null;
    after.location = lease.address;
  }
  return null;
}

// Adding an employee no longer immediately employs them — it creates a pending
// `employee_invite` request the invited character's player must accept (from
// their Inbox). Validates the character (claimed, not archived, not
// already employed, no pending invite), inserts the request, DMs the invited
// player, and responds {pendingApproval, requestId}. Shared by store + ripperdoc.
export async function createEmployeeInvite(args: {
  req: Request;
  res: Response;
  kind: "store" | "ripperdoc";
  venueId: number;
  venueName: string;
}): Promise<void> {
  const { req, res, kind, venueId, venueName } = args;
  const characterId = parseInt(String(req.body?.characterId), 10);
  if (!characterId) {
    res.status(400).json({ error: "characterId required" });
    return;
  }
  const role =
    typeof req.body?.role === "string" && req.body.role.trim()
      ? req.body.role.trim()
      : kind === "store"
        ? "clerk"
        : "doc";
  const commissionPct = clampPct(req.body?.commissionPct);

  const [c] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!c) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (!c.ownerId) {
    res.status(400).json({ error: "That character is unclaimed — its player must claim it before they can be hired" });
    return;
  }
  if (c.archived) {
    res.status(400).json({ error: "That character is archived" });
    return;
  }
  // Capture the (now-narrowed) owner id; property narrowing on `c.ownerId` is
  // lost inside the transaction closure below.
  const ownerId = c.ownerId;

  const empTable = kind === "store" ? storeEmployees : ripperdocEmployees;
  const empVenueCol = kind === "store" ? storeEmployees.storeId : ripperdocEmployees.ripperdocId;

  // The already-employed / pending-invite checks and the insert run inside one
  // transaction guarded by a transaction-scoped advisory lock keyed on
  // (kind, venueId, characterId). Without it, two concurrent "add employee"
  // clicks for the same target both pass the read checks and insert duplicate
  // pending invites (there's no DB unique constraint to fall back on).
  const lockKey = `emp_invite:${kind}:${venueId}:${characterId}`;
  const txOut = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const [already] = await tx
      .select({ id: empTable.id })
      .from(empTable)
      .where(and(eq(empVenueCol, venueId), eq(empTable.characterId, characterId)));
    if (already) {
      return { error: { status: 409, body: { error: "That character already works here" } } };
    }
    const [pending] = await tx
      .select({ id: customRequests.id })
      .from(customRequests)
      .where(
        and(
          eq(customRequests.type, "employee_invite"),
          eq(customRequests.status, "pending"),
          eq(customRequests.characterId, characterId),
          sql`${customRequests.details}->>'venueId' = ${String(venueId)}`,
          sql`${customRequests.details}->>'kind' = ${kind}`,
        ),
      );
    if (pending) {
      return { error: { status: 409, body: { error: "An invitation for that character is already pending" } } };
    }
    const [row] = await tx
      .insert(customRequests)
      .values({
        type: "employee_invite",
        characterId,
        requestedById: ownerId,
        title: `Employment at ${venueName}`,
        description: null,
        details: {
          kind,
          venueId,
          venueName,
          role,
          commissionPct,
          invitedById: req.user!.id,
          invitedByName: req.user!.username,
        } as never,
      })
      .returning();
    return { ok: { inserted: row } };
  });
  if (!("ok" in txOut) || !txOut.ok) {
    const err = (txOut as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const inserted = txOut.ok.inserted;

  // Best-effort: DM the invited player + activity feed + audit (already committed).
  try {
    const [u] = await db.select({ discordId: users.discordId }).from(users).where(eq(users.id, c.ownerId));
    if (u?.discordId) {
      await sendDirectMessage(
        u.discordId,
        `${req.user!.username} invited ${c.name} to work at ${venueName} as ${role} (${commissionPct}% commission). Accept or decline it under "Inbox" on the NCRP portal.`,
      );
    }
  } catch (err) {
    logger.warn({ err, requestId: inserted.id }, "employee-invite DM failed");
  }
  try {
    await db.insert(activityEvents).values({
      kind: "request_submitted",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message: `${req.user!.username} invited ${c.name} to work at ${venueName}`,
    });
  } catch (err) {
    logger.warn({ err, requestId: inserted.id }, "employee-invite activity write failed");
  }
  const { ip, ua } = auditMeta(req);
  await db.insert(auditLog).values({
    category: "shop",
    action: kind === "store" ? "store_employee_invite" : "ripperdoc_employee_invite",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorIp: ip,
    actorUa: ua,
    targetType: "custom_request",
    targetId: String(inserted.id),
    message: `Invited ${c.name} to work at ${venueName}`,
    beforeJson: null,
    afterJson: { kind, venueId, characterId, role, commissionPct } as never,
  });

  res.status(201).json({ pendingApproval: true, requestId: inserted.id });
}

// Off-catalog ("custom") stock request raised by a venue owner. Goes onto the
// unified request pipeline as a `venue_stock` row for fixers to vote on; on
// approval that materializes into a `stock_cost` the owner pays. The request is
// attributed to the venue's owner character (so it shows in their My Submissions).
export async function createVenueStockRequest(args: {
  req: Request;
  res: Response;
  kind: "store" | "ripperdoc";
  venue: { id: number; name: string; ownerId: string; ownerCharacterId: number | null };
}): Promise<void> {
  const { req, res, kind, venue } = args;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const category = typeof req.body?.category === "string" && req.body.category.trim() ? req.body.category.trim() : null;
  const description = typeof req.body?.description === "string" && req.body.description.trim() ? req.body.description.trim() : null;
  const source = typeof req.body?.source === "string" && req.body.source.trim() ? req.body.source.trim() : null;

  // Attribute the request to the venue's owner character — prefer the stored
  // ownerCharacterId, else any owned character (the request needs a character).
  let characterId = venue.ownerCharacterId ?? null;
  if (!characterId) {
    const [owned] = await db
      .select({ id: characters.id })
      .from(characters)
      .where(eq(characters.ownerId, venue.ownerId))
      .limit(1);
    characterId = owned?.id ?? null;
  }
  if (!characterId) {
    res.status(400).json({ error: "No owner character to attribute this request to" });
    return;
  }

  const [inserted] = await db
    .insert(customRequests)
    .values({
      type: "venue_stock",
      characterId,
      requestedById: venue.ownerId,
      title: name,
      description,
      details: {
        kind,
        venueId: venue.id,
        venueName: venue.name,
        category,
        source,
      } as never,
    })
    .returning();
  // Announce to the cs-approver channel + open a Discord thread (fire-and-forget,
  // deployment-gated) for parity with sheets/edits/other custom requests. Venue
  // stock requests appear in the same review queue and expose a thread mirror,
  // but this creation path historically skipped the announce, so tickets showed
  // "No Discord thread linked to this ticket yet." The character-name lookup
  // (embed-only) lives inside the fire-and-forget block so a read failure here
  // can never fail the response after the row is already created.
  const submitterName = req.user!.username;
  const attributedCharacterId = characterId;
  void (async () => {
    const [charRow] = await db
      .select({ name: characters.name })
      .from(characters)
      .where(eq(characters.id, attributedCharacterId))
      .limit(1);
    await announceRequest(inserted.id, "venue_stock", name, charRow?.name ?? "(unknown)", submitterName);
  })().catch((err) => logger.warn({ err, requestId: inserted.id }, "venue_stock announce failed"));
  res.status(201).json(shapeCustomRequest(inserted));
}

// Minimal CustomRequest projection for the request-stock responses. The full
// request list (with character/owner names + tallies) is served by requests.ts;
// here we only need to echo the freshly-created row to the caller.
export function shapeCustomRequest(row: {
  id: number;
  type: string;
  characterId: number;
  requestedById: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  details: unknown;
  status: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  reviewerNote: string | null;
  appliedRef: string | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    characterId: row.characterId,
    characterName: "(unknown)",
    requestedById: row.requestedById,
    requestedByName: null,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl ?? null,
    details: row.details ?? null,
    status: row.status,
    reviewedById: row.reviewedById,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewerNote: row.reviewerNote,
    appliedRef: row.appliedRef,
    createdAt: row.createdAt.toISOString(),
  };
}
