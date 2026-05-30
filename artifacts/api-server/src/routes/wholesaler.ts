import { Router, type IRouter } from "express";
import { eq, and, sql, desc } from "drizzle-orm";
import {
  db,
  wholesalerItems,
  wholesalerOrders,
  stores,
  storeStock,
  storeEmployees,
  ripperdocs,
  ripperdocStock,
  ripperdocEmployees,
  characters,
  activityEvents,
  walletTransactions,
  users,
} from "@workspace/db";
import { requireAuth, requireRole, requireAnyRole } from "../middlewares/auth";
import { hasRole } from "../lib/discord";
import { patchBalance, getBalance } from "../lib/unbelievaboat";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ===== Wholesaler catalog (read) =====
// Staff-only: rows carry internal wholesale prices and staff notes, and the
// only consumers are the admin wholesaler page and the fixer restock dialog.
// Gating to FIXER/ADMIN prevents regular players from crawling cost/margin
// data. Archived items are hidden unless ?all=true.
router.get("/wholesaler/items", requireAuth, requireAnyRole(["FIXER", "ADMIN"]), async (req, res): Promise<void> => {
  const includeArchived = String(req.query.all ?? "") === "true";
  const rows = await db.select().from(wholesalerItems).orderBy(wholesalerItems.name);
  const visible = includeArchived ? rows : rows.filter((r) => !r.archived);
  // Annotate with units ordered so the UI can show remaining-stock against cap.
  const sums = await db
    .select({
      wholesalerItemId: wholesalerOrders.wholesalerItemId,
      ordered: sql<number>`coalesce(sum(${wholesalerOrders.quantity}), 0)::int`,
    })
    .from(wholesalerOrders)
    .groupBy(wholesalerOrders.wholesalerItemId);
  const sumByItem = new Map(sums.map((s) => [s.wholesalerItemId, s.ordered]));
  res.json(
    visible.map((r) => ({
      ...r,
      unitsOrdered: sumByItem.get(r.id) ?? 0,
      unitsRemaining: r.cap == null ? null : Math.max(0, r.cap - (sumByItem.get(r.id) ?? 0)),
    })),
  );
});

// ===== Wholesaler catalog (admin CRUD) =====
router.post("/admin/wholesaler/items", requireAuth, requireRole("ADMIN"), async (req, res): Promise<void> => {
  const { name, category, tier, wholesalePrice, suggestedRetailPrice, cap, notes } = req.body ?? {};
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name required" });
    return;
  }
  const t = tier === "ripperdoc" ? "ripperdoc" : "store";
  const [row] = await db
    .insert(wholesalerItems)
    .values({
      name,
      category: category ?? null,
      tier: t,
      wholesalePrice: Math.max(0, Number(wholesalePrice) || 0),
      suggestedRetailPrice: suggestedRetailPrice == null ? null : Math.max(0, Number(suggestedRetailPrice) || 0),
      cap: cap == null || cap === "" ? null : Math.max(0, Number(cap) || 0),
      notes: notes ?? null,
    })
    .returning();
  res.status(201).json({ ...row, unitsOrdered: 0, unitsRemaining: row.cap ?? null });
});

router.patch("/admin/wholesaler/items/:id", requireAuth, requireRole("ADMIN"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { name, category, tier, wholesalePrice, suggestedRetailPrice, cap, notes, archived } = req.body ?? {};
  const [row] = await db
    .update(wholesalerItems)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(tier !== undefined ? { tier: tier === "ripperdoc" ? "ripperdoc" : "store" } : {}),
      ...(wholesalePrice !== undefined ? { wholesalePrice: Math.max(0, Number(wholesalePrice) || 0) } : {}),
      ...(suggestedRetailPrice !== undefined
        ? { suggestedRetailPrice: suggestedRetailPrice == null ? null : Math.max(0, Number(suggestedRetailPrice) || 0) }
        : {}),
      ...(cap !== undefined ? { cap: cap == null || cap === "" ? null : Math.max(0, Number(cap) || 0) } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(archived !== undefined ? { archived: Boolean(archived) } : {}),
    })
    .where(eq(wholesalerItems.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.delete("/admin/wholesaler/items/:id", requireAuth, requireRole("ADMIN"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  // Soft-delete via archive so historical orders keep their FK target intact.
  const [row] = await db
    .update(wholesalerItems)
    .set({ archived: true })
    .where(eq(wholesalerItems.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.sendStatus(204);
});

// ===== Restock from wholesaler (fixer-only) =====
// Body: { wholesalerItemId, quantity, targetKind: "store"|"ripperdoc", targetStoreId }.
// Validates fixer permission on the target venue (owner OR character-employee),
// enforces wholesaler cap, debits the fixer's wallet via UB, pushes units into
// the venue's stock, writes ledger + activity. The store's `price` is set from
// the item's suggestedRetailPrice (falling back to 2x wholesale) when the item
// is new to the store; existing rows keep their price (price changes don't
// retroactively affect already-placed stock).
router.post("/wholesaler/restock", requireAuth, requireAnyRole(["FIXER", "ADMIN"]), async (req, res): Promise<void> => {
  const { wholesalerItemId, quantity, targetKind, targetStoreId } = req.body ?? {};
  const itemId = parseInt(String(wholesalerItemId), 10);
  const qty = Math.max(1, parseInt(String(quantity), 10) || 0);
  const venueId = parseInt(String(targetStoreId), 10);
  const kind = targetKind === "ripperdoc" ? "ripperdoc" : "store";
  if (!itemId || !qty || !venueId) {
    res.status(400).json({ error: "wholesalerItemId, quantity, targetStoreId required" });
    return;
  }
  const [item] = await db.select().from(wholesalerItems).where(eq(wholesalerItems.id, itemId));
  if (!item) {
    res.status(404).json({ error: "Wholesaler item not found" });
    return;
  }
  if (item.archived) {
    res.status(400).json({ error: "Wholesaler item is archived" });
    return;
  }
  if (item.tier !== kind) {
    res.status(400).json({ error: `This item is sold to ${item.tier}s, not ${kind}s` });
    return;
  }
  // Cap check (sum prior orders against item.cap).
  if (item.cap != null) {
    const [{ ordered }] = await db
      .select({ ordered: sql<number>`coalesce(sum(${wholesalerOrders.quantity}), 0)::int` })
      .from(wholesalerOrders)
      .where(eq(wholesalerOrders.wholesalerItemId, itemId));
    if (ordered + qty > item.cap) {
      res.status(409).json({ error: `Wholesaler cap reached (${ordered}/${item.cap}). Remaining: ${item.cap - ordered}.` });
      return;
    }
  }
  // Authorize fixer on the venue: owner OR character-employee. ADMIN bypass too.
  let venueName = "";
  let venueOwnerId = "";
  if (kind === "store") {
    const [v] = await db.select().from(stores).where(eq(stores.id, venueId));
    if (!v) {
      res.status(404).json({ error: "Store not found" });
      return;
    }
    venueName = v.name;
    venueOwnerId = v.ownerId;
    let ok = v.ownerId === req.user!.id || hasRole(req.user!.roles, "ADMIN");
    if (!ok) {
      const employed = await db
        .select()
        .from(storeEmployees)
        .innerJoin(characters, eq(characters.id, storeEmployees.characterId))
        .where(and(eq(storeEmployees.storeId, venueId), eq(characters.ownerId, req.user!.id)));
      ok = employed.length > 0;
    }
    if (!ok) {
      res.status(403).json({ error: "Not authorized to restock this store" });
      return;
    }
  } else {
    const [v] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, venueId));
    if (!v) {
      res.status(404).json({ error: "Clinic not found" });
      return;
    }
    venueName = v.name;
    venueOwnerId = v.ownerId;
    let ok = v.ownerId === req.user!.id || hasRole(req.user!.roles, "ADMIN");
    if (!ok) {
      const employed = await db
        .select()
        .from(ripperdocEmployees)
        .innerJoin(characters, eq(characters.id, ripperdocEmployees.characterId))
        .where(and(eq(ripperdocEmployees.ripperdocId, venueId), eq(characters.ownerId, req.user!.id)));
      ok = employed.length > 0;
    }
    if (!ok) {
      res.status(403).json({ error: "Not authorized to restock this clinic" });
      return;
    }
  }
  const totalCost = item.wholesalePrice * qty;
  // Debit the fixer's wallet via UB (stores have no balance concept).
  const bal = await getBalance(req.user!.discordId);
  if (!bal) {
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  if (bal.cash < totalCost) {
    res.status(400).json({ error: "Insufficient funds to cover wholesale order" });
    return;
  }
  const debited = await patchBalance(req.user!.discordId, {
    cash: -totalCost,
    reason: `Wholesaler restock: ${item.name} x${qty} → ${venueName}`,
  });
  if (!debited) {
    res.status(502).json({ error: "Wallet provider rejected debit" });
    return;
  }
  // Push units into venue stock. Merge into an existing same-name row when
  // present so the store doesn't accumulate duplicate stock lines.
  const stockTable = kind === "store" ? storeStock : ripperdocStock;
  const venueCol = kind === "store" ? storeStock.storeId : ripperdocStock.ripperdocId;
  const existing = await db
    .select()
    .from(stockTable)
    .where(and(eq(venueCol, venueId), eq(stockTable.name, item.name)));
  let stockRow;
  try {
    if (existing.length > 0) {
      const cur = existing[0];
      const [updated] = await db
        .update(stockTable)
        .set({ quantity: cur.quantity + qty })
        .where(eq(stockTable.id, cur.id))
        .returning();
      stockRow = updated;
    } else {
      const retailPrice = item.suggestedRetailPrice ?? item.wholesalePrice * 2;
      const [inserted] = await db
        .insert(stockTable)
        .values({
          ...(kind === "store" ? { storeId: venueId } : { ripperdocId: venueId }),
          name: item.name,
          category: item.category ?? (kind === "ripperdoc" ? "cyberware" : null),
          price: retailPrice,
          quantity: qty,
          notes: item.notes ?? null,
        } as never)
        .returning();
      stockRow = inserted;
    }
  } catch (err) {
    logger.error({ err, itemId, venueId, qty }, "wholesaler restock stock insert failed after wallet debit");
    // Refund the fixer; abandon the order. If the refund itself fails the
    // fixer has been debited with no stock and no record — log loudly so an
    // operator can reconcile and tell the caller the truth.
    const refund = await patchBalance(req.user!.discordId, {
      cash: totalCost,
      reason: `Refund: wholesaler restock failed for ${item.name}`,
    });
    if (!refund) {
      logger.error(
        { fixerDiscordId: req.user!.discordId, itemId, venueId, qty, totalCost },
        "WHOLESALE_REFUND_FAILED: fixer debited but stock write AND refund failed — manual reconciliation required",
      );
      res.status(500).json({ error: "Stock write failed and refund failed; contact staff for reconciliation." });
      return;
    }
    res.status(500).json({ error: "Stock write failed after wallet debit; refunded." });
    return;
  }
  await db.insert(wholesalerOrders).values({
    wholesalerItemId: itemId,
    fixerId: req.user!.id,
    storeId: kind === "store" ? venueId : null,
    ripperdocId: kind === "ripperdoc" ? venueId : null,
    quantity: qty,
    unitWholesalePrice: item.wholesalePrice,
    totalCost,
  });
  await db.insert(walletTransactions).values({
    userId: req.user!.id,
    counterpartyName: `Wholesaler → ${venueName}`,
    amount: -totalCost,
    kind: "shop",
    memo: `Wholesale: ${item.name} x${qty}`,
  });
  await db.insert(activityEvents).values({
    kind: "wholesaler_restock",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${req.user!.username} restocked ${venueName} with ${item.name} x${qty} (€$${totalCost})`,
  });
  res.json({
    stock: stockRow,
    totalCost,
    venueOwnerId,
  });
});

// ===== Restock history for a venue (visible to authorized staff) =====
router.get("/wholesaler/orders", requireAuth, async (req, res): Promise<void> => {
  const kind = String(req.query.kind ?? "store") === "ripperdoc" ? "ripperdoc" : "store";
  const venueId = parseInt(String(req.query.venueId ?? ""), 10);
  if (!venueId) {
    res.status(400).json({ error: "venueId required" });
    return;
  }
  // Authz: owner / employee / admin.
  let authorized = hasRole(req.user!.roles, "ADMIN");
  if (kind === "store") {
    const [v] = await db.select().from(stores).where(eq(stores.id, venueId));
    if (!v) {
      res.status(404).json({ error: "Store not found" });
      return;
    }
    if (!authorized && v.ownerId === req.user!.id) authorized = true;
    if (!authorized) {
      const e = await db
        .select()
        .from(storeEmployees)
        .innerJoin(characters, eq(characters.id, storeEmployees.characterId))
        .where(and(eq(storeEmployees.storeId, venueId), eq(characters.ownerId, req.user!.id)));
      authorized = e.length > 0;
    }
  } else {
    const [v] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, venueId));
    if (!v) {
      res.status(404).json({ error: "Clinic not found" });
      return;
    }
    if (!authorized && v.ownerId === req.user!.id) authorized = true;
    if (!authorized) {
      const e = await db
        .select()
        .from(ripperdocEmployees)
        .innerJoin(characters, eq(characters.id, ripperdocEmployees.characterId))
        .where(and(eq(ripperdocEmployees.ripperdocId, venueId), eq(characters.ownerId, req.user!.id)));
      authorized = e.length > 0;
    }
  }
  if (!authorized) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const col = kind === "store" ? wholesalerOrders.storeId : wholesalerOrders.ripperdocId;
  const rows = await db
    .select({
      id: wholesalerOrders.id,
      wholesalerItemId: wholesalerOrders.wholesalerItemId,
      itemName: wholesalerItems.name,
      fixerId: wholesalerOrders.fixerId,
      fixerName: users.username,
      quantity: wholesalerOrders.quantity,
      unitWholesalePrice: wholesalerOrders.unitWholesalePrice,
      totalCost: wholesalerOrders.totalCost,
      createdAt: wholesalerOrders.createdAt,
    })
    .from(wholesalerOrders)
    .leftJoin(wholesalerItems, eq(wholesalerItems.id, wholesalerOrders.wholesalerItemId))
    .leftJoin(users, eq(users.id, wholesalerOrders.fixerId))
    .where(eq(col, venueId))
    .orderBy(desc(wholesalerOrders.createdAt))
    .limit(100);
  res.json(rows);
});

export default router;
