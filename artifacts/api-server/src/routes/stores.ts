import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
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
  users,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole } from "../lib/discord";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { logger } from "../lib/logger";
import { recordInventoryEvent } from "../lib/inventoryEvents";

const router: IRouter = Router();

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
  const isAdmin = hasRole(req.user!.roles, "ADMIN");
  const isEmployee = emps.some((e) => e.ownerId === req.user!.id);
  if (!isOwner && !isAdmin && !isEmployee) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const stock = await db.select().from(storeStock).where(eq(storeStock.storeId, id));
  res.json({ ...s, employees: emps.map(({ ownerId: _o, ...e }) => e), stock });
});

router.patch("/stores/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [s] = await db.select().from(stores).where(and(eq(stores.id, id), eq(stores.ownerId, req.user!.id)));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, kind, location, description, bannerUrl, ownerCharacterId } = req.body ?? {};
  const [u] = await db
    .update(stores)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(bannerUrl !== undefined ? { bannerUrl } : {}),
      ...(ownerCharacterId !== undefined ? { ownerCharacterId } : {}),
    })
    .where(eq(stores.id, id))
    .returning();
  res.json(u);
});

router.post("/stores/:id/employees", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [s] = await db.select().from(stores).where(and(eq(stores.id, id), eq(stores.ownerId, req.user!.id)));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { characterId, role } = req.body ?? {};
  if (!characterId) {
    res.status(400).json({ error: "characterId required" });
    return;
  }
  const [e] = await db.insert(storeEmployees).values({ storeId: id, characterId, role: role ?? "clerk" }).returning();
  res.status(201).json(e);
});

router.delete("/stores/:id/employees/:employeeId", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const empId = parseInt(String(req.params.employeeId), 10);
  const [s] = await db.select().from(stores).where(and(eq(stores.id, id), eq(stores.ownerId, req.user!.id)));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(storeEmployees).where(and(eq(storeEmployees.id, empId), eq(storeEmployees.storeId, id)));
  res.sendStatus(204);
});

router.post("/stores/:id/stock", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [s] = await db.select().from(stores).where(and(eq(stores.id, id), eq(stores.ownerId, req.user!.id)));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, category, price, quantity, notes } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const [it] = await db
    .insert(storeStock)
    .values({ storeId: id, name, category: category ?? null, price: price ?? 0, quantity: quantity ?? 0, notes: notes ?? null })
    .returning();
  res.status(201).json(it);
});

router.patch("/stores/:id/stock/:stockId", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const stockId = parseInt(String(req.params.stockId), 10);
  const [s] = await db.select().from(stores).where(and(eq(stores.id, id), eq(stores.ownerId, req.user!.id)));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
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
    .where(and(eq(storeStock.id, stockId), eq(storeStock.storeId, id)))
    .returning();
  if (!u) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(u);
});

router.delete("/stores/:id/stock/:stockId", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const stockId = parseInt(String(req.params.stockId), 10);
  const [s] = await db.select().from(stores).where(and(eq(stores.id, id), eq(stores.ownerId, req.user!.id)));
  if (!s) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(storeStock).where(and(eq(storeStock.id, stockId), eq(storeStock.storeId, id)));
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
  const isAdmin = hasRole(req.user!.roles, "ADMIN");
  const isEmployee = emps.some((e) => e.ownerId === req.user!.id);
  if (!isOwner && !isAdmin && !isEmployee) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const stock = await db.select().from(ripperdocStock).where(eq(ripperdocStock.ripperdocId, id));
  res.json({ ...r, employees: emps.map(({ ownerId: _o, ...e }) => e), stock });
});

router.patch("/ripperdocs/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [r] = await db.select().from(ripperdocs).where(and(eq(ripperdocs.id, id), eq(ripperdocs.ownerId, req.user!.id)));
  if (!r) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, location, description, bannerUrl, ownerCharacterId } = req.body ?? {};
  const [u] = await db
    .update(ripperdocs)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(bannerUrl !== undefined ? { bannerUrl } : {}),
      ...(ownerCharacterId !== undefined ? { ownerCharacterId } : {}),
    })
    .where(eq(ripperdocs.id, id))
    .returning();
  res.json(u);
});

router.post("/ripperdocs/:id/employees", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [r] = await db.select().from(ripperdocs).where(and(eq(ripperdocs.id, id), eq(ripperdocs.ownerId, req.user!.id)));
  if (!r) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { characterId, role } = req.body ?? {};
  const [e] = await db.insert(ripperdocEmployees).values({ ripperdocId: id, characterId, role: role ?? "doc" }).returning();
  res.status(201).json(e);
});

router.delete("/ripperdocs/:id/employees/:employeeId", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const empId = parseInt(String(req.params.employeeId), 10);
  const [r] = await db.select().from(ripperdocs).where(and(eq(ripperdocs.id, id), eq(ripperdocs.ownerId, req.user!.id)));
  if (!r) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(ripperdocEmployees).where(and(eq(ripperdocEmployees.id, empId), eq(ripperdocEmployees.ripperdocId, id)));
  res.sendStatus(204);
});

router.post("/ripperdocs/:id/stock", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [r] = await db.select().from(ripperdocs).where(and(eq(ripperdocs.id, id), eq(ripperdocs.ownerId, req.user!.id)));
  if (!r) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, category, price, quantity, notes } = req.body ?? {};
  const [it] = await db
    .insert(ripperdocStock)
    .values({ ripperdocId: id, name, category: category ?? null, price: price ?? 0, quantity: quantity ?? 0, notes: notes ?? null })
    .returning();
  res.status(201).json(it);
});

router.delete("/ripperdocs/:id/stock/:stockId", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const stockId = parseInt(String(req.params.stockId), 10);
  const [r] = await db.select().from(ripperdocs).where(and(eq(ripperdocs.id, id), eq(ripperdocs.ownerId, req.user!.id)));
  if (!r) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(ripperdocStock).where(and(eq(ripperdocStock.id, stockId), eq(ripperdocStock.ripperdocId, id)));
  res.sendStatus(204);
});

export default router;
