import { Router, type IRouter } from "express";
import type { Request, Response } from "express";
import { eq, and, desc, sql, gte } from "drizzle-orm";
import {
  db,
  stores,
  storeEmployees,
  storeStock,
  ripperdocs,
  ripperdocEmployees,
  ripperdocStock,
  characters,
  walletTransactions,
  activityEvents,
  auditLog,
  users,
  catalogGuns,
  catalogCyberware,
  inventoryItems,
  customRequests,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole, sendDirectMessage } from "../lib/discord";
import { logger } from "../lib/logger";
import { applyWalletDelta } from "../lib/economy";
import { createOffer, createRemoveOffer, createStockAddOffer } from "../lib/saleOffers";
import { cwpForItem, parseCwp } from "../lib/cyberware";
import { checkCwpCapacity } from "../lib/cyberware-cap";

const router: IRouter = Router();

// ===== Shared management helpers =====
// Stores and ripperdocs are near-identical siblings. Both are managed by their
// owner OR by staff (fixers/admins). "Staff" is admin OR fixer — never trust a
// client-sent role, always derive from the session user's roles.
function isStaff(roles: string[]): boolean {
  return hasRole(roles, "ADMIN") || hasRole(roles, "FIXER");
}

function auditMeta(req: Request): { ip: string | null; ua: string | null } {
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : (fwd?.toString().split(",")[0] ?? req.ip)) ?? null;
  const ua = req.headers["user-agent"]?.toString().slice(0, 500) ?? null;
  return { ip, ua };
}

// Coerce an incoming commission percentage to an integer in [0, 100]. Undefined
// or non-numeric input defaults to 0 so a missing field never throws.
function clampPct(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// Shared PATCH for store/ripperdoc employees — updates role and/or commission
// percentage (owner or staff, enforced by the caller's load* guard) and writes
// a shop audit row. Both venue kinds use identical employee columns.
async function patchVenueEmployee(args: {
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

type StoreRow = typeof stores.$inferSelect;
type RipperdocRow = typeof ripperdocs.$inferSelect;

// True when the actor may operate (sell / buy stock) for a venue: the owner,
// an admin, or any employee linked via one of the actor's characters.
async function isVenueOperator(
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
async function loadManageableStore(req: Request, res: Response): Promise<StoreRow | null> {
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

async function loadManageableRipperdoc(req: Request, res: Response): Promise<RipperdocRow | null> {
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

// Build a before/after diff for an edit. Only fields whose value actually
// changes are recorded, so the audit log captures exactly what the editor
// touched.
function buildDiff(
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

// Adding an employee no longer immediately employs them — it creates a pending
// `employee_invite` request the invited character's player must accept (from
// their "My Requests"). Validates the character (claimed, not archived, not
// already employed, no pending invite), inserts the request, DMs the invited
// player, and responds {pendingApproval, requestId}. Shared by store + ripperdoc.
async function createEmployeeInvite(args: {
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
        `${req.user!.username} invited ${c.name} to work at ${venueName} as ${role} (${commissionPct}% commission). Accept or decline it under "My Requests" on the NCRP portal.`,
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
// attributed to the venue's owner character (so it shows in their My Requests).
async function createVenueStockRequest(args: {
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
  res.status(201).json(shapeCustomRequest(inserted));
}

// Minimal CustomRequest projection for the request-stock responses. The full
// request list (with character/owner names + tallies) is served by requests.ts;
// here we only need to echo the freshly-created row to the caller.
function shapeCustomRequest(row: {
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

// ===== Stores =====
// Returns stores the user owns OR is an employee at (via any of their characters).
router.get("/stores/mine", requireAuth, async (req, res): Promise<void> => {
  const owned = await db.select().from(stores).where(eq(stores.ownerId, req.user!.id));
  const employedRows = await db
    .selectDistinct({ store: stores })
    .from(stores)
    .innerJoin(storeEmployees, eq(storeEmployees.storeId, stores.id))
    .innerJoin(characters, eq(characters.id, storeEmployees.characterId))
    .where(eq(characters.ownerId, req.user!.id));
  const employed = employedRows.map((r) => r.store);
  const seen = new Set<number>();
  const merged = [...owned, ...employed].filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  res.json(merged);
});

router.get("/stores/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [s] = await db.select().from(stores).where(eq(stores.id, id));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const emps = await db
    .select({ id: storeEmployees.id, characterId: characters.id, name: characters.name, role: storeEmployees.role, commissionPct: storeEmployees.commissionPct, ownerId: characters.ownerId })
    .from(storeEmployees)
    .innerJoin(characters, eq(characters.id, storeEmployees.characterId))
    .where(eq(storeEmployees.storeId, id));
  const isOwner = s.ownerId === req.user!.id;
  const isEmployee = emps.some((e) => e.ownerId === req.user!.id);
  if (!isOwner && !isStaff(req.user!.roles) && !isEmployee) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const stock = await db.select().from(storeStock).where(eq(storeStock.storeId, id));
  res.json({ ...s, employees: emps.map(({ ownerId: _o, ...e }) => e), stock });
});

router.patch("/stores/:id", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Only staff may reassign ownership (to another user). Owners cannot hand
  // their venue to someone else through the edit form.
  const fields = ["name", "kind", "purpose", "location", "description", "bannerUrl", "ownerCharacterId"];
  if (isStaff(req.user!.roles)) fields.push("ownerId");
  const { patch, before, after } = buildDiff(s as unknown as Record<string, unknown>, body, fields);
  if (Object.keys(patch).length === 0) {
    res.json(s);
    return;
  }
  const { ip, ua } = auditMeta(req);
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(stores).set(patch).where(eq(stores.id, s.id)).returning();
    await tx.insert(auditLog).values({
      category: "shop",
      action: "store_update",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: "store",
      targetId: String(s.id),
      message: `Edited store "${u.name}"`,
      beforeJson: before as never,
      afterJson: after as never,
    });
    return u;
  });
  res.json(updated);
});

// Delete a store. Owner or staff. The FK cascade on store_employees /
// store_stock removes the venue's staff and inventory; the delete + audit run
// in one transaction so the trail can't drift from the deletion.
router.delete("/stores/:id", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  const { ip, ua } = auditMeta(req);
  await db.transaction(async (tx) => {
    await tx.delete(stores).where(eq(stores.id, s.id));
    await tx.insert(auditLog).values({
      category: "shop",
      action: "store_delete",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: "store",
      targetId: String(s.id),
      message: `Deleted store "${s.name}"`,
      beforeJson: s as never,
      afterJson: null,
    });
  });
  res.sendStatus(204);
});

router.post("/stores/:id/employees", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  await createEmployeeInvite({ req, res, kind: "store", venueId: s.id, venueName: s.name });
});

// Store owner requests a custom (off-catalog) item be stocked → fixer vote.
router.post("/stores/:id/request-stock", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  await createVenueStockRequest({ req, res, kind: "store", venue: s });
});

// Edit an employee's role and/or commission percentage. Owner or staff.
router.patch("/stores/:id/employees/:employeeId", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  await patchVenueEmployee({
    req,
    res,
    table: storeEmployees,
    venueCol: storeEmployees.storeId,
    venueId: s.id,
    employeeId: parseInt(String(req.params.employeeId), 10),
    targetType: "store",
    action: "store_employee_update",
  });
});

router.delete("/stores/:id/employees/:employeeId", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  const empId = parseInt(String(req.params.employeeId), 10);
  await db.delete(storeEmployees).where(and(eq(storeEmployees.id, empId), eq(storeEmployees.storeId, s.id)));
  res.sendStatus(204);
});

router.post("/stores/:id/stock", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  const { name, category, price, quantity, notes, description } = req.body ?? {};
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const cleanPrice = Math.max(0, Math.round(Number(price) || 0));
  const cleanQty = Math.max(0, Math.round(Number(quantity) || 0));
  const { ip, ua } = auditMeta(req);
  // Insert + audit atomically so a manual stock add can never land without an
  // audit trail (the task requires every manual add be logged).
  const it = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(storeStock)
      .values({
        storeId: s.id,
        name: name.trim(),
        category: category ?? null,
        price: cleanPrice,
        quantity: cleanQty,
        notes: notes ?? null,
        description: typeof description === "string" && description.trim() ? description.trim() : null,
      })
      .returning();
    await tx.insert(auditLog).values({
      category: "shop",
      action: "store_stock_add",
      actorId: req.user?.id ?? null,
      actorName: req.user?.username ?? null,
      actorIp: ip,
      actorUa: ua,
      targetType: "store",
      targetId: String(s.id),
      message: `Manually added "${row.name}" x${row.quantity} to ${s.name} stock`,
      afterJson: row as never,
    });
    return row;
  });
  res.status(201).json(it);
});

router.patch("/stores/:id/stock/:stockId", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  const stockId = parseInt(String(req.params.stockId), 10);
  const { name, category, price, quantity, notes, description } = req.body ?? {};
  const patch: Record<string, unknown> = {
    ...(name !== undefined ? { name } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(price !== undefined ? { price: Math.max(0, Math.round(Number(price) || 0)) } : {}),
    ...(quantity !== undefined ? { quantity: Math.max(0, Math.round(Number(quantity) || 0)) } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(description !== undefined ? { description } : {}),
  };
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No changes" });
    return;
  }
  const { ip, ua } = auditMeta(req);
  // Capture the before-row and write the audit in the same transaction so a
  // manual stock edit can never land without a trail (mirrors the add path).
  const result = await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(storeStock)
      .where(and(eq(storeStock.id, stockId), eq(storeStock.storeId, s.id)));
    if (!before) return null;
    const [u] = await tx
      .update(storeStock)
      .set(patch)
      .where(and(eq(storeStock.id, stockId), eq(storeStock.storeId, s.id)))
      .returning();
    await tx.insert(auditLog).values({
      category: "shop",
      action: "store_stock_edit",
      actorId: req.user?.id ?? null,
      actorName: req.user?.username ?? null,
      actorIp: ip,
      actorUa: ua,
      targetType: "store",
      targetId: String(s.id),
      message: `Edited stock "${u.name}" in ${s.name}`,
      beforeJson: before as never,
      afterJson: u as never,
    });
    return u;
  });
  if (!result) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(result);
});

router.delete("/stores/:id/stock/:stockId", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  const stockId = parseInt(String(req.params.stockId), 10);
  await db.delete(storeStock).where(and(eq(storeStock.id, stockId), eq(storeStock.storeId, s.id)));
  res.sendStatus(204);
});

// Instant sale: the owner/employee "sell" action charges the buyer and moves
// the item immediately (snapshotting price + the seller's commission) — there
// is no buyer approval step. See lib/saleOffers.ts createOffer →
// completeSaleOffer for the crash-safe debit/refund/commission flow.
router.post("/stores/:id/sell", requireAuth, async (req, res): Promise<void> => {
  const venueId = parseInt(String(req.params.id), 10);
  const { stockId, buyerCharacterId, qty, memo } = req.body ?? {};
  if (!stockId || !buyerCharacterId) {
    res.status(400).json({ error: "stockId and buyerCharacterId required" });
    return;
  }
  const result = await createOffer({
    kind: "store",
    venueId,
    stockId: parseInt(String(stockId), 10),
    buyerCharacterId: parseInt(String(buyerCharacterId), 10),
    qty: Math.max(1, Number(qty) || 1),
    memo,
    actor: req.user!,
  });
  res.status(result.status).json(result.body);
});

router.post("/ripperdocs/:id/sell", requireAuth, async (req, res): Promise<void> => {
  const venueId = parseInt(String(req.params.id), 10);
  const { stockId, buyerCharacterId, qty, memo } = req.body ?? {};
  if (!stockId || !buyerCharacterId) {
    res.status(400).json({ error: "stockId and buyerCharacterId required" });
    return;
  }
  const result = await createOffer({
    kind: "ripperdoc",
    venueId,
    stockId: parseInt(String(stockId), 10),
    buyerCharacterId: parseInt(String(buyerCharacterId), 10),
    qty: Math.max(1, Number(qty) || 1),
    memo,
    actor: req.user!,
  });
  res.status(result.status).json(result.body);
});

// Install a stock cyberware item onto a character (CWP-validated). Charges the
// buyer and installs the item instantly — there is no buyer approval step.
router.post("/ripperdocs/:id/install", requireAuth, async (req, res): Promise<void> => {
  const venueId = parseInt(String(req.params.id), 10);
  const { stockId, buyerCharacterId, qty, memo, price, cwp } = req.body ?? {};
  if (!stockId || !buyerCharacterId) {
    res.status(400).json({ error: "stockId and buyerCharacterId required" });
    return;
  }
  const result = await createOffer({
    kind: "ripperdoc",
    venueId,
    stockId: parseInt(String(stockId), 10),
    buyerCharacterId: parseInt(String(buyerCharacterId), 10),
    qty: Math.max(1, Number(qty) || 1),
    memo,
    offerType: "install",
    priceOverride: price != null ? Math.max(0, Number(price) || 0) : null,
    cwp: cwp != null ? Math.max(0, Number(cwp) || 0) : null,
    actor: req.user!,
  });
  res.status(result.status).json(result.body);
});

// Give a stock item to a character for free (price forced to 0).
router.post("/ripperdocs/:id/give", requireAuth, async (req, res): Promise<void> => {
  const venueId = parseInt(String(req.params.id), 10);
  const { stockId, buyerCharacterId, qty, memo } = req.body ?? {};
  if (!stockId || !buyerCharacterId) {
    res.status(400).json({ error: "stockId and buyerCharacterId required" });
    return;
  }
  const result = await createOffer({
    kind: "ripperdoc",
    venueId,
    stockId: parseInt(String(stockId), 10),
    buyerCharacterId: parseInt(String(buyerCharacterId), 10),
    qty: Math.max(1, Number(qty) || 1),
    memo,
    offerType: "give",
    actor: req.user!,
  });
  res.status(result.status).json(result.body);
});

// Remove installed cyberware from a character (optional removal fee). The item
// stays in the player's inventory by default, just no longer counted as CWP.
router.post("/ripperdocs/:id/remove", requireAuth, async (req, res): Promise<void> => {
  const venueId = parseInt(String(req.params.id), 10);
  const { removedItemId, buyerCharacterId, fee, memo } = req.body ?? {};
  if (!removedItemId || !buyerCharacterId) {
    res.status(400).json({ error: "removedItemId and buyerCharacterId required" });
    return;
  }
  const result = await createRemoveOffer({
    venueId,
    removedItemId: parseInt(String(removedItemId), 10),
    buyerCharacterId: parseInt(String(buyerCharacterId), 10),
    fee: fee != null ? Math.max(0, Number(fee) || 0) : null,
    memo,
    actor: req.user!,
  });
  res.status(result.status).json(result.body);
});

// Capacity + installed-cyberware snapshot for a character (so the clinic UI can
// show how much CWP a buyer has free before offering an install/remove).
router.get("/ripperdocs/:id/characters/:characterId/cyberware", requireAuth, async (req, res): Promise<void> => {
  const venueId = parseInt(String(req.params.id), 10);
  const characterId = parseInt(String(req.params.characterId), 10);
  const [venue] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, venueId));
  if (!venue) {
    res.status(404).json({ error: "Clinic not found" });
    return;
  }
  if (!(await isVenueOperator("ripperdoc", venue, venueId, req.user!))) {
    res.status(403).json({ error: "Not authorized to operate this clinic" });
    return;
  }
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  const cyberRows = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.characterId, characterId), eq(inventoryItems.category, "cyberware")));
  // "Installed" = chrome category AND a CWP install tag. Items sold/given without
  // installing land in inventory uninstalled (no CWP note) and must NOT surface
  // as installed or be removable; untagged chrome contributes 0 CWP regardless.
  const installed = cyberRows.filter((it) => parseCwp(it.notes) != null);
  const used = installed.reduce((sum, it) => sum + cwpForItem(it), 0);
  const cap = checkCwpCapacity({ kind: character.kind, used, add: 0 });
  res.json({
    characterId,
    characterName: character.name,
    kind: character.kind,
    used,
    max: cap.max,
    available: cap.available,
    installed: installed.map((it) => ({ id: it.id, name: it.name, quantity: it.quantity, notes: it.notes, cwp: cwpForItem(it) })),
  });
});

// Fixer/admin stocked a venue at a CUSTOM cost (> 0). Rather than debiting the
// owner's venue balance without consent, route a cost-approval to the owner: a
// `stock_cost` custom_request that shows up in the owner's "My Requests". On
// approval the stock is added and the balance is debited atomically; on reject
// nothing moves. The full stock payload is snapshotted in `details` so the
// terms can't drift before the owner decides.
async function createStockCostRequest(opts: {
  kind: "store" | "ripperdoc";
  venue: { id: number; name: string; ownerId: string; ownerCharacterId: number | null };
  catalogId: number;
  name: string;
  category: string | null;
  qty: number;
  unitCost: number;
  totalCost: number;
  retail: number;
  actor: { id: string; username: string; avatarUrl: string | null };
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { kind, venue, catalogId, name, category, qty, unitCost, totalCost, retail, actor } = opts;
  // custom_requests.characterId is NOT NULL — attach the request to the owner's
  // character (their assigned venue character, else any character they own).
  let characterId: number | null = venue.ownerCharacterId ?? null;
  if (!characterId) {
    const [c] = await db
      .select({ id: characters.id })
      .from(characters)
      .where(eq(characters.ownerId, venue.ownerId))
      .limit(1);
    characterId = c?.id ?? null;
  }
  if (!characterId) {
    return { status: 400, body: { error: "Venue owner has no character to attach a cost approval to" } };
  }
  const venueLabel = kind === "store" ? "store" : "ripperdoc";
  const title = `Stock ${name} ×${qty} for €$${totalCost.toLocaleString()}`;
  const description = `${actor.username} wants to stock ${venue.name} (${venueLabel}) with ${name} ×${qty} at €$${unitCost.toLocaleString()} each (total €$${totalCost.toLocaleString()}). Approving pays it from the venue balance and adds the stock.`;
  const [inserted] = await db
    .insert(customRequests)
    .values({
      type: "stock_cost",
      characterId,
      requestedById: venue.ownerId,
      title,
      description,
      details: {
        kind,
        venueId: venue.id,
        venueName: venue.name,
        catalogId,
        name,
        category,
        qty,
        unitCost,
        totalCost,
        retail,
        requestedByFixerId: actor.id,
        requestedByFixerName: actor.username,
      } as never,
    })
    .returning();
  await db.insert(activityEvents).values({
    kind: "shop",
    actorId: actor.id,
    actorName: actor.username,
    actorAvatarUrl: actor.avatarUrl,
    message: `${actor.username} proposed stocking ${venue.name} with ${name} ×${qty} (€$${totalCost.toLocaleString()}) — awaiting owner approval`,
  });
  try {
    const [owner] = await db
      .select({ discordId: users.discordId })
      .from(users)
      .where(eq(users.id, venue.ownerId));
    if (owner?.discordId) {
      await sendDirectMessage(
        owner.discordId,
        `${actor.username} proposed stocking your ${venueLabel} "${venue.name}" with ${name} ×${qty} at €$${unitCost.toLocaleString()} each (total €$${totalCost.toLocaleString()}). Review it under "My Requests" to approve or reject.`,
      );
    }
  } catch (err) {
    logger.warn({ err, requestId: inserted.id }, "stock-cost request owner DM failed");
  }
  return {
    status: 201,
    body: { pendingApproval: true, requestId: inserted.id, totalCost, unitCost },
  };
}

// ===== Venue catalog stock purchase =====
// Owner/employee/fixer buys a catalog item (catalogGuns for stores,
// catalogCyberware for ripperdocs) into the venue's stock at the CATALOG price,
// debited from the venue's website-only balance. (There is no separate
// wholesaler layer — venues buy directly from the main catalog.) The venue
// account never has a UB leg, so a single guarded atomic decrement
// (WHERE balance >= cost) is fully crash-safe — no reserve/refund dance needed.
// Stock is merged into an existing same-name row (price refreshed to the chosen
// retail) or inserted. The retail price defaults to the catalog price.
async function purchaseFromCatalog(opts: {
  kind: "store" | "ripperdoc";
  venueId: number;
  catalogId: number;
  qty: number;
  retailPrice?: number;
  // Fixer/admin only: override the per-unit cost charged to the venue.
  //   0  -> stock the item for free (no debit, no approval).
  //   >0 -> a custom cost; instead of debiting now, a cost-approval request is
  //         routed to the venue owner and the stock is added on approval.
  // Ignored for owner/employee callers (they always pay the catalog price).
  unitCostOverride?: number;
  actor: { id: string; roles: string[]; username: string; avatarUrl: string | null };
  res: Response;
}): Promise<void> {
  const { kind, venueId, catalogId, qty, retailPrice, unitCostOverride, actor, res } = opts;
  const venueTable = kind === "store" ? stores : ripperdocs;
  const stockTable = kind === "store" ? storeStock : ripperdocStock;
  const stockVenueCol = kind === "store" ? storeStock.storeId : ripperdocStock.ripperdocId;

  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }
  if (!(await isVenueOperator(kind, venue, venueId, actor))) {
    res.status(403).json({ error: "Not authorized to buy stock for this venue" });
    return;
  }
  // Resolve the catalog item and its catalog price.
  let name: string;
  let category: string | null;
  let catalogPrice: number;
  if (kind === "store") {
    const [g] = await db.select().from(catalogGuns).where(eq(catalogGuns.id, catalogId));
    if (!g) {
      res.status(404).json({ error: "Catalog item not found" });
      return;
    }
    name = g.name;
    category = g.category ?? g.weaponType ?? null;
    catalogPrice = g.price;
  } else {
    const [c] = await db.select().from(catalogCyberware).where(eq(catalogCyberware.id, catalogId));
    if (!c) {
      res.status(404).json({ error: "Catalog item not found" });
      return;
    }
    name = c.name;
    category = "cyberware";
    catalogPrice = c.price;
  }

  // Owner/employee always pay the catalog price. Fixer/admin may override the
  // per-unit cost (free or custom). A custom (>0) staff cost is NOT charged
  // here — it routes a cost-approval to the owner (handled below).
  const actorIsStaff = hasRole(actor.roles, "ADMIN") || hasRole(actor.roles, "FIXER");
  const hasOverride =
    actorIsStaff && unitCostOverride !== undefined && Number.isFinite(Number(unitCostOverride));
  const unitCost = hasOverride ? Math.max(0, Math.round(Number(unitCostOverride))) : catalogPrice;
  const totalCost = unitCost * qty;
  const retail = retailPrice !== undefined && Number.isFinite(Number(retailPrice))
    ? Math.max(0, Math.round(Number(retailPrice)))
    : catalogPrice;

  // Fixer/admin set a CUSTOM cost (> 0): don't debit now. Route a cost-approval
  // to the venue owner; the stock is added atomically when they approve it
  // from "My Requests" (see requests.ts POST /requests/:id/stock-decision).
  if (hasOverride && unitCost > 0) {
    const approval = await createStockCostRequest({
      kind,
      venue,
      catalogId,
      name,
      category,
      qty,
      unitCost,
      totalCost,
      retail,
      actor,
    });
    res.status(approval.status).json(approval.body);
    return;
  }

  // Atomic: guarded venue debit + stock merge/insert + ledger all-or-nothing so a
  // crash after the debit can never leave money gone without stock or a trace.
  let insufficient = false;
  let newBalance = 0;
  let stockRow: typeof storeStock.$inferSelect | typeof ripperdocStock.$inferSelect | undefined;
  await db.transaction(async (tx) => {
    const [debited] = await tx
      .update(venueTable)
      .set({ balance: sql`${venueTable.balance} - ${totalCost}` })
      .where(and(eq(venueTable.id, venueId), gte(venueTable.balance, totalCost)))
      .returning();
    if (!debited) {
      insufficient = true;
      throw new Error("insufficient-funds"); // rolls back (nothing else ran yet)
    }
    newBalance = debited.balance;
    const previousBalance = newBalance + totalCost;

    // Merge into an existing same-name stock row, else insert.
    const [existing] = await tx
      .select()
      .from(stockTable)
      .where(and(eq(stockVenueCol, venueId), eq(stockTable.name, name)));
    if (existing) {
      const [u] = await tx
        .update(stockTable)
        .set({ quantity: existing.quantity + qty, price: retail, category: existing.category ?? category })
        .where(eq(stockTable.id, existing.id))
        .returning();
      stockRow = u;
    } else {
      const [ins] = await tx
        .insert(stockTable)
        .values({ [kind === "store" ? "storeId" : "ripperdocId"]: venueId, name, category, price: retail, quantity: qty } as never)
        .returning();
      stockRow = ins;
    }

    // Venue ledger row (website-only; no player wallet moved).
    await tx.insert(walletTransactions).values({
      storeId: kind === "store" ? venueId : null,
      ripperdocId: kind === "ripperdoc" ? venueId : null,
      amount: -totalCost,
      kind: "stock_purchase",
      source: kind,
      counterpartyName: "Catalog",
      memo: `Bought ${name} x${qty} @ €$${unitCost} from catalog`,
      previousBalance,
      newBalance,
    });
  }).catch((err) => {
    if (!insufficient) throw err;
  });
  if (insufficient) {
    res.status(400).json({ error: "Store account has insufficient funds" });
    return;
  }

  const { ip, ua } = auditMeta(opts.res.req as Request);
  await db.insert(auditLog).values({
    category: "shop",
    action: "venue_stock_purchase",
    actorId: actor.id,
    actorName: actor.username,
    actorIp: ip,
    actorUa: ua,
    targetType: kind,
    targetId: String(venueId),
    message: `Bought ${name} x${qty} into ${venue.name} for €$${totalCost}`,
    afterJson: { catalogId, name, qty, unitCost, totalCost, retail } as never,
  });
  await db.insert(activityEvents).values({
    kind: "shop",
    actorId: actor.id,
    actorName: actor.username,
    actorAvatarUrl: actor.avatarUrl,
    message: `${venue.name} restocked ${name} x${qty} from the catalog (€$${totalCost})`,
  });

  res.status(201).json({ stock: stockRow, balance: newBalance, totalCost, unitCost });
}

router.post("/stores/:id/purchase", requireAuth, async (req, res): Promise<void> => {
  const catalogId = parseInt(String(req.body?.catalogId), 10);
  if (!catalogId) {
    res.status(400).json({ error: "catalogId required" });
    return;
  }
  await purchaseFromCatalog({
    kind: "store",
    venueId: parseInt(String(req.params.id), 10),
    catalogId,
    qty: Math.max(1, Number(req.body?.qty) || 1),
    retailPrice: req.body?.retailPrice,
    unitCostOverride: req.body?.unitCost,
    actor: req.user!,
    res,
  });
});

router.post("/ripperdocs/:id/purchase", requireAuth, async (req, res): Promise<void> => {
  const catalogId = parseInt(String(req.body?.catalogId), 10);
  if (!catalogId) {
    res.status(400).json({ error: "catalogId required" });
    return;
  }
  await purchaseFromCatalog({
    kind: "ripperdoc",
    venueId: parseInt(String(req.params.id), 10),
    catalogId,
    qty: Math.max(1, Number(req.body?.qty) || 1),
    retailPrice: req.body?.retailPrice,
    unitCostOverride: req.body?.unitCost,
    actor: req.user!,
    res,
  });
});

// ===== Ripperdocs =====
// Returns clinics the user owns OR is an employee at (via any of their characters).
router.get("/ripperdocs/mine", requireAuth, async (req, res): Promise<void> => {
  const owned = await db.select().from(ripperdocs).where(eq(ripperdocs.ownerId, req.user!.id));
  const employedRows = await db
    .selectDistinct({ doc: ripperdocs })
    .from(ripperdocs)
    .innerJoin(ripperdocEmployees, eq(ripperdocEmployees.ripperdocId, ripperdocs.id))
    .innerJoin(characters, eq(characters.id, ripperdocEmployees.characterId))
    .where(eq(characters.ownerId, req.user!.id));
  const employed = employedRows.map((r) => r.doc);
  const seen = new Set<number>();
  const merged = [...owned, ...employed].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  res.json(merged);
});

router.get("/ripperdocs/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [r] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, id));
  if (!r) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const emps = await db
    .select({ id: ripperdocEmployees.id, characterId: characters.id, name: characters.name, role: ripperdocEmployees.role, commissionPct: ripperdocEmployees.commissionPct, ownerId: characters.ownerId })
    .from(ripperdocEmployees)
    .innerJoin(characters, eq(characters.id, ripperdocEmployees.characterId))
    .where(eq(ripperdocEmployees.ripperdocId, id));
  const isOwner = r.ownerId === req.user!.id;
  const isEmployee = emps.some((e) => e.ownerId === req.user!.id);
  if (!isOwner && !isStaff(req.user!.roles) && !isEmployee) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const stock = await db.select().from(ripperdocStock).where(eq(ripperdocStock.ripperdocId, id));
  res.json({ ...r, employees: emps.map(({ ownerId: _o, ...e }) => e), stock });
});

router.patch("/ripperdocs/:id", requireAuth, async (req, res): Promise<void> => {
  const r = await loadManageableRipperdoc(req, res);
  if (!r) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields = ["name", "purpose", "location", "description", "bannerUrl", "ownerCharacterId"];
  if (isStaff(req.user!.roles)) fields.push("ownerId");
  const { patch, before, after } = buildDiff(r as unknown as Record<string, unknown>, body, fields);
  if (Object.keys(patch).length === 0) {
    res.json(r);
    return;
  }
  const { ip, ua } = auditMeta(req);
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(ripperdocs).set(patch).where(eq(ripperdocs.id, r.id)).returning();
    await tx.insert(auditLog).values({
      category: "shop",
      action: "ripperdoc_update",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: "ripperdoc",
      targetId: String(r.id),
      message: `Edited ripperdoc "${u.name}"`,
      beforeJson: before as never,
      afterJson: after as never,
    });
    return u;
  });
  res.json(updated);
});

// Delete a ripperdoc. Owner or staff; cascades employees + stock.
router.delete("/ripperdocs/:id", requireAuth, async (req, res): Promise<void> => {
  const r = await loadManageableRipperdoc(req, res);
  if (!r) return;
  const { ip, ua } = auditMeta(req);
  await db.transaction(async (tx) => {
    await tx.delete(ripperdocs).where(eq(ripperdocs.id, r.id));
    await tx.insert(auditLog).values({
      category: "shop",
      action: "ripperdoc_delete",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: "ripperdoc",
      targetId: String(r.id),
      message: `Deleted ripperdoc "${r.name}"`,
      beforeJson: r as never,
      afterJson: null,
    });
  });
  res.sendStatus(204);
});

router.post("/ripperdocs/:id/employees", requireAuth, async (req, res): Promise<void> => {
  const r = await loadManageableRipperdoc(req, res);
  if (!r) return;
  await createEmployeeInvite({ req, res, kind: "ripperdoc", venueId: r.id, venueName: r.name });
});

// Ripperdoc owner requests a custom (off-catalog) item be stocked → fixer vote.
router.post("/ripperdocs/:id/request-stock", requireAuth, async (req, res): Promise<void> => {
  const r = await loadManageableRipperdoc(req, res);
  if (!r) return;
  await createVenueStockRequest({ req, res, kind: "ripperdoc", venue: r });
});

// Edit an employee's role and/or commission percentage. Owner or staff.
router.patch("/ripperdocs/:id/employees/:employeeId", requireAuth, async (req, res): Promise<void> => {
  const r = await loadManageableRipperdoc(req, res);
  if (!r) return;
  await patchVenueEmployee({
    req,
    res,
    table: ripperdocEmployees,
    venueCol: ripperdocEmployees.ripperdocId,
    venueId: r.id,
    employeeId: parseInt(String(req.params.employeeId), 10),
    targetType: "ripperdoc",
    action: "ripperdoc_employee_update",
  });
});

router.delete("/ripperdocs/:id/employees/:employeeId", requireAuth, async (req, res): Promise<void> => {
  const r = await loadManageableRipperdoc(req, res);
  if (!r) return;
  const empId = parseInt(String(req.params.employeeId), 10);
  await db.delete(ripperdocEmployees).where(and(eq(ripperdocEmployees.id, empId), eq(ripperdocEmployees.ripperdocId, r.id)));
  res.sendStatus(204);
});

router.post("/ripperdocs/:id/stock", requireAuth, async (req, res): Promise<void> => {
  const r = await loadManageableRipperdoc(req, res);
  if (!r) return;
  const { name, category, price, quantity, notes, slot, cwp, description } = req.body ?? {};
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name required" });
    return;
  }
  if (typeof slot !== "string" || !slot.trim()) {
    res.status(400).json({ error: "slot required" });
    return;
  }
  const cleanPrice = Math.max(0, Math.round(Number(price) || 0));
  const cleanQty = Math.max(0, Math.round(Number(quantity) || 0));
  // Encode cyberware slot + CWP into notes using the importer/parseCwp
  // convention ("CWP <n> · Slot: <slot>") so downstream CWP derivation keeps
  // working. An explicit `notes` body field wins if provided.
  let finalNotes: string | null = typeof notes === "string" && notes.trim() ? notes.trim() : null;
  if (finalNotes === null) {
    const parts: string[] = [];
    const cwpNum = cwp != null && cwp !== "" ? Math.max(0, Math.round(Number(cwp))) : null;
    if (cwpNum != null && Number.isFinite(cwpNum)) parts.push(`CWP ${cwpNum}`);
    parts.push(`Slot: ${slot.trim()}`);
    finalNotes = parts.join(" · ");
  }
  const { ip, ua } = auditMeta(req);
  // Insert + audit atomically so a manual stock add can never land without an
  // audit trail (the task requires every manual add be logged).
  const it = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(ripperdocStock)
      .values({
        ripperdocId: r.id,
        name: name.trim(),
        category: typeof category === "string" && category.trim() ? category.trim() : null,
        price: cleanPrice,
        quantity: cleanQty,
        notes: finalNotes,
        description: typeof description === "string" && description.trim() ? description.trim() : null,
      })
      .returning();
    await tx.insert(auditLog).values({
      category: "shop",
      action: "ripperdoc_stock_add",
      actorId: req.user?.id ?? null,
      actorName: req.user?.username ?? null,
      actorIp: ip,
      actorUa: ua,
      targetType: "ripperdoc",
      targetId: String(r.id),
      message: `Manually added "${row.name}" x${row.quantity} to ${r.name} cyberware stock`,
      afterJson: row as never,
    });
    return row;
  });
  res.status(201).json(it);
});

router.delete("/ripperdocs/:id/stock/:stockId", requireAuth, async (req, res): Promise<void> => {
  const r = await loadManageableRipperdoc(req, res);
  if (!r) return;
  const stockId = parseInt(String(req.params.stockId), 10);
  await db.delete(ripperdocStock).where(and(eq(ripperdocStock.id, stockId), eq(ripperdocStock.ripperdocId, r.id)));
  res.sendStatus(204);
});

// Admin-only: propose adding a cyberware piece to a venue's stock for a price
// the venue pays on approval. The venue owner approves/denies at /offers/mine;
// nothing moves until then. Money is billed to the venue's internal balance.
async function createStockOffer(req: Request, res: Response, kind: "store" | "ripperdoc"): Promise<void> {
  if (!hasRole(req.user!.roles, "ADMIN")) {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  const venueId = parseInt(String(req.params.id), 10);
  const { itemName, unitPrice, quantity, cwp, memo } = req.body ?? {};
  const result = await createStockAddOffer({
    kind,
    venueId,
    itemName: String(itemName ?? ""),
    unitPrice: Number(unitPrice) || 0,
    quantity: Math.max(1, Number(quantity) || 1),
    cwp: cwp != null && cwp !== "" ? Number(cwp) : null,
    memo: memo ?? null,
    actor: {
      id: req.user!.id,
      roles: req.user!.roles,
      username: req.user!.username,
      avatarUrl: req.user!.avatarUrl,
    },
  });
  res.status(result.status).json(result.body);
}

router.post("/stores/:id/stock-offer", requireAuth, (req, res) => createStockOffer(req, res, "store"));
router.post("/ripperdocs/:id/stock-offer", requireAuth, (req, res) => createStockOffer(req, res, "ripperdoc"));

// ===== Venue accounts: deposit / withdraw / transaction history =====
// Stores and ripperdocs each have a website-only `balance`. The OWNER can move
// money between their personal wallet and the venue account:
//   - deposit  : personal wallet  -> venue   (personal leg syncs to UB)
//   - withdraw : venue            -> personal wallet (personal leg syncs to UB)
// The personal leg goes through the economy sync wrapper (UB + idempotency +
// tri-state mode). The venue leg is website-only. Two ledger rows are written:
// the personal-leg row (userId set, from the wrapper) and a venue-leg row
// (storeId/ripperdocId set, userId null) so the player history and the
// per-venue history stay cleanly separated. Reconciliation never touches venue
// balances.
type VenueKind = "store" | "ripperdoc";

async function venueDepositWithdraw(opts: {
  kind: VenueKind;
  venueId: number;
  direction: "deposit" | "withdraw";
  amount: number;
  req: Request;
  res: Response;
}): Promise<void> {
  const { kind, venueId, direction, amount, req, res } = opts;
  if (!Number.isInteger(amount) || amount <= 0) {
    res.status(400).json({ error: "amount must be a positive whole number" });
    return;
  }
  const venueTable = kind === "store" ? stores : ripperdocs;
  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Owner-only: the personal leg is the owner's wallet. Staff/employees cannot
  // move money in/out of someone else's business account.
  if (venue.ownerId !== req.user!.id) {
    res.status(403).json({ error: "Only the owner can move money to or from this account." });
    return;
  }
  const [owner] = await db.select().from(users).where(eq(users.id, venue.ownerId));
  if (!owner) {
    res.status(400).json({ error: "Owner account is missing" });
    return;
  }

  const personalDelta = direction === "deposit" ? -amount : amount;
  const venueDelta = direction === "deposit" ? amount : -amount;

  // Venue-side overdraw guard (personal-side overdraw is enforced by the wrapper).
  if (direction === "withdraw" && venue.balance < amount) {
    res.status(400).json({ error: "Insufficient venue balance" });
    return;
  }

  const idempotencyKey = `venue-${kind}-${venueId}-${direction}-${Date.now()}-${owner.id}`;
  const result = await applyWalletDelta({
    userId: owner.id,
    discordId: owner.discordId,
    amount: personalDelta,
    source: kind,
    kind: `${kind}_${direction}`,
    reason: `${direction === "deposit" ? "Deposit to" : "Withdrawal from"} ${venue.name}`,
    memo: `${direction} ${kind} "${venue.name}"`,
    storeId: kind === "store" ? venueId : null,
    ripperdocId: kind === "ripperdoc" ? venueId : null,
    relatedEntityType: kind,
    relatedEntityId: venueId,
    idempotencyKey,
  });

  if (result.status === "disabled") {
    res.status(409).json({ error: "The economy system is currently disabled." });
    return;
  }
  if (result.status === "insufficient_funds") {
    res.status(400).json({ error: "Insufficient personal wallet balance" });
    return;
  }
  if (result.status === "dry_run") {
    res.json({
      ok: true,
      dryRun: true,
      venueBalance: venue.balance,
      proposedVenueBalance: venue.balance + venueDelta,
      walletBalance: result.balance,
      proposedWalletBalance: result.proposedBalance,
    });
    return;
  }
  if (!result.ok) {
    res.status(502).json({ error: result.error ?? "Wallet sync failed; no money moved." });
    return;
  }

  // Personal leg is live-synced. Move the venue side (website-only) + write the
  // venue-leg ledger row and audit, atomically. For withdrawals the venue debit
  // is guarded (balance >= amount) in the same statement so concurrent
  // withdrawals cannot drive the venue negative; if the guard loses the race we
  // reverse the already-applied personal credit below so no money is minted.
  const { ip, ua } = auditMeta(req);
  let finalVenueBalance = venue.balance + venueDelta;
  let venueGuardFailed = false;
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(venueTable)
      .set({ balance: sql`${venueTable.balance} + ${venueDelta}` })
      .where(
        direction === "withdraw"
          ? and(eq(venueTable.id, venueId), gte(venueTable.balance, amount))
          : eq(venueTable.id, venueId),
      )
      .returning({ balance: venueTable.balance });
    if (updated.length === 0) {
      // Withdraw lost the concurrency race: venue dropped below `amount`.
      venueGuardFailed = true;
      return;
    }
    finalVenueBalance = updated[0].balance;
    await tx.insert(walletTransactions).values({
      amount: venueDelta,
      kind: `${kind}_${direction}`,
      source: kind,
      syncStatus: "synced",
      memo: `${direction === "deposit" ? "Owner deposit" : "Owner withdrawal"} — ${venue.name}`,
      previousBalance: finalVenueBalance - venueDelta,
      newBalance: finalVenueBalance,
      storeId: kind === "store" ? venueId : null,
      ripperdocId: kind === "ripperdoc" ? venueId : null,
      relatedEntityType: kind,
      relatedEntityId: venueId,
    });
    await tx.insert(auditLog).values({
      category: "shop",
      action: `${kind}_${direction}`,
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: kind,
      targetId: String(venueId),
      message: `${direction === "deposit" ? "Deposited" : "Withdrew"} ${amount} eddies ${direction === "deposit" ? "to" : "from"} ${venue.name}`,
    });
  });

  if (venueGuardFailed) {
    // The personal leg already credited the owner via UB, so reverse it to keep
    // the books balanced. Derived idempotency key keeps the reversal retry-safe;
    // allowNegative bypasses overdraw protection (we are undoing our own credit).
    const reversal = await applyWalletDelta({
      userId: owner.id,
      discordId: owner.discordId,
      amount: -personalDelta,
      source: kind,
      kind: `${kind}_${direction}_reversal`,
      reason: `Reversed ${direction} — insufficient ${kind} balance: ${venue.name}`,
      memo: `reversal of ${direction} ${kind} "${venue.name}"`,
      storeId: kind === "store" ? venueId : null,
      ripperdocId: kind === "ripperdoc" ? venueId : null,
      relatedEntityType: kind,
      relatedEntityId: venueId,
      idempotencyKey: `${idempotencyKey}-reversal`,
      allowNegative: true,
    });
    // Only a confirmed reversal (synced now or already applied) means no money
    // was minted. A failed/pending reversal leaves the owner credited without a
    // venue debit — surface it loudly and write a high-severity audit marker so
    // it is discoverable and can be retried; do NOT report a clean 400.
    if (reversal.status === "synced" || reversal.status === "duplicate") {
      res.status(400).json({ error: "Insufficient venue balance" });
      return;
    }
    const { ip: rip, ua: rua } = auditMeta(req);
    logger.error(
      { venueKind: kind, venueId, ownerId: owner.id, amount, reversalStatus: reversal.status, reversalError: reversal.error, ledgerId: reversal.ledgerId },
      "venue withdraw reversal NOT confirmed — owner credited without venue debit; manual reconciliation required",
    );
    await db.insert(auditLog).values({
      category: "shop",
      action: `${kind}_${direction}_reversal_failed`,
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: rip,
      actorUa: rua,
      targetType: kind,
      targetId: String(venueId),
      message: `Reversal of ${amount} eddies ${direction} on ${venue.name} did not confirm (${reversal.status}). Owner ${owner.id} may have been credited without a venue debit — needs manual reconciliation.`,
    });
    res.status(502).json({ error: "Withdrawal could not be completed and the reversal did not confirm. This has been flagged for review; please do not retry." });
    return;
  }

  res.json({ ok: true, venueBalance: finalVenueBalance, walletBalance: result.balance });
}

router.post("/stores/:id/deposit", requireAuth, async (req, res): Promise<void> => {
  await venueDepositWithdraw({ kind: "store", venueId: parseInt(String(req.params.id), 10), direction: "deposit", amount: Number(req.body?.amount), req, res });
});
router.post("/stores/:id/withdraw", requireAuth, async (req, res): Promise<void> => {
  await venueDepositWithdraw({ kind: "store", venueId: parseInt(String(req.params.id), 10), direction: "withdraw", amount: Number(req.body?.amount), req, res });
});
router.post("/ripperdocs/:id/deposit", requireAuth, async (req, res): Promise<void> => {
  await venueDepositWithdraw({ kind: "ripperdoc", venueId: parseInt(String(req.params.id), 10), direction: "deposit", amount: Number(req.body?.amount), req, res });
});
router.post("/ripperdocs/:id/withdraw", requireAuth, async (req, res): Promise<void> => {
  await venueDepositWithdraw({ kind: "ripperdoc", venueId: parseInt(String(req.params.id), 10), direction: "withdraw", amount: Number(req.body?.amount), req, res });
});

// Per-venue transaction history (owner or staff only).
router.get("/stores/:id/transactions", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  const rows = await db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.storeId, s.id))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(100);
  res.json(rows);
});
router.get("/ripperdocs/:id/transactions", requireAuth, async (req, res): Promise<void> => {
  const r = await loadManageableRipperdoc(req, res);
  if (!r) return;
  const rows = await db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.ripperdocId, r.id))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(100);
  res.json(rows);
});

export default router;
