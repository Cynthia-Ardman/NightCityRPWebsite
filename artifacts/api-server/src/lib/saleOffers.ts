import { and, eq, gte, sql } from "drizzle-orm";
import {
  db,
  stores,
  ripperdocs,
  storeStock,
  ripperdocStock,
  storeEmployees,
  ripperdocEmployees,
  saleOffers,
  characters,
  users,
  inventoryItems,
  catalogCyberware,
  walletTransactions,
  activityEvents,
  auditLog,
  type SaleOffer,
} from "@workspace/db";
import { applyWalletDelta, getEconomyMode } from "./economy";
import { hasRole, sendDirectMessage } from "./discord";
import { recordInventoryEvent } from "./inventoryEvents";
import { cwpForItem, parseCwp, sumCwpByCharacter } from "./cyberware";
import { buildCyberwareCostMap, checkCwpCapacity } from "./cyberware-cap";
import { logger } from "./logger";

// Offer kinds beyond a plain sale. `sale` is the historic default.
export type OfferType = "sale" | "install" | "remove" | "give";

// ---------------------------------------------------------------------------
// Buyer-approval sale offers. The store/ripperdoc operator creates an offer;
// nothing moves until the BUYER approves. Approve runs a crash-safe sequence:
//   1. Debit buyer wallet via applyWalletDelta (idempotent, reserve-before-call).
//   2. One DB tx: flip pending->approved (guarded), guarded stock decrement,
//      credit the venue account, insert buyer inventory, write the venue ledger.
//      A stock-guard miss rolls the tx back and refunds the buyer.
//   3. Commission (employee seller, pct>0): reserve the venue side once
//      (commissionSettledAt guard + venue debit), then credit the employee
//      (idempotent). A credit failure HOLDS the reservation — money is conserved
//      (venue debited, employee unpaid) and a later approve deterministically
//      retries the credit (see settleCommission / recoverApprovedOffer).
// Deny/expiry are pure status flips — no money or stock moves.
// ---------------------------------------------------------------------------

export type OfferKind = "store" | "ripperdoc";
const OFFER_TTL_DAYS = 7;

export interface OfferResult {
  status: number;
  body: unknown;
}

interface Actor {
  id: string;
  roles: string[];
  username: string;
  avatarUrl: string | null;
}

function venueTableFor(kind: OfferKind) {
  return kind === "store" ? stores : ripperdocs;
}
function stockTableFor(kind: OfferKind) {
  return kind === "store" ? storeStock : ripperdocStock;
}
function stockVenueColFor(kind: OfferKind) {
  return kind === "store" ? storeStock.storeId : ripperdocStock.ripperdocId;
}
function empTableFor(kind: OfferKind) {
  return kind === "store" ? storeEmployees : ripperdocEmployees;
}
function empVenueColFor(kind: OfferKind) {
  return kind === "store" ? storeEmployees.storeId : ripperdocEmployees.ripperdocId;
}
function venueColName(kind: OfferKind): "storeId" | "ripperdocId" {
  return kind === "store" ? "storeId" : "ripperdocId";
}

// Owner, admin, or an employee linked via one of the actor's characters.
async function isOperator(kind: OfferKind, venue: { ownerId: string }, venueId: number, actor: Actor): Promise<boolean> {
  if (venue.ownerId === actor.id || hasRole(actor.roles, "ADMIN")) return true;
  const empTable = empTableFor(kind);
  const rows = await db
    .select({ id: empTable.id })
    .from(empTable)
    .innerJoin(characters, eq(characters.id, empTable.characterId))
    .where(and(eq(empVenueColFor(kind), venueId), eq(characters.ownerId, actor.id)));
  return rows.length > 0;
}

// Determine the selling employee (for commission) when the actor is not the
// owner. Owners earn through the store account, not commission, so they get a
// null employee + 0%.
async function resolveSeller(
  kind: OfferKind,
  venue: { ownerId: string },
  venueId: number,
  actor: Actor,
): Promise<{ sellerCharacterId: number | null; sellerEmployeeId: number | null; commissionPct: number }> {
  if (venue.ownerId === actor.id) return { sellerCharacterId: null, sellerEmployeeId: null, commissionPct: 0 };
  const empTable = empTableFor(kind);
  const [emp] = await db
    .select({ empId: empTable.id, charId: empTable.characterId, pct: empTable.commissionPct })
    .from(empTable)
    .innerJoin(characters, eq(characters.id, empTable.characterId))
    .where(and(eq(empVenueColFor(kind), venueId), eq(characters.ownerId, actor.id)))
    .limit(1);
  if (!emp) return { sellerCharacterId: null, sellerEmployeeId: null, commissionPct: 0 };
  return { sellerCharacterId: emp.charId, sellerEmployeeId: emp.empId, commissionPct: emp.pct };
}

// Build the absolute portal URL for an offer's approval page. Mirrors sheets.ts.
function offerLink(): string {
  const portalBase = (process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "").replace(/^https?:\/\//, "");
  return portalBase ? `https://${portalBase}/offers/mine` : `/offers/mine`;
}

// Best-effort buyer notification (Discord DM). The in-portal surface is
// GET /offers/mine; this just nudges the buyer. Never throws.
async function notifyBuyerOfOffer(offer: SaleOffer, venueName: string): Promise<void> {
  try {
    const [u] = await db.select({ discordId: users.discordId }).from(users).where(eq(users.id, offer.buyerUserId));
    if (!u?.discordId) return;
    const content =
      `**${venueName}** sent you a purchase offer: **${offer.itemName}** x${offer.quantity} for €$${offer.totalPrice}.\n` +
      `Approve or deny it here: ${offerLink()}`;
    await sendDirectMessage(u.discordId, content);
  } catch (err) {
    logger.warn({ err, offerId: offer.id }, "offer buyer DM failed");
  }
}

// Per-unit CWP a stock item costs to install. The catalog is authoritative when
// it carries a positive value for the item (so an operator can't under-report a
// known piece); otherwise an explicit operator-supplied value wins, then any
// "CWP n" tag already on the stock notes, then 0 (custom/unknown chrome).
async function resolveInstallCwp(
  name: string,
  stockNotes: string | null,
  operatorCwp: number | null | undefined,
): Promise<number> {
  const catRows = await db.select({ name: catalogCyberware.name, cwp: catalogCyberware.cwp }).from(catalogCyberware);
  const catalogCost = buildCyberwareCostMap(catRows).get(name.trim().toLowerCase());
  if (catalogCost !== undefined && catalogCost > 0) return catalogCost;
  // No authoritative catalog value. A "CWP n" tag on the stock is a floor the
  // operator cannot undercut (so a crafted low override can't dodge the cap);
  // an operator value above it (or for custom chrome with no tag) still applies.
  const noteCwp = parseCwp(stockNotes) ?? 0;
  const opCwp = operatorCwp != null && Number.isFinite(operatorCwp) ? Math.max(0, operatorCwp) : 0;
  return Math.max(noteCwp, opCwp);
}

// Creates a stock-backed offer: a plain sale (default), a free give (price 0),
// or a cyberware install (stamps per-unit CWP + validates the PC capacity cap).
export async function createOffer(opts: {
  kind: OfferKind;
  venueId: number;
  stockId: number;
  buyerCharacterId: number;
  qty: number;
  memo?: string | null;
  offerType?: OfferType;
  priceOverride?: number | null;
  cwp?: number | null;
  actor: Actor;
}): Promise<OfferResult> {
  const { kind, venueId, stockId, buyerCharacterId, qty, memo, priceOverride, actor } = opts;
  const offerType: OfferType = opts.offerType ?? "sale";
  if (offerType === "remove") return { status: 400, body: { error: "Use createRemoveOffer for removals" } };
  if ((offerType === "install" || offerType === "give") && kind !== "ripperdoc") {
    return { status: 400, body: { error: "Install/give are only available at ripperdoc clinics" } };
  }
  const venueTable = venueTableFor(kind);
  const stockTable = stockTableFor(kind);

  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) return { status: 404, body: { error: "Venue not found" } };
  if (!(await isOperator(kind, venue, venueId, actor))) {
    return { status: 403, body: { error: "Not authorized to sell from this venue" } };
  }
  const [item] = await db
    .select()
    .from(stockTable)
    .where(and(eq(stockTable.id, stockId), eq(stockVenueColFor(kind), venueId)));
  if (!item) return { status: 404, body: { error: "Stock item not found" } };
  if (qty > item.quantity) return { status: 409, body: { error: "Insufficient stock" } };

  const [buyer] = await db.select().from(characters).where(eq(characters.id, buyerCharacterId));
  if (!buyer) return { status: 404, body: { error: "Buyer character not found" } };
  if (buyer.archived) return { status: 400, body: { error: "Buyer character is archived" } };
  if (!buyer.ownerId) return { status: 409, body: { error: "Buyer character is unclaimed" } };

  // Install: resolve per-unit CWP and validate the buyer's capacity up front
  // (re-validated again at approval, since other chrome may land in between).
  let cwp: number | null = null;
  if (offerType === "install") {
    cwp = await resolveInstallCwp(item.name, (item as { notes?: string | null }).notes ?? null, opts.cwp);
    const used = (await sumCwpByCharacter([buyer.id])).get(buyer.id) ?? 0;
    const cap = checkCwpCapacity({ kind: buyer.kind, used, add: cwp * qty });
    if (!cap.ok) return { status: 409, body: { error: cap.reason } };
  }

  const seller = await resolveSeller(kind, venue, venueId, actor);
  const unitPrice = offerType === "give" ? 0 : priceOverride != null ? Math.max(0, priceOverride) : item.price;
  const totalPrice = unitPrice * qty;
  const expiresAt = new Date(Date.now() + OFFER_TTL_DAYS * 24 * 60 * 60 * 1000);

  const verb = offerType === "install" ? "install" : offerType === "give" ? "give" : "sell";
  const priceLabel = totalPrice > 0 ? `for €$${totalPrice}` : "for free";

  const [offer] = await db
    .insert(saleOffers)
    .values({
      kind,
      offerType,
      [venueColName(kind)]: venueId,
      stockId,
      cwp,
      itemName: item.name,
      itemCategory: item.category ?? (kind === "ripperdoc" ? "cyberware" : null),
      unitPrice,
      quantity: qty,
      totalPrice,
      buyerCharacterId: buyer.id,
      buyerUserId: buyer.ownerId,
      sellerCharacterId: seller.sellerCharacterId,
      sellerEmployeeId: seller.sellerEmployeeId,
      commissionPct: seller.commissionPct,
      createdById: actor.id,
      memo: memo ?? null,
      status: "pending",
      expiresAt,
    } as never)
    .returning();

  await db.insert(activityEvents).values({
    kind: "shop",
    actorId: actor.id,
    actorName: actor.username,
    actorAvatarUrl: actor.avatarUrl,
    message: `${venue.name} offered to ${verb} ${item.name} x${qty} to ${buyer.name} ${priceLabel}`,
  });
  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_create",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Offered to ${verb} ${item.name} x${qty} to ${buyer.name} ${priceLabel}`,
    afterJson: { offerType, totalPrice, quantity: qty, cwp, commissionPct: seller.commissionPct, buyerCharacterId: buyer.id } as never,
  });
  await notifyBuyerOfOffer(offer, venue.name);

  return { status: 201, body: offer };
}

// Creates an inventory-backed offer: un-install an existing chrome item from the
// buyer character (default destination — the item stays in the player's
// inventory, just no longer counted toward CWP). An optional removal fee flows
// through the same buyer-approval + commission path as a sale.
export async function createRemoveOffer(opts: {
  venueId: number;
  removedItemId: number;
  buyerCharacterId: number;
  fee?: number | null;
  memo?: string | null;
  actor: Actor;
}): Promise<OfferResult> {
  const kind: OfferKind = "ripperdoc";
  const { venueId, removedItemId, buyerCharacterId, memo, actor } = opts;

  const [venue] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, venueId));
  if (!venue) return { status: 404, body: { error: "Venue not found" } };
  if (!(await isOperator(kind, venue, venueId, actor))) {
    return { status: 403, body: { error: "Not authorized to operate this clinic" } };
  }

  const [buyer] = await db.select().from(characters).where(eq(characters.id, buyerCharacterId));
  if (!buyer) return { status: 404, body: { error: "Character not found" } };
  if (buyer.archived) return { status: 400, body: { error: "Character is archived" } };
  if (!buyer.ownerId) return { status: 409, body: { error: "Character is unclaimed" } };

  const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, removedItemId));
  if (!item || item.characterId !== buyer.id) {
    return { status: 404, body: { error: "Cyberware not found on this character" } };
  }
  if (item.category !== "cyberware") {
    return { status: 400, body: { error: "That item is not installed cyberware" } };
  }

  const fee = Math.max(0, opts.fee ?? 0);
  const cwp = cwpForItem(item);
  const seller = await resolveSeller(kind, venue, venueId, actor);
  const expiresAt = new Date(Date.now() + OFFER_TTL_DAYS * 24 * 60 * 60 * 1000);
  const priceLabel = fee > 0 ? `for €$${fee}` : "for free";

  const [offer] = await db
    .insert(saleOffers)
    .values({
      kind,
      offerType: "remove",
      [venueColName(kind)]: venueId,
      stockId: null,
      removedItemId,
      cwp,
      itemName: item.name,
      itemCategory: "cyberware",
      unitPrice: fee,
      quantity: 1,
      totalPrice: fee,
      buyerCharacterId: buyer.id,
      buyerUserId: buyer.ownerId,
      sellerCharacterId: seller.sellerCharacterId,
      sellerEmployeeId: seller.sellerEmployeeId,
      commissionPct: seller.commissionPct,
      createdById: actor.id,
      memo: memo ?? null,
      status: "pending",
      expiresAt,
    } as never)
    .returning();

  await db.insert(activityEvents).values({
    kind: "shop",
    actorId: actor.id,
    actorName: actor.username,
    actorAvatarUrl: actor.avatarUrl,
    message: `${venue.name} offered to remove ${item.name} from ${buyer.name} ${priceLabel}`,
  });
  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_create",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Offered to remove ${item.name} from ${buyer.name} ${priceLabel}`,
    afterJson: { offerType: "remove", fee, cwp, removedItemId, buyerCharacterId: buyer.id } as never,
  });
  await notifyBuyerOfOffer(offer, venue.name);

  return { status: 201, body: offer };
}

// Authorization for approve/deny: the buyer (offer owner) or an admin.
function canDecide(offer: SaleOffer, actor: Actor): boolean {
  return offer.buyerUserId === actor.id || hasRole(actor.roles, "ADMIN");
}

export async function denyOffer(offerId: number, actor: Actor): Promise<OfferResult> {
  const [offer] = await db.select().from(saleOffers).where(eq(saleOffers.id, offerId));
  if (!offer) return { status: 404, body: { error: "Offer not found" } };
  if (!canDecide(offer, actor)) return { status: 403, body: { error: "Forbidden" } };
  // Guarded flip: only a pending offer can be denied. A concurrent approve that
  // committed first leaves status != pending and this returns 409.
  const [denied] = await db
    .update(saleOffers)
    .set({ status: "denied", decidedAt: new Date() })
    .where(and(eq(saleOffers.id, offerId), eq(saleOffers.status, "pending")))
    .returning();
  if (!denied) {
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offerId));
    return { status: 409, body: { error: `Offer already ${fresh?.status ?? "resolved"}` } };
  }
  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_deny",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offerId),
    message: `Denied offer: ${offer.itemName} x${offer.quantity} for €$${offer.totalPrice}`,
  });
  return { status: 200, body: denied };
}

export async function approveOffer(offerId: number, actor: Actor): Promise<OfferResult> {
  const [offer] = await db.select().from(saleOffers).where(eq(saleOffers.id, offerId));
  if (!offer) return { status: 404, body: { error: "Offer not found" } };
  if (!canDecide(offer, actor)) return { status: 403, body: { error: "Forbidden" } };
  // Re-entry for an already-approved offer: the only thing that can remain
  // unfinished is an unpaid commission, so retry that idempotent credit.
  if (offer.status === "approved") {
    return await recoverApprovedOffer(offer, actor);
  }
  if (offer.status !== "pending") {
    return { status: 409, body: { error: `Offer already ${offer.status}` } };
  }
  // Lazy expiry: an expired offer is flipped to 'expired' and never applied.
  if (offer.expiresAt && offer.expiresAt.getTime() < Date.now()) {
    const [expired] = await db
      .update(saleOffers)
      .set({ status: "expired", decidedAt: new Date() })
      .where(and(eq(saleOffers.id, offerId), eq(saleOffers.status, "pending")))
      .returning();
    if (expired) {
      await db.insert(auditLog).values({
        category: "shop",
        action: "sale_offer_expire",
        actorId: actor.id,
        actorName: actor.username,
        targetType: "sale_offer",
        targetId: String(offerId),
        message: `Offer expired: ${offer.itemName} x${offer.quantity} for €$${offer.totalPrice}`,
      });
    }
    return { status: 409, body: { error: "Offer has expired" } };
  }

  const mode = await getEconomyMode();
  if (mode === "disabled") {
    return { status: 409, body: { error: "Economy is disabled; offers cannot be approved right now." } };
  }
  if (mode === "test") {
    // Dry-run: report what would happen, move nothing, leave the offer pending.
    const commissionAmount = Math.floor((offer.totalPrice * offer.commissionPct) / 100);
    return {
      status: 200,
      body: { dryRun: true, offer, wouldDebitBuyer: offer.totalPrice, wouldCreditStore: offer.totalPrice, wouldPayCommission: commissionAmount },
    };
  }

  const kind = offer.kind as OfferKind;
  const offerType: OfferType = (offer.offerType as OfferType) ?? "sale";
  const isRemove = offerType === "remove";
  const hasMoney = offer.totalPrice > 0;
  const venueTable = venueTableFor(kind);
  const stockTable = stockTableFor(kind);
  const venueId = (kind === "store" ? offer.storeId : offer.ripperdocId)!;

  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) return { status: 404, body: { error: "Venue not found" } };
  const [buyer] = await db.select().from(characters).where(eq(characters.id, offer.buyerCharacterId));
  if (!buyer || !buyer.ownerId) return { status: 409, body: { error: "Buyer character is unclaimed" } };
  const [buyerUser] = await db.select().from(users).where(eq(users.id, offer.buyerUserId));
  if (!buyerUser) return { status: 409, body: { error: "Buyer account missing" } };

  // Install: re-validate the PC capacity cap at approval time. Other chrome may
  // have landed since the offer was created, so the up-front check isn't enough.
  if (offerType === "install") {
    const used = (await sumCwpByCharacter([buyer.id])).get(buyer.id) ?? 0;
    const cap = checkCwpCapacity({ kind: buyer.kind, used, add: (offer.cwp ?? 0) * offer.quantity });
    if (!cap.ok) return { status: 409, body: { error: cap.reason } };
  }

  // 1) Reserve-before-call buyer debit (idempotent on retry). Skipped entirely
  // for free offers (give, or a zero-fee removal) — no money moves.
  if (hasMoney) {
    const debitReason =
      offerType === "install" ? `Cyberware install: ${offer.itemName} @ ${venue.name}`
      : offerType === "remove" ? `Cyberware removal: ${offer.itemName} @ ${venue.name}`
      : `Purchase: ${offer.itemName} x${offer.quantity} @ ${venue.name}`;
    const debit = await applyWalletDelta({
      userId: buyerUser.id,
      discordId: buyerUser.discordId,
      amount: -offer.totalPrice,
      source: kind,
      kind: "shop",
      reason: debitReason,
      memo: offer.memo ?? debitReason,
      characterId: buyer.id,
      counterpartyName: venue.name,
      relatedEntityType: "sale_offer",
      relatedEntityId: offer.id,
      storeId: kind === "store" ? venueId : null,
      ripperdocId: kind === "ripperdoc" ? venueId : null,
      idempotencyKey: `offer:${offer.id}:buyer`,
    });
    if (!debit.ok) {
      if (debit.status === "insufficient_funds") return { status: 400, body: { error: "Buyer has insufficient funds" } };
      return { status: 502, body: { error: debit.error ?? "Wallet provider unavailable" } };
    }
  }

  // 2) Atomic completion: flip status, move the item (stock->inventory for
  // sale/install/give, or un-install for remove), credit the venue + write the
  // ledger when there's a fee — all or nothing.
  let insertedItem: typeof inventoryItems.$inferSelect | null = null;
  let removedItem: typeof inventoryItems.$inferSelect | null = null;
  let completionFailReason: string | null = null;
  let alreadyApproved = false;
  let completionError: unknown = null;
  let venueBalanceAfter = venue.balance;
  const today = new Date().toISOString().slice(0, 10);
  await db.transaction(async (tx) => {
    const [flipped] = await tx
      .update(saleOffers)
      .set({ status: "approved", decidedAt: new Date() })
      .where(and(eq(saleOffers.id, offerId), eq(saleOffers.status, "pending")))
      .returning();
    if (!flipped) {
      alreadyApproved = true; // another writer already completed this offer
      return;
    }

    if (offerType === "install") {
      // Race-safe capacity enforcement. The pre-tx check (above) can pass for two
      // concurrent approvals against the same near-cap PC. Take a row lock on the
      // buyer so those approvals serialize, then recompute used CWP *inside* the
      // tx — the second waiter now sees the first's committed install.
      await tx.execute(sql`SELECT id FROM ${characters} WHERE ${eq(characters.id, buyer.id)} FOR UPDATE`);
      const installedRows = await tx
        .select({ name: inventoryItems.name, notes: inventoryItems.notes, quantity: inventoryItems.quantity })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.characterId, buyer.id), eq(inventoryItems.category, "cyberware")));
      const usedNow = installedRows.reduce((sum, r) => sum + cwpForItem(r), 0);
      const capNow = checkCwpCapacity({ kind: buyer.kind, used: usedNow, add: (offer.cwp ?? 0) * offer.quantity });
      if (!capNow.ok) {
        completionFailReason = capNow.reason ?? "Cyberware capacity exceeded";
        throw new Error("capacity-guard-miss"); // rolls back the flip + debit
      }
    }

    if (isRemove) {
      // Un-install: flip the item out of the "cyberware" category so it stops
      // counting toward CWP, but keep it in the player's inventory (the default
      // destination). Guard on the still-installed state for idempotency.
      const [updated] = await tx
        .update(inventoryItems)
        .set({
          category: "cyberware (removed)",
          notes: sql`coalesce(${inventoryItems.notes}, '') || ${` · Removed at ${venue.name} on ${today}`}`,
        })
        .where(and(
          eq(inventoryItems.id, offer.removedItemId!),
          eq(inventoryItems.characterId, buyer.id),
          eq(inventoryItems.category, "cyberware"),
        ))
        .returning();
      if (!updated) {
        completionFailReason = "Cyberware to remove was not found (already removed?)";
        throw new Error("remove-target-miss");
      }
      removedItem = updated;
    } else {
      // Sale / install / give: pull from stock and drop into the buyer's inventory.
      const [decremented] = await tx
        .update(stockTable)
        .set({ quantity: sql`${stockTable.quantity} - ${offer.quantity}` })
        .where(and(eq(stockTable.id, offer.stockId!), gte(stockTable.quantity, offer.quantity)))
        .returning();
      if (!decremented) {
        completionFailReason = "Item is out of stock";
        throw new Error("stock-guard-miss"); // rolls back the flip + everything
      }
      if (decremented.quantity <= 0) {
        await tx.delete(stockTable).where(eq(stockTable.id, decremented.id));
      }
      // Install stamps the CWP tag + a category of "cyberware" so the meds cron
      // and band derivation pick it up. A plain ripperdoc sale/give lands the
      // product in inventory uninstalled (no CWP tag => 0 CWP until installed).
      const installNotes = offerType === "install"
        ? `CWP ${offer.cwp ?? 0} · Installed at ${venue.name} on ${today}`
        : null;
      const category = offerType === "install"
        ? "cyberware"
        : offer.itemCategory ?? (kind === "ripperdoc" ? "cyberware" : null);
      const [item] = await tx
        .insert(inventoryItems)
        .values({
          characterId: buyer.id,
          ownerId: buyer.ownerId,
          name: offer.itemName,
          category,
          quantity: offer.quantity,
          notes: installNotes,
          pricePaid: offer.totalPrice,
          acquiredAt: new Date(),
        })
        .returning();
      insertedItem = item;
    }

    if (hasMoney) {
      const [creditedVenue] = await tx
        .update(venueTable)
        .set({ balance: sql`${venueTable.balance} + ${offer.totalPrice}` })
        .where(eq(venueTable.id, venueId))
        .returning();
      venueBalanceAfter = creditedVenue.balance;
      const ledgerMemo =
        offerType === "install" ? `Installed ${offer.itemName}`
        : offerType === "remove" ? `Removed ${offer.itemName}`
        : `Sold ${offer.itemName} x${offer.quantity}`;
      await tx.insert(walletTransactions).values({
        [venueColName(kind)]: venueId,
        characterId: venue.ownerCharacterId ?? null,
        counterpartyCharacterId: buyer.id,
        counterpartyName: buyer.name,
        amount: offer.totalPrice,
        kind: "shop",
        source: kind,
        memo: ledgerMemo,
        relatedEntityType: "sale_offer",
        relatedEntityId: offer.id,
        previousBalance: venueBalanceAfter - offer.totalPrice,
        newBalance: venueBalanceAfter,
      } as never);
    }
  }).catch((err) => {
    // Capture any failure (guard miss OR unexpected error). The tx is
    // all-or-nothing, so on any throw nothing committed and a buyer debit
    // (if one ran before the tx) must be compensated below.
    completionError = err;
  });

  if (completionError) {
    // The completion tx rolled back entirely. Refund only if money actually moved.
    const reason = completionFailReason ?? "Offer could not be completed";
    if (hasMoney) {
      const refund = await applyWalletDelta({
        userId: buyerUser.id,
        discordId: buyerUser.discordId,
        amount: offer.totalPrice,
        source: kind,
        kind: "shop_refund",
        reason: `Refund: ${reason} @ ${venue.name}`,
        characterId: buyer.id,
        counterpartyName: venue.name,
        relatedEntityType: "sale_offer",
        relatedEntityId: offer.id,
        idempotencyKey: `offer:${offer.id}:buyer-refund`,
        allowNegative: true,
      });
      if (!refund.ok) {
        logger.error(
          { offerId: offer.id, venueId, status: refund.status, err: String(completionError) },
          "OFFER_REFUND_FAILED: completion failed and buyer refund failed; buyer remains debited, manual reconciliation required",
        );
        return { status: 409, body: { error: `${reason}; refund failed — please contact staff.` } };
      }
      return { status: 409, body: { error: `${reason}; buyer was refunded.` } };
    }
    return { status: 409, body: { error: reason } };
  }

  if (alreadyApproved) {
    // Our flip found the offer no longer pending.
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offerId));
    if (fresh?.status === "approved") {
      // A concurrent approve completed it. Any buyer debit shares the same
      // idempotency key, so there was no double-charge — treat as duplicate.
      return { status: 200, body: { offer: fresh, duplicate: true } };
    }
    // The offer was denied/expired between our debit and the flip. Refund if paid.
    if (hasMoney) {
      const refund = await applyWalletDelta({
        userId: buyerUser.id,
        discordId: buyerUser.discordId,
        amount: offer.totalPrice,
        source: kind,
        kind: "shop_refund",
        reason: `Refund: offer ${fresh?.status ?? "resolved"} @ ${venue.name}`,
        characterId: buyer.id,
        counterpartyName: venue.name,
        relatedEntityType: "sale_offer",
        relatedEntityId: offer.id,
        idempotencyKey: `offer:${offer.id}:buyer-refund`,
        allowNegative: true,
      });
      if (!refund.ok) {
        logger.error(
          { offerId: offer.id, venueId, status: refund.status, offerStatus: fresh?.status },
          "OFFER_REFUND_FAILED: buyer debited but offer not approved and refund failed; manual reconciliation required",
        );
        return { status: 409, body: { error: `Offer was ${fresh?.status ?? "resolved"}; refund failed — please contact staff.` } };
      }
      return { status: 409, body: { error: `Offer was already ${fresh?.status ?? "resolved"}; buyer was refunded.` } };
    }
    return { status: 409, body: { error: `Offer was already ${fresh?.status ?? "resolved"}` } };
  }

  // 3) Commission to the selling employee — idempotent and retry-safe. No-ops
  // when there's no fee (give / zero-fee removal => commissionAmount 0).
  const settlement = await settleCommission(offer, { balance: venueBalanceAfter, name: venue.name }, kind, venueId);
  const commissionPaid = settlement.commissionPaid;
  venueBalanceAfter = settlement.venueBalanceAfter;

  // Inventory event + audit (best-effort, decision already committed).
  if (insertedItem) {
    await recordInventoryEvent({
      instanceUuid: (insertedItem as typeof inventoryItems.$inferSelect).instanceUuid,
      kind: "created",
      actorId: actor.id,
      actorName: actor.username,
      toCharacterId: buyer.id,
      toCharacterName: buyer.name,
      itemName: offer.itemName,
      quantity: offer.quantity,
      price: offer.totalPrice,
      reason: offerType === "install" ? `Installed at ${venue.name}` : `Offer approved at ${venue.name}`,
      metadata: { venueKind: kind, venueId, venueName: venue.name, offerId: offer.id, offerType },
    });
  }
  if (removedItem) {
    await recordInventoryEvent({
      instanceUuid: (removedItem as typeof inventoryItems.$inferSelect).instanceUuid,
      kind: "adjusted",
      actorId: actor.id,
      actorName: actor.username,
      fromCharacterId: buyer.id,
      fromCharacterName: buyer.name,
      itemName: offer.itemName,
      quantity: 1,
      price: offer.totalPrice,
      reason: `Cyberware removed at ${venue.name}`,
      metadata: { venueKind: kind, venueId, venueName: venue.name, offerId: offer.id, offerType, cwp: offer.cwp },
    });
  }

  const verbPast =
    offerType === "install" ? "had installed"
    : offerType === "remove" ? "had removed"
    : offerType === "give" ? "received"
    : "bought";
  const priceTail = hasMoney ? `for €$${offer.totalPrice}` : "for free";
  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_approve",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Approved ${offerType} offer: ${offer.itemName} x${offer.quantity} ${priceTail}`,
    afterJson: { offerType, totalPrice: offer.totalPrice, cwp: offer.cwp, commissionPaid, venueBalanceAfter } as never,
  });
  await db.insert(activityEvents).values({
    kind: "transfer",
    actorId: actor.id,
    actorName: actor.username,
    actorAvatarUrl: actor.avatarUrl,
    message: isRemove
      ? `${buyer.name} ${verbPast} ${offer.itemName} at ${venue.name} ${priceTail}`
      : `${buyer.name} ${verbPast} ${offer.itemName} x${offer.quantity} ${offerType === "give" ? "from" : offerType === "install" ? "at" : "from"} ${venue.name} ${priceTail}`,
  });

  const [finalOffer] = await db.select().from(saleOffers).where(eq(saleOffers.id, offerId));
  return { status: 200, body: { offer: finalOffer, inventoryItem: insertedItem, commissionPaid, venueBalance: venueBalanceAfter } };
}

// Idempotent, retry-safe commission settlement for an approved offer.
// Two durable phases:
//   reserve — `commissionSettledAt` set + venue debited + venue ledger row,
//             committed atomically and guarded so it happens at most once.
//   pay     — a *synced* `offer:<id>:commission` wallet row credits the employee.
// "Paid?" is derived from the synced ledger row (durable state), so a crash or
// failure between reserve and pay is fully recoverable: re-running re-attempts
// ONLY the idempotent credit (the reserve guard prevents a second venue debit).
// On a credit failure the reservation is HELD — money is conserved in the venue
// debit, the employee stays unpaid, and a later approve retries the credit.
async function settleCommission(
  offer: SaleOffer,
  venue: { balance: number; name: string },
  kind: OfferKind,
  venueId: number,
): Promise<{ commissionPaid: number; venueBalanceAfter: number }> {
  let venueBalanceAfter = venue.balance;
  if (!offer.sellerEmployeeId || offer.commissionPct <= 0 || !offer.sellerCharacterId) {
    return { commissionPaid: 0, venueBalanceAfter };
  }
  const commissionAmount = Math.floor((offer.totalPrice * offer.commissionPct) / 100);
  if (commissionAmount <= 0) return { commissionPaid: 0, venueBalanceAfter };

  // Already paid? A synced ledger row for this key is the source of truth.
  const [paid] = await db
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.idempotencyKey, `offer:${offer.id}:commission`),
        eq(walletTransactions.syncStatus, "synced"),
      ),
    );
  if (paid) return { commissionPaid: commissionAmount, venueBalanceAfter };

  const [sellerChar] = await db.select().from(characters).where(eq(characters.id, offer.sellerCharacterId));
  const sellerUserId = sellerChar?.ownerId ?? null;
  const [sellerUser] = sellerUserId ? await db.select().from(users).where(eq(users.id, sellerUserId)) : [undefined];
  if (!sellerUser) return { commissionPaid: 0, venueBalanceAfter };

  const venueTable = venueTableFor(kind);
  // Reserve once: settle-once guard + venue debit + ledger, all-or-nothing. If a
  // prior run already reserved (recovery), the guard is a no-op and the venue is
  // NOT debited again — the passed-in `venue.balance` already reflects that debit.
  await db.transaction(async (tx) => {
    const [settled] = await tx
      .update(saleOffers)
      .set({ commissionSettledAt: new Date(), commissionAmount })
      .where(and(eq(saleOffers.id, offer.id), sql`${saleOffers.commissionSettledAt} IS NULL`))
      .returning();
    if (!settled) return;
    const [debited] = await tx
      .update(venueTable)
      .set({ balance: sql`${venueTable.balance} - ${commissionAmount}` })
      .where(eq(venueTable.id, venueId))
      .returning();
    venueBalanceAfter = debited.balance;
    await tx.insert(walletTransactions).values({
      [venueColName(kind)]: venueId,
      characterId: offer.sellerCharacterId,
      counterpartyName: sellerChar?.name ?? "Employee",
      amount: -commissionAmount,
      kind: "commission",
      source: "commission",
      memo: `Commission ${offer.commissionPct}% to ${sellerChar?.name ?? "employee"}`,
      relatedEntityType: "sale_offer",
      relatedEntityId: offer.id,
      previousBalance: debited.balance + commissionAmount,
      newBalance: debited.balance,
    } as never);
  });

  // Credit the employee (idempotent; reuses a prior failed row on retry).
  const credit = await applyWalletDelta({
    userId: sellerUser.id,
    discordId: sellerUser.discordId,
    amount: commissionAmount,
    source: "commission",
    kind: "commission",
    reason: `Commission (${offer.commissionPct}%): ${offer.itemName} @ ${venue.name}`,
    characterId: offer.sellerCharacterId,
    counterpartyName: venue.name,
    relatedEntityType: "sale_offer",
    relatedEntityId: offer.id,
    storeId: kind === "store" ? venueId : null,
    ripperdocId: kind === "ripperdoc" ? venueId : null,
    idempotencyKey: `offer:${offer.id}:commission`,
  });
  if (credit.ok) return { commissionPaid: commissionAmount, venueBalanceAfter };

  logger.error(
    { offerId: offer.id, venueId, commissionAmount, status: credit.status },
    "OFFER_COMMISSION_FAILED: employee credit failed; commission reserved (venue debited) but unpaid — re-approve to retry",
  );
  return { commissionPaid: 0, venueBalanceAfter };
}

// Re-entry point for an already-approved offer. The only thing that can remain
// unfinished after approval is an unpaid commission (the employee credit failed
// or the process crashed between reserve and credit). This deterministically
// retries that idempotent credit; everything else about an approved offer is
// immutable, so it reports "already approved".
async function recoverApprovedOffer(offer: SaleOffer, actor: Actor): Promise<OfferResult> {
  const alreadyApproved: OfferResult = { status: 409, body: { error: "Offer already approved" } };
  if (!offer.sellerEmployeeId || offer.commissionPct <= 0 || !offer.sellerCharacterId) return alreadyApproved;

  // Already paid? A synced ledger row means there is nothing to recover.
  const [paid] = await db
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.idempotencyKey, `offer:${offer.id}:commission`),
        eq(walletTransactions.syncStatus, "synced"),
      ),
    );
  if (paid) return alreadyApproved;

  // Money can only move in live mode.
  if ((await getEconomyMode()) !== "enabled") return alreadyApproved;

  const kind = offer.kind as OfferKind;
  const venueId = (kind === "store" ? offer.storeId : offer.ripperdocId)!;
  const [venue] = await db.select().from(venueTableFor(kind)).where(eq(venueTableFor(kind).id, venueId));
  if (!venue) return { status: 404, body: { error: "Venue not found" } };

  const { commissionPaid, venueBalanceAfter } = await settleCommission(offer, venue, kind, venueId);
  if (commissionPaid <= 0) {
    return { status: 502, body: { error: "Commission payment is still failing; please retry shortly." } };
  }
  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_commission_retry",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Recovered unpaid commission: €$${commissionPaid} for ${offer.itemName} x${offer.quantity}`,
    afterJson: { commissionPaid, venueBalanceAfter } as never,
  });
  const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
  return { status: 200, body: { offer: fresh, recovered: true, commissionPaid, venueBalance: venueBalanceAfter } };
}
