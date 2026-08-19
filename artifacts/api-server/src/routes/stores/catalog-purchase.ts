import type { IRouter } from "express";
import type { Request, Response } from "express";
import { eq, and, sql, gte } from "drizzle-orm";
import {
  db,
  stores,
  storeStock,
  ripperdocs,
  ripperdocStock,
  characters,
  walletTransactions,
  activityEvents,
  auditLog,
  users,
  catalogGuns,
  catalogCyberware,
  customRequests,
} from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { hasRole, sendDirectMessage } from "../../lib/discord";
import { logger } from "../../lib/logger";
import { auditMeta, isVenueOperator } from "./venue-shared";

// Fixer/admin stocked a venue at a CUSTOM cost (> 0). Rather than debiting the
// owner's venue balance without consent, route a cost-approval to the owner: a
// `stock_cost` custom_request that shows up in the owner's "My Submissions". On
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
  // Gun-only attributes mirrored from catalog_guns (store kind only) so the
  // approval path can stamp them onto the stock row it creates.
  powerLevel?: string | null;
  cyberwareReq?: string | null;
  actor: { id: string; username: string; avatarUrl: string | null };
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { kind, venue, catalogId, name, category, qty, unitCost, totalCost, retail, powerLevel, cyberwareReq, actor } = opts;
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
        powerLevel: powerLevel ?? null,
        cyberwareReq: cyberwareReq ?? null,
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
        `${actor.username} proposed stocking your ${venueLabel} "${venue.name}" with ${name} ×${qty} at €$${unitCost.toLocaleString()} each (total €$${totalCost.toLocaleString()}). Review it under "My Submissions" to approve or reject.`,
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
// retail) or inserted. The sale price defaults to 0 (the owner sets their own
// markup); the shop cost is seeded from the wholesale price the venue paid.
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
  // Gun-only attributes mirrored from catalog_guns onto store stock so the
  // shelf row carries them without manual staff entry (ripperdoc stock has no
  // such columns).
  let powerLevel: string | null = null;
  let cyberwareReq: string | null = null;
  if (kind === "store") {
    const [g] = await db.select().from(catalogGuns).where(eq(catalogGuns.id, catalogId));
    if (!g) {
      res.status(404).json({ error: "Catalog item not found" });
      return;
    }
    name = g.name;
    category = g.category ?? g.weaponType ?? null;
    catalogPrice = g.price;
    powerLevel = g.powerLevel ?? null;
    cyberwareReq = g.cyberwareReq ?? null;
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
  // Sale price defaults to 0 so the owner sets their own markup; the shop cost is
  // seeded from the wholesale price the venue just paid (unitCost) in the insert
  // branch below. On restock (existing row) a blank sale price keeps the current
  // shelf price rather than zeroing it.
  const retailProvided = retailPrice !== undefined && Number.isFinite(Number(retailPrice));
  const retail = retailProvided ? Math.max(0, Math.round(Number(retailPrice))) : 0;

  // Fixer/admin set a CUSTOM cost (> 0): don't debit now. Route a cost-approval
  // to the venue owner; the stock is added atomically when they approve it
  // from "My Submissions" (see requests.ts POST /requests/:id/stock-decision).
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
      powerLevel,
      cyberwareReq,
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
      // Restock of an existing row keeps its established shop cost as-is — the
      // purchase-price default only seeds the cost of a brand-new stock row (see
      // the insert branch). Overwriting here would clobber an intentional cost
      // (including a deliberate 0).
      const [u] = await tx
        .update(stockTable)
        .set({
          quantity: existing.quantity + qty,
          price: retailProvided ? retail : existing.price,
          category: existing.category ?? category,
          // Backfill gun attributes on rows that predate the catalog mirroring
          // (never overwrite a value staff already set).
          ...(kind === "store"
            ? {
                powerLevel: (existing as typeof storeStock.$inferSelect).powerLevel ?? powerLevel,
                cyberwareReq: (existing as typeof storeStock.$inferSelect).cyberwareReq ?? cyberwareReq,
              }
            : {}),
        })
        .where(eq(stockTable.id, existing.id))
        .returning();
      stockRow = u;
    } else {
      const [ins] = await tx
        .insert(stockTable)
        // Default the shop cost to the per-unit price the venue just paid, so
        // commission (price − cost) is correct out of the box without a manual
        // cost entry. Staff overrides flow through unitCost above.
        .values({
          [kind === "store" ? "storeId" : "ripperdocId"]: venueId,
          name,
          category,
          price: retail,
          quantity: qty,
          cost: unitCost,
          ...(kind === "store" ? { powerLevel, cyberwareReq } : {}),
        } as never)
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

export function registerCatalogPurchase(router: IRouter): void {
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
}
