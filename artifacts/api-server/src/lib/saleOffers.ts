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
  walletTransactions,
  activityEvents,
  auditLog,
  type SaleOffer,
} from "@workspace/db";
import { applyWalletDelta, getEconomyMode } from "./economy";
import { hasRole, sendDirectMessage } from "./discord";
import { recordInventoryEvent } from "./inventoryEvents";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Buyer-approval sale offers. The store/ripperdoc operator creates an offer;
// nothing moves until the BUYER approves. Approve runs a crash-safe sequence:
//   1. Debit buyer wallet via applyWalletDelta (idempotent, reserve-before-call).
//   2. One DB tx: flip pending->approved (guarded), guarded stock decrement,
//      credit the venue account, insert buyer inventory, write the venue ledger.
//      A stock-guard miss rolls the tx back and refunds the buyer.
//   3. Commission (employee seller, pct>0): credit the employee wallet
//      (idempotent), then settle the venue side once (commissionSettledAt guard).
//      A commission failure leaves the funds in the venue account (nothing
//      vanishes) and is retry-safe.
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
  return portalBase ? `https://${portalBase}/offers` : `/offers`;
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

export async function createOffer(opts: {
  kind: OfferKind;
  venueId: number;
  stockId: number;
  buyerCharacterId: number;
  qty: number;
  memo?: string | null;
  actor: Actor;
}): Promise<OfferResult> {
  const { kind, venueId, stockId, buyerCharacterId, qty, memo, actor } = opts;
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

  const seller = await resolveSeller(kind, venue, venueId, actor);
  const unitPrice = item.price;
  const totalPrice = unitPrice * qty;
  const expiresAt = new Date(Date.now() + OFFER_TTL_DAYS * 24 * 60 * 60 * 1000);

  const [offer] = await db
    .insert(saleOffers)
    .values({
      kind,
      [venueColName(kind)]: venueId,
      stockId,
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
    message: `${venue.name} offered ${item.name} x${qty} to ${buyer.name} for €$${totalPrice}`,
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
  return { status: 200, body: denied };
}

export async function approveOffer(offerId: number, actor: Actor): Promise<OfferResult> {
  const [offer] = await db.select().from(saleOffers).where(eq(saleOffers.id, offerId));
  if (!offer) return { status: 404, body: { error: "Offer not found" } };
  if (!canDecide(offer, actor)) return { status: 403, body: { error: "Forbidden" } };
  if (offer.status !== "pending") {
    return { status: 409, body: { error: `Offer already ${offer.status}` } };
  }
  // Lazy expiry: an expired offer is flipped to 'expired' and never applied.
  if (offer.expiresAt && offer.expiresAt.getTime() < Date.now()) {
    await db
      .update(saleOffers)
      .set({ status: "expired", decidedAt: new Date() })
      .where(and(eq(saleOffers.id, offerId), eq(saleOffers.status, "pending")));
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
  const venueTable = venueTableFor(kind);
  const stockTable = stockTableFor(kind);
  const venueId = (kind === "store" ? offer.storeId : offer.ripperdocId)!;

  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) return { status: 404, body: { error: "Venue not found" } };
  const [buyer] = await db.select().from(characters).where(eq(characters.id, offer.buyerCharacterId));
  if (!buyer || !buyer.ownerId) return { status: 409, body: { error: "Buyer character is unclaimed" } };
  const [buyerUser] = await db.select().from(users).where(eq(users.id, offer.buyerUserId));
  if (!buyerUser) return { status: 409, body: { error: "Buyer account missing" } };

  // 1) Reserve-before-call buyer debit (idempotent on retry).
  const debit = await applyWalletDelta({
    userId: buyerUser.id,
    discordId: buyerUser.discordId,
    amount: -offer.totalPrice,
    source: kind,
    kind: "shop",
    reason: `Purchase: ${offer.itemName} x${offer.quantity} @ ${venue.name}`,
    memo: offer.memo ?? `Bought ${offer.itemName} x${offer.quantity}`,
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

  // 2) Atomic completion: flip status, decrement stock, credit venue, add
  // inventory, write venue ledger — all or nothing.
  let insertedItem: typeof inventoryItems.$inferSelect | null = null;
  let stockGuardFailed = false;
  let alreadyApproved = false;
  let venueBalanceAfter = venue.balance;
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
    const [decremented] = await tx
      .update(stockTable)
      .set({ quantity: sql`${stockTable.quantity} - ${offer.quantity}` })
      .where(and(eq(stockTable.id, offer.stockId!), gte(stockTable.quantity, offer.quantity)))
      .returning();
    if (!decremented) {
      stockGuardFailed = true;
      throw new Error("stock-guard-miss"); // rolls back the flip + everything
    }
    if (decremented.quantity <= 0) {
      await tx.delete(stockTable).where(eq(stockTable.id, decremented.id));
    }
    const [creditedVenue] = await tx
      .update(venueTable)
      .set({ balance: sql`${venueTable.balance} + ${offer.totalPrice}` })
      .where(eq(venueTable.id, venueId))
      .returning();
    venueBalanceAfter = creditedVenue.balance;
    const [item] = await tx
      .insert(inventoryItems)
      .values({
        characterId: buyer.id,
        ownerId: buyer.ownerId,
        name: offer.itemName,
        category: offer.itemCategory ?? (kind === "ripperdoc" ? "cyberware" : null),
        quantity: offer.quantity,
        pricePaid: offer.totalPrice,
        acquiredAt: new Date(),
      })
      .returning();
    insertedItem = item;
    await tx.insert(walletTransactions).values({
      [venueColName(kind)]: venueId,
      characterId: venue.ownerCharacterId ?? null,
      counterpartyCharacterId: buyer.id,
      counterpartyName: buyer.name,
      amount: offer.totalPrice,
      kind: "shop",
      source: kind,
      memo: `Sold ${offer.itemName} x${offer.quantity}`,
      relatedEntityType: "sale_offer",
      relatedEntityId: offer.id,
      previousBalance: venueBalanceAfter - offer.totalPrice,
      newBalance: venueBalanceAfter,
    } as never);
  }).catch((err) => {
    if (!stockGuardFailed) throw err;
  });

  if (stockGuardFailed) {
    // Buyer was debited but stock vanished — refund and leave the offer pending.
    const refund = await applyWalletDelta({
      userId: buyerUser.id,
      discordId: buyerUser.discordId,
      amount: offer.totalPrice,
      source: kind,
      kind: "shop_refund",
      reason: `Refund: ${offer.itemName} out of stock @ ${venue.name}`,
      characterId: buyer.id,
      counterpartyName: venue.name,
      relatedEntityType: "sale_offer",
      relatedEntityId: offer.id,
      idempotencyKey: `offer:${offer.id}:buyer-refund`,
      allowNegative: true,
    });
    if (!refund.ok) {
      logger.error(
        { offerId: offer.id, venueId, status: refund.status },
        "OFFER_REFUND_FAILED: stock-guard miss but buyer refund failed; buyer remains debited, manual reconciliation required",
      );
      return { status: 409, body: { error: "Item is out of stock; refund failed — please contact staff." } };
    }
    return { status: 409, body: { error: "Item is out of stock; buyer was refunded." } };
  }

  if (alreadyApproved) {
    // Our debit landed, but the guarded flip found the offer no longer pending.
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offerId));
    if (fresh?.status === "approved") {
      // A concurrent approve completed the sale. Our debit shares the same
      // idempotency key, so there was no double-charge — treat as duplicate.
      return { status: 200, body: { offer: fresh, duplicate: true } };
    }
    // The offer was denied/expired between our debit and the flip. Refund.
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

  // 3) Commission to the selling employee (best-effort, retry-safe).
  let commissionPaid = 0;
  if (offer.sellerEmployeeId && offer.commissionPct > 0 && offer.sellerCharacterId) {
    const commissionAmount = Math.floor((offer.totalPrice * offer.commissionPct) / 100);
    if (commissionAmount > 0) {
      const [sellerChar] = await db.select().from(characters).where(eq(characters.id, offer.sellerCharacterId));
      const sellerUserId = sellerChar?.ownerId ?? null;
      const [sellerUser] = sellerUserId ? await db.select().from(users).where(eq(users.id, sellerUserId)) : [undefined];
      if (sellerUser) {
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
        if (credit.ok) {
          // Settle the venue side exactly once (commissionSettledAt guard).
          await db.transaction(async (tx) => {
            const [settled] = await tx
              .update(saleOffers)
              .set({ commissionSettledAt: new Date(), commissionAmount })
              .where(and(eq(saleOffers.id, offerId), sql`${saleOffers.commissionSettledAt} IS NULL`))
              .returning();
            if (!settled) return; // already settled by a concurrent retry
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
          commissionPaid = commissionAmount;
        } else {
          // The sale is done; the venue keeps the funds (nothing vanishes). Loud
          // audit so staff can re-run commission settlement.
          logger.error(
            { offerId: offer.id, venueId, commissionAmount, status: credit.status },
            "OFFER_COMMISSION_FAILED: sale completed but employee commission not paid; venue retains funds, retry required",
          );
        }
      }
    }
  }

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
      reason: `Offer approved at ${venue.name}`,
      metadata: { venueKind: kind, venueId, venueName: venue.name, offerId: offer.id },
    });
  }
  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_approve",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Approved offer: ${offer.itemName} x${offer.quantity} for €$${offer.totalPrice}`,
    afterJson: { totalPrice: offer.totalPrice, commissionPaid, venueBalanceAfter } as never,
  });
  await db.insert(activityEvents).values({
    kind: "transfer",
    actorId: actor.id,
    actorName: actor.username,
    actorAvatarUrl: actor.avatarUrl,
    message: `${buyer.name} bought ${offer.itemName} x${offer.quantity} from ${venue.name} for €$${offer.totalPrice}`,
  });

  const [finalOffer] = await db.select().from(saleOffers).where(eq(saleOffers.id, offerId));
  return { status: 200, body: { offer: finalOffer, inventoryItem: insertedItem, commissionPaid, venueBalance: venueBalanceAfter } };
}
