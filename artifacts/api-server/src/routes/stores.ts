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
  inventoryItems,
  walletTransactions,
  activityEvents,
  auditLog,
  users,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole } from "../lib/discord";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { logger } from "../lib/logger";
import { recordInventoryEvent } from "../lib/inventoryEvents";
import { applyWalletDelta } from "../lib/economy";

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

type StoreRow = typeof stores.$inferSelect;
type RipperdocRow = typeof ripperdocs.$inferSelect;

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
    .select({ id: storeEmployees.id, characterId: characters.id, name: characters.name, role: storeEmployees.role, ownerId: characters.ownerId })
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
  const { characterId, role } = req.body ?? {};
  if (!characterId) {
    res.status(400).json({ error: "characterId required" });
    return;
  }
  const [e] = await db.insert(storeEmployees).values({ storeId: s.id, characterId, role: role ?? "clerk" }).returning();
  res.status(201).json(e);
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
  const { name, category, price, quantity, notes } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const [it] = await db
    .insert(storeStock)
    .values({ storeId: s.id, name, category: category ?? null, price: price ?? 0, quantity: quantity ?? 0, notes: notes ?? null })
    .returning();
  res.status(201).json(it);
});

router.patch("/stores/:id/stock/:stockId", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  const stockId = parseInt(String(req.params.stockId), 10);
  const { name, category, price, quantity, notes } = req.body ?? {};
  const [u] = await db
    .update(storeStock)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(notes !== undefined ? { notes } : {}),
    })
    .where(and(eq(storeStock.id, stockId), eq(storeStock.storeId, s.id)))
    .returning();
  if (!u) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(u);
});

router.delete("/stores/:id/stock/:stockId", requireAuth, async (req, res): Promise<void> => {
  const s = await loadManageableStore(req, res);
  if (!s) return;
  const stockId = parseInt(String(req.params.stockId), 10);
  await db.delete(storeStock).where(and(eq(storeStock.id, stockId), eq(storeStock.storeId, s.id)));
  res.sendStatus(204);
});

// Atomic-ish sale: validate, debit buyer via UB, credit seller via UB
// (with compensating refund on credit failure), decrement stock, append
// buyer inventory item, log ledger + activity. Authorized actors are the
// venue owner or any character-employee of theirs.
async function sellFromVenue(opts: {
  kind: "store" | "ripperdoc";
  venueId: number;
  stockId: number;
  buyerCharacterId: number;
  qty: number;
  memo?: string;
  actor: { id: string; discordId: string; roles: string[]; username: string; avatarUrl: string | null };
  res: import("express").Response;
}) {
  const { kind, venueId, stockId, buyerCharacterId, qty, memo, actor, res } = opts;
  const venueTable = kind === "store" ? stores : ripperdocs;
  const stockTable = kind === "store" ? storeStock : ripperdocStock;
  const stockVenueCol = kind === "store" ? storeStock.storeId : ripperdocStock.ripperdocId;
  const empTable = kind === "store" ? storeEmployees : ripperdocEmployees;
  const empVenueCol = kind === "store" ? storeEmployees.storeId : ripperdocEmployees.ripperdocId;

  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }
  // Authorization: owner OR employee (via any of actor's characters) OR admin.
  let authorized = venue.ownerId === actor.id || hasRole(actor.roles, "ADMIN");
  if (!authorized) {
    const employed = await db
      .select()
      .from(empTable)
      .innerJoin(characters, eq(characters.id, empTable.characterId))
      .where(and(eq(empVenueCol, venueId), eq(characters.ownerId, actor.id)));
    authorized = employed.length > 0;
  }
  if (!authorized) {
    res.status(403).json({ error: "Not authorized to sell from this venue" });
    return;
  }
  const [item] = await db.select().from(stockTable).where(and(eq(stockTable.id, stockId), eq(stockVenueCol, venueId)));
  if (!item) {
    res.status(404).json({ error: "Stock item not found" });
    return;
  }
  if (qty > item.quantity) {
    res.status(409).json({ error: "Insufficient stock" });
    return;
  }
  const totalPaid = item.price * qty;
  const [buyer] = await db.select().from(characters).where(eq(characters.id, buyerCharacterId));
  if (!buyer) {
    res.status(404).json({ error: "Buyer character not found" });
    return;
  }
  if (buyer.archived) {
    res.status(400).json({ error: "Buyer character is archived" });
    return;
  }
  if (!buyer.ownerId) {
    res.status(409).json({ error: "Buyer character is unclaimed" });
    return;
  }
  const [buyerOwner] = await db.select().from(users).where(eq(users.id, buyer.ownerId));
  const [sellerOwner] = await db.select().from(users).where(eq(users.id, venue.ownerId));
  if (!buyerOwner || !sellerOwner) {
    res.status(409).json({ error: "Owner account missing" });
    return;
  }
  const buyerBal = await getBalance(buyerOwner.discordId);
  if (!buyerBal) {
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  if (buyerBal.cash < totalPaid) {
    res.status(400).json({ error: "Buyer has insufficient funds" });
    return;
  }
  const debited = await patchBalance(buyerOwner.discordId, {
    cash: -totalPaid,
    reason: memo ?? `Purchase: ${item.name} x${qty} @ ${venue.name}`,
  });
  if (!debited) {
    res.status(502).json({ error: "Wallet provider rejected debit" });
    return;
  }
  const credited = await patchBalance(sellerOwner.discordId, {
    cash: totalPaid,
    reason: memo ?? `Sale: ${item.name} x${qty} @ ${venue.name}`,
  });
  if (!credited) {
    const refund = await patchBalance(buyerOwner.discordId, {
      cash: totalPaid,
      reason: `Refund: seller credit failed for ${item.name}`,
    });
    if (!refund) {
      logger.error(
        { buyerDiscordId: buyerOwner.discordId, venueId, stockId, itemName: item.name, totalPaid },
        "SALE_REFUND_FAILED: buyer debited but seller credit AND refund failed — manual reconciliation required",
      );
      res.status(502).json({ error: "Purchase failed and refund failed; contact staff for reconciliation." });
      return;
    }
    res.status(502).json({ error: "Wallet provider rejected credit; buyer refunded" });
    return;
  }
  // Decrement stock (delete row if it hits zero).
  let updatedStock = { ...item, quantity: item.quantity - qty };
  if (updatedStock.quantity <= 0) {
    await db.delete(stockTable).where(eq(stockTable.id, stockId));
  } else {
    await db.update(stockTable).set({ quantity: updatedStock.quantity }).where(eq(stockTable.id, stockId));
  }
  // Insert into buyer inventory.
  let inserted;
  try {
    const [row] = await db
      .insert(inventoryItems)
      .values({
        characterId: buyer.id,
        ownerId: buyer.ownerId,
        name: item.name,
        category: item.category ?? (kind === "ripperdoc" ? "cyberware" : null),
        quantity: qty,
        notes: item.notes,
        pricePaid: totalPaid,
        acquiredAt: new Date(),
      })
      .returning();
    inserted = row;
  } catch (err) {
    logger.error({ err, venueId, stockId, buyerCharacterId }, "sale inventory insert failed after wallet writes");
    res.status(500).json({ error: "Inventory write failed after wallet writes; contact an admin." });
    return;
  }
  await recordInventoryEvent({
    instanceUuid: inserted.instanceUuid,
    kind: "created",
    actorId: actor.id,
    actorName: actor.username,
    toCharacterId: buyer.id,
    toCharacterName: buyer.name,
    itemName: inserted.name,
    quantity: qty,
    price: totalPaid,
    reason: `Sold at ${venue.name}`,
    metadata: { venueKind: kind, venueId, venueName: venue.name, stockId, memo: memo ?? null },
  });
  // Ledger entries (cosmetic; UB is authoritative for balance).
  await db.insert(walletTransactions).values([
    {
      characterId: buyer.id,
      counterpartyName: venue.name,
      amount: -totalPaid,
      kind: "shop",
      memo: memo ?? `Bought ${item.name} x${qty}`,
    },
    {
      characterId: venue.ownerCharacterId ?? null,
      userId: sellerOwner.id,
      counterpartyCharacterId: buyer.id,
      counterpartyName: buyer.name,
      amount: totalPaid,
      kind: "shop",
      memo: memo ?? `Sold ${item.name} x${qty}`,
    },
  ]);
  await db.insert(activityEvents).values({
    kind: "transfer",
    actorId: actor.id,
    actorName: actor.username,
    actorAvatarUrl: actor.avatarUrl,
    message: `${venue.name} sold ${item.name} x${qty} to ${buyer.name} for €$${totalPaid}`,
  });
  res.json({
    stock: { id: item.id, name: item.name, category: item.category, price: item.price, quantity: updatedStock.quantity, notes: item.notes },
    inventoryItem: inserted,
    totalPaid,
  });
}

router.post("/stores/:id/sell", requireAuth, async (req, res): Promise<void> => {
  const venueId = parseInt(String(req.params.id), 10);
  const { stockId, buyerCharacterId, qty, memo } = req.body ?? {};
  if (!stockId || !buyerCharacterId) {
    res.status(400).json({ error: "stockId and buyerCharacterId required" });
    return;
  }
  await sellFromVenue({
    kind: "store",
    venueId,
    stockId: parseInt(String(stockId), 10),
    buyerCharacterId: parseInt(String(buyerCharacterId), 10),
    qty: Math.max(1, Number(qty) || 1),
    memo,
    actor: req.user!,
    res,
  });
});

router.post("/ripperdocs/:id/sell", requireAuth, async (req, res): Promise<void> => {
  const venueId = parseInt(String(req.params.id), 10);
  const { stockId, buyerCharacterId, qty, memo } = req.body ?? {};
  if (!stockId || !buyerCharacterId) {
    res.status(400).json({ error: "stockId and buyerCharacterId required" });
    return;
  }
  await sellFromVenue({
    kind: "ripperdoc",
    venueId,
    stockId: parseInt(String(stockId), 10),
    buyerCharacterId: parseInt(String(buyerCharacterId), 10),
    qty: Math.max(1, Number(qty) || 1),
    memo,
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
    .select({ id: ripperdocEmployees.id, characterId: characters.id, name: characters.name, role: ripperdocEmployees.role, ownerId: characters.ownerId })
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
  const { characterId, role } = req.body ?? {};
  if (!characterId) {
    res.status(400).json({ error: "characterId required" });
    return;
  }
  const [e] = await db.insert(ripperdocEmployees).values({ ripperdocId: r.id, characterId, role: role ?? "doc" }).returning();
  res.status(201).json(e);
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
  const { name, category, price, quantity, notes } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const [it] = await db
    .insert(ripperdocStock)
    .values({ ripperdocId: r.id, name, category: category ?? null, price: price ?? 0, quantity: quantity ?? 0, notes: notes ?? null })
    .returning();
  res.status(201).json(it);
});

router.delete("/ripperdocs/:id/stock/:stockId", requireAuth, async (req, res): Promise<void> => {
  const r = await loadManageableRipperdoc(req, res);
  if (!r) return;
  const stockId = parseInt(String(req.params.stockId), 10);
  await db.delete(ripperdocStock).where(and(eq(ripperdocStock.id, stockId), eq(ripperdocStock.ripperdocId, r.id)));
  res.sendStatus(204);
});

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
