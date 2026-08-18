import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db,
  stores,
  ripperdocs,
  storeStock,
  ripperdocStock,
  storeEmployees,
  ripperdocEmployees,
  storeShifts,
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
import { installSlotClashError, loadCyberwareSlotByName, resolveSlotForItem } from "./cyberwareSlots";
import { logger } from "./logger";
import { normalizeName } from "./strings";
import { portalLink } from "./portalUrl";
import { createNotification } from "./notifications";
import { hrefInbox } from "./notificationHrefs";

// Offer kinds beyond a plain sale. `sale` is the historic default.
//   stock_add — an admin proposes ADDING a cyberware piece to a venue's stock
//               for a price billed to the VENUE account on approval. The
//               approver is the venue owner (not a buyer); nothing moves until
//               they accept. Money flows OUT of the venue's internal balance,
//               so the whole completion is a single idempotent DB transaction
//               (no external UB wallet leg, unlike a buyer-debited sale).
//   install_owned — ripperdoc only: install a cyberware piece the buyer ALREADY
//               owns (an uninstalled inventory item) onto their character. No
//               stock leg (the player owns the piece); leaves a PENDING offer
//               the player approves from their Inbox; optional install fee via
//               unitPrice. References installItemId.
//   service   — ripperdoc only: a freeform bill for work performed (repair,
//               patch-up, etc). No stock or inventory leg at all — approving
//               just debits the buyer and credits the clinic (commission via
//               the normal path, costBasis null => full amount is profit).
//               Leaves a PENDING offer the player approves from their Inbox.
//   player_sell — reverse direction: a PLAYER offers an item from their
//               character's inventory to the venue. The venue OWNER approves
//               from /inbox; on approval the venue account is debited, the
//               item moves from the player's inventory into venue stock, and
//               the player's wallet is credited. References installItemId
//               (the seller's inventory row) and sellerCharacterId (the
//               selling character); createdById is the selling player and may
//               withdraw (deny) their own pending offer.
export type OfferType = "sale" | "install" | "remove" | "give" | "stock_add" | "install_owned" | "service" | "player_sell";

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

// Employee commission is a percentage of PROFIT (sale price minus the shop's
// acquisition cost), not the full sale price. The shop recovers its cost first;
// the commission comes out of what's left. costBasis is null for service-fee
// offers (removals/owned-installs) where there's no cost to recover, so the
// whole fee is profit. Never negative (selling below cost pays no commission).
function computeCommissionAmount(offer: {
  totalPrice: number;
  costBasis: number | null;
  commissionPct: number;
}): number {
  const profit = Math.max(0, offer.totalPrice - (offer.costBasis ?? 0));
  return Math.floor((profit * offer.commissionPct) / 100);
}

// Build the absolute portal URL for an offer's approval page. Mirrors sheets.ts.
function offerLink(): string {
  return portalLink("/inbox");
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
  const catalogCost = buildCyberwareCostMap(catRows).get(normalizeName(name));
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
    // One-per-capped-slot: reject up front (re-checked again at approval).
    const slotErr = await installSlotClashError({
      buyer,
      item: { name: item.name, notes: (item as { notes?: string | null }).notes ?? null },
      qty,
    });
    if (slotErr) return { status: 409, body: { error: slotErr } };
  }

  const seller = await resolveSeller(kind, venue, venueId, actor);
  const unitPrice = offerType === "give" ? 0 : priceOverride != null ? Math.max(0, priceOverride) : item.price;
  const totalPrice = unitPrice * qty;
  // Snapshot the shop's total acquisition cost so commission is taken from the
  // profit (price - cost) only. Fixed at offer time so a later stock-cost edit
  // can't retroactively change a pending offer's commission.
  const costBasis = Math.max(0, (item as { cost?: number | null }).cost ?? 0) * qty;
  const expiresAt = new Date(Date.now() + OFFER_TTL_DAYS * 24 * 60 * 60 * 1000);

  const verb = offerType === "install" ? "install" : offerType === "give" ? "give" : "sell";
  const priceLabel = totalPrice > 0 ? `for €$${totalPrice}` : "for free";

  // In-portal bell notification to the buyer — additive to any DM the offer
  // flow sends; fire-and-forget so it can never block the sale.
  void createNotification({
    userId: buyer.ownerId,
    type: "sale_offer",
    title: `${offerType === "install" ? "Install offer" : offerType === "give" ? "Item offer" : "Sale offer"}: ${item.name} x${qty} ${priceLabel}`,
    body: `${buyer.name} has a new ${verb} offer.${memo ? ` Memo: ${memo}` : ""}`,
    href: hrefInbox(),
  });

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
      costBasis,
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

  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_create",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Initiated ${verb}: ${item.name} x${qty} to ${buyer.name} ${priceLabel}`,
    afterJson: { offerType, totalPrice, quantity: qty, cwp, commissionPct: seller.commissionPct, buyerCharacterId: buyer.id } as never,
  });

  // Instant venue sale: charge the buyer + move the item right now — no buyer
  // approval step. completeSaleOffer writes its own transfer activity + approve
  // audit and leaves status=approved on success. On any non-success (economy
  // disabled/test, can't afford, wallet error) it must not linger as pending,
  // so delete the row when it's still pending after completion — UNLESS the buyer
  // was debited and could not be refunded (needsReconcile), in which case we keep
  // the row as the recovery handle for manual reconciliation.
  const result = await completeSaleOffer(offer, actor);
  if (!(result.body as { needsReconcile?: boolean })?.needsReconcile) {
    await db.delete(saleOffers).where(and(eq(saleOffers.id, offer.id), eq(saleOffers.status, "pending")));
  }
  return result;
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
  // Where the un-installed chrome ends up: "patient" (default) keeps it in the
  // character's inventory as removed chrome; "clinic" moves it into the
  // clinic's ripperdoc stock (the ripperdoc keeps the part).
  destination?: "patient" | "clinic" | null;
  actor: Actor;
}): Promise<OfferResult> {
  const kind: OfferKind = "ripperdoc";
  const { venueId, removedItemId, buyerCharacterId, memo, actor } = opts;
  const destination = opts.destination === "clinic" ? "clinic" : "patient";

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
  // Only truly-installed chrome (category cyberware + a CWP install tag) is
  // removable. Items sold/given without installing carry no CWP note and must
  // not be removable as if they were installed.
  if (item.category !== "cyberware" || parseCwp(item.notes) == null) {
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
      removeDestination: destination,
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

  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_create",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Initiated removal: ${item.name} from ${buyer.name} ${priceLabel}`,
    afterJson: { offerType: "remove", fee, cwp, removedItemId, destination, buyerCharacterId: buyer.id } as never,
  });

  // Instant removal: uninstall the chrome + charge any fee right now — no buyer
  // approval step. Same dangling-pending cleanup as createOffer, but keep the row
  // when the buyer was debited and could not be refunded (needsReconcile).
  const result = await completeSaleOffer(offer, actor);
  if (!(result.body as { needsReconcile?: boolean })?.needsReconcile) {
    await db.delete(saleOffers).where(and(eq(saleOffers.id, offer.id), eq(saleOffers.status, "pending")));
  }
  return result;
}

// Install a cyberware piece the buyer ALREADY owns (an uninstalled inventory
// item) onto their character. Unlike `install` (stock-backed, instant), there
// is no stock leg and NO auto-completion: the offer is left PENDING for the
// player to approve from their Inbox. An optional install fee flows through the
// same buyer-approval + commission path as a sale (totalPrice 0 => free).
export async function createInstallOwnedOffer(opts: {
  venueId: number;
  installItemId: number;
  buyerCharacterId: number;
  fee?: number | null;
  cwp?: number | null;
  memo?: string | null;
  actor: Actor;
}): Promise<OfferResult> {
  const kind: OfferKind = "ripperdoc";
  const { venueId, installItemId, buyerCharacterId, memo, actor } = opts;

  const [venue] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, venueId));
  if (!venue) return { status: 404, body: { error: "Venue not found" } };
  if (!(await isOperator(kind, venue, venueId, actor))) {
    return { status: 403, body: { error: "Not authorized to operate this clinic" } };
  }

  const [buyer] = await db.select().from(characters).where(eq(characters.id, buyerCharacterId));
  if (!buyer) return { status: 404, body: { error: "Character not found" } };
  if (buyer.archived) return { status: 400, body: { error: "Character is archived" } };
  if (!buyer.ownerId) return { status: 409, body: { error: "Character is unclaimed" } };

  const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, installItemId));
  if (!item || item.characterId !== buyer.id) {
    return { status: 404, body: { error: "Cyberware not found on this character" } };
  }
  // Must be an UNINSTALLED chrome piece the player already owns: category
  // cyberware AND no CWP install tag. Anything already installed (has a CWP
  // note) is rejected — use the remove flow instead.
  if (normalizeName(item.category ?? "") !== "cyberware" || parseCwp(item.notes) != null) {
    return { status: 400, body: { error: "That item is not an uninstalled cyberware piece" } };
  }

  // Per-unit CWP this install will stamp. Catalog is authoritative; an operator
  // override applies only when the catalog has no value (mirrors `install`).
  const cwp = await resolveInstallCwp(item.name, item.notes, opts.cwp);
  const qty = item.quantity ?? 1;
  // Pre-check the buyer's capacity (re-validated again inside the completion tx
  // at approval, since other chrome may land in between).
  const used = (await sumCwpByCharacter([buyer.id])).get(buyer.id) ?? 0;
  const cap = checkCwpCapacity({ kind: buyer.kind, used, add: cwp * qty });
  if (!cap.ok) return { status: 409, body: { error: cap.reason } };
  // One-per-capped-slot: the piece being installed already sits in the buyer's
  // inventory (uninstalled), so exclude it from the clash scan.
  const slotErr = await installSlotClashError({
    buyer,
    item: { name: item.name, notes: item.notes },
    qty,
    excludeItemId: item.id,
  });
  if (slotErr) return { status: 409, body: { error: slotErr } };

  const fee = Math.max(0, opts.fee ?? 0);
  const seller = await resolveSeller(kind, venue, venueId, actor);
  const expiresAt = new Date(Date.now() + OFFER_TTL_DAYS * 24 * 60 * 60 * 1000);
  const priceLabel = fee > 0 ? `for €$${fee}` : "for free";

  const [offer] = await db
    .insert(saleOffers)
    .values({
      kind,
      offerType: "install_owned",
      [venueColName(kind)]: venueId,
      stockId: null,
      installItemId,
      cwp,
      itemName: item.name,
      itemCategory: "cyberware",
      // Flat install fee (not per-unit): totalPrice == unitPrice == fee so the
      // debit/credit/commission legs (which all use totalPrice) stay correct
      // regardless of the item's quantity.
      unitPrice: fee,
      quantity: qty,
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

  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_create",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Initiated install of owned cyberware: ${item.name} onto ${buyer.name} ${priceLabel}`,
    afterJson: { offerType: "install_owned", fee, cwp, installItemId, buyerCharacterId: buyer.id } as never,
  });

  // Best-effort player DM (the in-portal surface is /inbox). NO
  // auto-completion: the player must approve before anything is installed.
  try {
    const [u] = await db.select({ discordId: users.discordId }).from(users).where(eq(users.id, offer.buyerUserId));
    if (u?.discordId) {
      await sendDirectMessage(
        u.discordId,
        `**${venue.name}** wants to install **${item.name}** on **${buyer.name}** ${priceLabel}.\n` +
          `Approve or deny it here: ${offerLink()}`,
      );
    }
  } catch (err) {
    logger.warn({ err, offerId: offer.id }, "install_owned player DM failed");
  }

  return { status: 201, body: offer };
}

// Freeform service bill: a clinic operator bills a character for work performed
// (repair, patch-up, checkup fee, etc). No stock or inventory leg — approving
// just debits the buyer's wallet and credits the clinic account (commission via
// the normal path; costBasis stays null so the full amount counts as profit).
// NO auto-completion: the offer is left PENDING for the player to approve from
// their Inbox, exactly like install_owned.
export async function createServiceBillOffer(opts: {
  venueId: number;
  buyerCharacterId: number;
  amount: number;
  note: string;
  actor: Actor;
}): Promise<OfferResult> {
  const kind: OfferKind = "ripperdoc";
  const { venueId, buyerCharacterId, actor } = opts;

  const note = (opts.note ?? "").trim();
  if (!note) return { status: 400, body: { error: "A note describing the service is required" } };
  if (note.length > 200) return { status: 400, body: { error: "Note must be 200 characters or fewer" } };
  const amount = Math.floor(Number(opts.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { status: 400, body: { error: "Amount must be a positive number" } };
  }

  const [venue] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, venueId));
  if (!venue) return { status: 404, body: { error: "Venue not found" } };
  if (!(await isOperator(kind, venue, venueId, actor))) {
    return { status: 403, body: { error: "Not authorized to operate this clinic" } };
  }

  const [buyer] = await db.select().from(characters).where(eq(characters.id, buyerCharacterId));
  if (!buyer) return { status: 404, body: { error: "Character not found" } };
  if (buyer.archived) return { status: 400, body: { error: "Character is archived" } };
  if (!buyer.ownerId) return { status: 409, body: { error: "Character is unclaimed" } };

  const seller = await resolveSeller(kind, venue, venueId, actor);
  const expiresAt = new Date(Date.now() + OFFER_TTL_DAYS * 24 * 60 * 60 * 1000);

  const [offer] = await db
    .insert(saleOffers)
    .values({
      kind,
      offerType: "service",
      [venueColName(kind)]: venueId,
      stockId: null,
      cwp: null,
      itemName: note,
      itemCategory: "service",
      unitPrice: amount,
      quantity: 1,
      totalPrice: amount,
      buyerCharacterId: buyer.id,
      buyerUserId: buyer.ownerId,
      sellerCharacterId: seller.sellerCharacterId,
      sellerEmployeeId: seller.sellerEmployeeId,
      commissionPct: seller.commissionPct,
      createdById: actor.id,
      memo: null,
      status: "pending",
      expiresAt,
    } as never)
    .returning();

  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_create",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Sent service bill to ${buyer.name}: ${note} for €$${amount}`,
    afterJson: { offerType: "service", amount, buyerCharacterId: buyer.id, venueId } as never,
  });

  // Best-effort player DM (the in-portal surface is /inbox). NO
  // auto-completion: the player must approve before any money moves.
  try {
    const [u] = await db.select({ discordId: users.discordId }).from(users).where(eq(users.id, offer.buyerUserId));
    if (u?.discordId) {
      await sendDirectMessage(
        u.discordId,
        `**${venue.name}** sent **${buyer.name}** a bill for €$${amount}: ${note}\n` +
          `Approve or deny it here: ${offerLink()}`,
      );
    }
  } catch (err) {
    logger.warn({ err, offerId: offer.id }, "service bill player DM failed");
  }

  return { status: 201, body: offer };
}

// Admin proposes adding a cyberware piece to ANOTHER venue's stock for a price
// the venue pays on approval. The offer's "buyer" is the venue owner (the
// approver); nothing moves until they accept (or deny — a pure status flip).
export async function createStockAddOffer(opts: {
  kind: OfferKind;
  venueId: number;
  itemName: string;
  unitPrice: number;
  quantity: number;
  cwp?: number | null;
  memo?: string | null;
  actor: Actor;
}): Promise<OfferResult> {
  const { kind, venueId, actor } = opts;
  // Restock offers are an admin override, not an operator action.
  if (!hasRole(actor.roles, "ADMIN")) {
    return { status: 403, body: { error: "Admin only" } };
  }
  const itemName = (opts.itemName ?? "").trim();
  if (!itemName) return { status: 400, body: { error: "Item name is required" } };
  const unitPrice = Math.max(0, Math.floor(Number(opts.unitPrice) || 0));
  const quantity = Math.max(1, Math.floor(Number(opts.quantity) || 1));
  const cwp = opts.cwp != null && Number.isFinite(opts.cwp) ? Math.max(0, Math.floor(opts.cwp)) : null;

  const venueTable = venueTableFor(kind);
  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) return { status: 404, body: { error: "Venue not found" } };
  if (!venue.ownerCharacterId) {
    return { status: 409, body: { error: "Venue owner has no linked character to approve the offer" } };
  }

  const totalPrice = unitPrice * quantity;
  const expiresAt = new Date(Date.now() + OFFER_TTL_DAYS * 24 * 60 * 60 * 1000);
  const priceLabel = totalPrice > 0 ? `for €$${totalPrice}` : "for free";

  const [offer] = await db
    .insert(saleOffers)
    .values({
      kind,
      offerType: "stock_add",
      [venueColName(kind)]: venueId,
      stockId: null,
      cwp,
      itemName,
      itemCategory: "cyberware",
      unitPrice,
      quantity,
      totalPrice,
      buyerCharacterId: venue.ownerCharacterId,
      buyerUserId: venue.ownerId,
      sellerCharacterId: null,
      sellerEmployeeId: null,
      commissionPct: 0,
      createdById: actor.id,
      memo: opts.memo ?? null,
      status: "pending",
      expiresAt,
    } as never)
    .returning();

  await db.insert(activityEvents).values({
    kind: "shop",
    actorId: actor.id,
    actorName: actor.username,
    actorAvatarUrl: actor.avatarUrl,
    message: `${actor.username} offered to add ${itemName} x${quantity} to ${venue.name} stock ${priceLabel}`,
  });
  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_create",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Offered to add ${itemName} x${quantity} to ${venue.name} stock ${priceLabel}`,
    afterJson: { offerType: "stock_add", totalPrice, quantity, cwp, venueId, venueKind: kind } as never,
  });

  // Best-effort owner DM (the in-portal surface is /inbox).
  try {
    const [u] = await db.select({ discordId: users.discordId }).from(users).where(eq(users.id, offer.buyerUserId));
    if (u?.discordId) {
      await sendDirectMessage(
        u.discordId,
        `**${venue.name}** has a stock offer: add **${itemName}** x${quantity} to your stock ${priceLabel} (billed to the venue account).\n` +
          `Approve or deny it here: ${offerLink()}`,
      );
    }
  } catch (err) {
    logger.warn({ err, offerId: offer.id }, "stock-add owner DM failed");
  }

  return { status: 201, body: offer };
}

// Approve a stock_add offer: debit the venue's internal balance and add the
// item to the venue's stock — all in one transaction. There is no external
// wallet leg, so the guarded pending->approved flip makes the whole thing
// idempotent (a second approve finds status != pending and no-ops).
async function approveStockAddOffer(offer: SaleOffer, actor: Actor): Promise<OfferResult> {
  // A stock_add offer is a proposal that DEBITS the venue's account, so it must
  // be accepted by the venue owner (the offer buyer) — not by the admin who
  // created it. Admins can create and deny, but cannot self-approve a charge.
  if (offer.buyerUserId !== actor.id) {
    return { status: 403, body: { error: "Only the venue owner can approve a stock-add offer." } };
  }
  if (offer.status === "approved") {
    return { status: 200, body: { offer, duplicate: true } };
  }
  if (offer.status !== "pending") {
    return { status: 409, body: { error: `Offer already ${offer.status}` } };
  }
  if (offer.expiresAt && offer.expiresAt.getTime() < Date.now()) {
    await db
      .update(saleOffers)
      .set({ status: "expired", decidedAt: new Date() })
      .where(and(eq(saleOffers.id, offer.id), eq(saleOffers.status, "pending")));
    return { status: 409, body: { error: "Offer has expired" } };
  }

  const mode = await getEconomyMode();
  if (mode === "disabled") {
    return { status: 409, body: { error: "Economy is disabled; offers cannot be approved right now." } };
  }
  if (mode === "test") {
    return {
      status: 200,
      body: { dryRun: true, offer, wouldDebitVenue: offer.totalPrice, wouldAddStock: offer.quantity },
    };
  }

  const kind = offer.kind as OfferKind;
  const venueTable = venueTableFor(kind);
  const stockTable = stockTableFor(kind);
  const venueId = (kind === "store" ? offer.storeId : offer.ripperdocId)!;
  const hasMoney = offer.totalPrice > 0;

  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) return { status: 404, body: { error: "Venue not found" } };

  let insufficient = false;
  let alreadyResolved = false;
  let completionError: unknown = null;
  let venueBalanceAfter = venue.balance;
  await db
    .transaction(async (tx) => {
      const [flipped] = await tx
        .update(saleOffers)
        .set({ status: "approved", decidedAt: new Date() })
        .where(and(eq(saleOffers.id, offer.id), eq(saleOffers.status, "pending")))
        .returning();
      if (!flipped) {
        alreadyResolved = true;
        return;
      }

      if (hasMoney) {
        // Guarded debit: only succeeds when the venue can cover it. A miss
        // rolls back the flip so the offer stays pending.
        const [debited] = await tx
          .update(venueTable)
          .set({ balance: sql`${venueTable.balance} - ${offer.totalPrice}` })
          .where(and(eq(venueTable.id, venueId), gte(venueTable.balance, offer.totalPrice)))
          .returning();
        if (!debited) {
          insufficient = true;
          throw new Error("venue-insufficient-funds");
        }
        venueBalanceAfter = debited.balance;
        await tx.insert(walletTransactions).values({
          [venueColName(kind)]: venueId,
          characterId: venue.ownerCharacterId ?? null,
          amount: -offer.totalPrice,
          kind: "shop",
          source: kind,
          memo: `Stock added: ${offer.itemName} x${offer.quantity}`,
          relatedEntityType: "sale_offer",
          relatedEntityId: offer.id,
          previousBalance: venueBalanceAfter + offer.totalPrice,
          newBalance: venueBalanceAfter,
        } as never);
      }

      // Fold into an identical existing stock line (same name/price) when one
      // exists, otherwise create a new one.
      const stockVenueCol = stockVenueColFor(kind);
      const [existing] = await tx
        .select()
        .from(stockTable)
        .where(and(eq(stockVenueCol, venueId), eq(stockTable.name, offer.itemName), eq(stockTable.price, offer.unitPrice)))
        .limit(1);
      const notes = offer.cwp != null ? `CWP ${offer.cwp}` : null;
      if (existing) {
        await tx
          .update(stockTable)
          .set({ quantity: sql`${stockTable.quantity} + ${offer.quantity}` })
          .where(eq(stockTable.id, existing.id));
      } else {
        await tx.insert(stockTable).values({
          [venueColName(kind)]: venueId,
          name: offer.itemName,
          category: "cyberware",
          price: offer.unitPrice,
          quantity: offer.quantity,
          notes,
        } as never);
      }
    })
    .catch((err) => {
      completionError = err;
    });

  if (insufficient) {
    return { status: 400, body: { error: "Venue account has insufficient funds" } };
  }
  if (completionError) {
    return { status: 409, body: { error: "Offer could not be completed" } };
  }
  if (alreadyResolved) {
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    if (fresh?.status === "approved") return { status: 200, body: { offer: fresh, duplicate: true } };
    return { status: 409, body: { error: `Offer was already ${fresh?.status ?? "resolved"}` } };
  }

  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_approve",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Approved stock_add: ${offer.itemName} x${offer.quantity} for €$${offer.totalPrice} @ ${venue.name}`,
    afterJson: { offerType: "stock_add", totalPrice: offer.totalPrice, quantity: offer.quantity, venueBalanceAfter } as never,
  });
  await db.insert(activityEvents).values({
    kind: "shop",
    actorId: actor.id,
    actorName: actor.username,
    actorAvatarUrl: actor.avatarUrl,
    message: `${venue.name} added ${offer.itemName} x${offer.quantity} to stock${hasMoney ? ` for €$${offer.totalPrice}` : ""}`,
  });

  const [finalOffer] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
  return { status: 200, body: { offer: finalOffer, venueBalance: venueBalanceAfter } };
}

// ---------------------------------------------------------------------------
// player_sell: a player offers an item FROM their character's inventory TO a
// venue. Mirrors stock_add's owner-approval shape, but with an inventory leg
// (item leaves the seller) and a seller wallet credit on top of the venue
// debit + stock add.

export async function createPlayerSellOffer(opts: {
  kind: OfferKind;
  venueId: number;
  inventoryItemId: number;
  unitPrice: number;
  quantity: number;
  memo?: string | null;
  actor: Actor;
}): Promise<OfferResult> {
  const { kind, venueId, actor } = opts;
  const unitPrice = Math.max(0, Math.floor(Number(opts.unitPrice) || 0));
  const quantity = Math.max(1, Math.floor(Number(opts.quantity) || 1));

  // The item must sit in a character the acting player owns.
  const [row] = await db
    .select({ item: inventoryItems, character: characters })
    .from(inventoryItems)
    .innerJoin(characters, eq(characters.id, inventoryItems.characterId))
    .where(eq(inventoryItems.id, opts.inventoryItemId));
  if (!row || row.character.ownerId !== actor.id) {
    return { status: 404, body: { error: "Item not found in your inventory" } };
  }
  if (quantity > row.item.quantity) {
    return { status: 400, body: { error: `You only have ${row.item.quantity} of this item` } };
  }
  // Installed chrome (a "CWP n" note tag) is part of the character's body —
  // it must go through a ripperdoc removal first, never a direct sale.
  const isCyberware = (row.item.category ?? "").trim().toLowerCase() === "cyberware";
  if (isCyberware && parseCwp(row.item.notes) != null) {
    return { status: 409, body: { error: "Installed cyberware cannot be sold — have it removed at a ripperdoc first." } };
  }

  const venueTable = venueTableFor(kind);
  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) return { status: 404, body: { error: "Venue not found" } };

  // At most one pending offer per inventory item keeps the approve-time
  // quantity guard honest (two pending offers could both pass creation checks
  // but only one can be fulfilled).
  const [dup] = await db
    .select({ id: saleOffers.id })
    .from(saleOffers)
    .where(and(eq(saleOffers.installItemId, row.item.id), eq(saleOffers.offerType, "player_sell"), eq(saleOffers.status, "pending")))
    .limit(1);
  if (dup) {
    return { status: 409, body: { error: "You already have a pending sell offer for this item." } };
  }

  const totalPrice = unitPrice * quantity;
  const expiresAt = new Date(Date.now() + OFFER_TTL_DAYS * 24 * 60 * 60 * 1000);
  const [offer] = await db
    .insert(saleOffers)
    .values({
      kind,
      offerType: "player_sell",
      [venueColName(kind)]: venueId,
      stockId: null,
      cwp: null,
      installItemId: row.item.id,
      itemName: row.item.name,
      itemCategory: row.item.category,
      unitPrice,
      quantity,
      totalPrice,
      // The venue OWNER is the deciding "buyer" — the money comes out of the
      // venue account they control.
      buyerCharacterId: venue.ownerCharacterId ?? row.item.characterId,
      buyerUserId: venue.ownerId,
      sellerCharacterId: row.item.characterId,
      sellerEmployeeId: null,
      commissionPct: 0,
      createdById: actor.id,
      memo: opts.memo ?? null,
      status: "pending",
      expiresAt,
    } as never)
    .returning();

  const priceLabel = totalPrice > 0 ? `for €$${totalPrice}` : "for free";
  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_create",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `${row.character.name} offered to sell ${row.item.name} x${quantity} to ${venue.name} ${priceLabel}`,
    afterJson: { offerType: "player_sell", totalPrice, quantity, venueId, venueKind: kind, inventoryItemId: row.item.id } as never,
  });

  // Portal bell + best-effort DM to the venue owner.
  void createNotification({
    userId: venue.ownerId,
    type: "sale_offer",
    title: `Sell offer at ${venue.name}`,
    body: `${row.character.name} wants to sell ${row.item.name} x${quantity} ${priceLabel}.`,
    href: hrefInbox(),
  });
  try {
    const [u] = await db.select({ discordId: users.discordId }).from(users).where(eq(users.id, venue.ownerId));
    if (u?.discordId) {
      await sendDirectMessage(
        u.discordId,
        `**${row.character.name}** wants to sell **${row.item.name}** x${quantity} to **${venue.name}** ${priceLabel} (billed to the venue account).\n` +
          `Approve or deny it here: ${offerLink()}`,
      );
    }
  } catch (err) {
    logger.warn({ err, offerId: offer.id }, "player-sell owner DM failed");
  }

  return { status: 201, body: offer };
}

// Approve a player_sell offer: debit the venue account, move the item from the
// seller's inventory into venue stock (one tx), then credit the seller's
// wallet (idempotency-keyed, after the tx since applyWalletDelta commits its
// own transaction).
async function approvePlayerSellOffer(offer: SaleOffer, actor: Actor): Promise<OfferResult> {
  // Venue-account debits are accepted by the venue owner only — admins can
  // deny, but cannot approve a charge against someone else's account. Gate on
  // the venue's CURRENT owner, not the buyerUserId snapshot taken at offer
  // creation: if the venue changed hands while pending, the former owner must
  // not be able to spend the new owner's money.
  {
    const vt = venueTableFor(offer.kind as OfferKind);
    const vid = ((offer.kind as OfferKind) === "store" ? offer.storeId : offer.ripperdocId)!;
    const [v] = await db.select({ ownerId: vt.ownerId }).from(vt).where(eq(vt.id, vid));
    if (!v) return { status: 404, body: { error: "Venue not found" } };
    if (v.ownerId !== actor.id) {
      return { status: 403, body: { error: "Only the venue owner can approve a sell offer." } };
    }
  }
  if (offer.status === "approved") {
    // Re-entry: the only thing that can remain unfinished is the seller
    // credit; retry it idempotently.
    const payout = await settlePlayerSellCredit(offer);
    return { status: 200, body: { offer, duplicate: true, ...(payout ? {} : { payoutFailed: true }) } };
  }
  if (offer.status !== "pending") {
    return { status: 409, body: { error: `Offer already ${offer.status}` } };
  }
  if (offer.expiresAt && offer.expiresAt.getTime() < Date.now()) {
    await db
      .update(saleOffers)
      .set({ status: "expired", decidedAt: new Date() })
      .where(and(eq(saleOffers.id, offer.id), eq(saleOffers.status, "pending")));
    return { status: 409, body: { error: "Offer has expired" } };
  }

  const mode = await getEconomyMode();
  if (mode === "disabled") {
    return { status: 409, body: { error: "Economy is disabled; offers cannot be approved right now." } };
  }
  if (mode === "test") {
    return {
      status: 200,
      body: { dryRun: true, offer, wouldDebitVenue: offer.totalPrice, wouldCreditSeller: offer.totalPrice, wouldAddStock: offer.quantity },
    };
  }

  const kind = offer.kind as OfferKind;
  const venueTable = venueTableFor(kind);
  const stockTable = stockTableFor(kind);
  const venueId = (kind === "store" ? offer.storeId : offer.ripperdocId)!;
  const hasMoney = offer.totalPrice > 0;

  const [venue] = await db.select().from(venueTable).where(eq(venueTable.id, venueId));
  if (!venue) return { status: 404, body: { error: "Venue not found" } };

  let insufficient = false;
  let alreadyResolved = false;
  let itemGone: string | null = null;
  let completionError: unknown = null;
  let venueBalanceAfter = venue.balance;
  let soldItem: typeof inventoryItems.$inferSelect | null = null;
  await db
    .transaction(async (tx) => {
      const [flipped] = await tx
        .update(saleOffers)
        .set({ status: "approved", decidedAt: new Date() })
        .where(and(eq(saleOffers.id, offer.id), eq(saleOffers.status, "pending")))
        .returning();
      if (!flipped) {
        alreadyResolved = true;
        return;
      }

      // Lock and re-validate the seller's inventory row: still on the same
      // character, enough quantity, and (for chrome) still uninstalled.
      const [item] = await tx
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.id, offer.installItemId!))
        .for("update");
      if (!item || item.characterId !== offer.sellerCharacterId) {
        itemGone = "The item is no longer in the seller's inventory.";
        throw new Error("player-sell-item-gone");
      }
      // The selling character must still belong to the user who gets paid
      // (offer.createdById). A character ownership transfer between creation
      // and approval must not let the FORMER owner collect for the NEW
      // owner's item.
      const [sellerChar] = await tx
        .select({ ownerId: characters.ownerId })
        .from(characters)
        .where(eq(characters.id, item.characterId!))
        .for("update");
      if (!sellerChar || sellerChar.ownerId !== offer.createdById) {
        itemGone = "The selling character has changed hands — the offer is no longer valid.";
        throw new Error("player-sell-owner-changed");
      }
      if (item.quantity < offer.quantity) {
        itemGone = `The seller only has ${item.quantity} of this item now.`;
        throw new Error("player-sell-item-short");
      }
      const isCyberware = (item.category ?? "").trim().toLowerCase() === "cyberware";
      if (isCyberware && parseCwp(item.notes) != null) {
        itemGone = "The item has since been installed and can no longer be sold.";
        throw new Error("player-sell-item-installed");
      }
      soldItem = item;

      if (hasMoney) {
        // Guarded debit: only succeeds when the venue can cover it.
        const [debited] = await tx
          .update(venueTable)
          .set({ balance: sql`${venueTable.balance} - ${offer.totalPrice}` })
          .where(and(eq(venueTable.id, venueId), gte(venueTable.balance, offer.totalPrice)))
          .returning();
        if (!debited) {
          insufficient = true;
          throw new Error("venue-insufficient-funds");
        }
        venueBalanceAfter = debited.balance;
        await tx.insert(walletTransactions).values({
          [venueColName(kind)]: venueId,
          characterId: venue.ownerCharacterId ?? null,
          amount: -offer.totalPrice,
          kind: "shop",
          source: kind,
          memo: `Bought from player: ${offer.itemName} x${offer.quantity}`,
          relatedEntityType: "sale_offer",
          relatedEntityId: offer.id,
          previousBalance: venueBalanceAfter + offer.totalPrice,
          newBalance: venueBalanceAfter,
        } as never);
      }

      // Inventory leg: decrement (delete at zero).
      if (item.quantity === offer.quantity) {
        await tx.delete(inventoryItems).where(eq(inventoryItems.id, item.id));
      } else {
        await tx
          .update(inventoryItems)
          .set({ quantity: sql`${inventoryItems.quantity} - ${offer.quantity}` })
          .where(eq(inventoryItems.id, item.id));
      }

      // Stock leg: fold into an identical line (same name/price) or create.
      const stockVenueCol = stockVenueColFor(kind);
      const [existing] = await tx
        .select()
        .from(stockTable)
        .where(and(eq(stockVenueCol, venueId), eq(stockTable.name, offer.itemName), eq(stockTable.price, offer.unitPrice)))
        .limit(1);
      if (existing) {
        await tx
          .update(stockTable)
          .set({ quantity: sql`${stockTable.quantity} + ${offer.quantity}` })
          .where(eq(stockTable.id, existing.id));
      } else {
        await tx.insert(stockTable).values({
          [venueColName(kind)]: venueId,
          name: offer.itemName,
          category: item.category,
          price: offer.unitPrice,
          quantity: offer.quantity,
          notes: item.notes,
        } as never);
      }
    })
    .catch((err) => {
      completionError = err;
    });

  if (insufficient) {
    return { status: 400, body: { error: "Venue account has insufficient funds" } };
  }
  if (itemGone) {
    return { status: 409, body: { error: itemGone } };
  }
  if (completionError) {
    logger.error({ err: completionError, offerId: offer.id }, "player-sell approve failed");
    return { status: 409, body: { error: "Offer could not be completed" } };
  }
  if (alreadyResolved) {
    const [fresh] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
    if (fresh?.status === "approved") return { status: 200, body: { offer: fresh, duplicate: true } };
    return { status: 409, body: { error: `Offer was already ${fresh?.status ?? "resolved"}` } };
  }

  // Seller credit — outside the tx (applyWalletDelta commits its own), keyed
  // on the offer so retries (re-approve) settle exactly once.
  const paid = await settlePlayerSellCredit(offer);

  await db.insert(auditLog).values({
    category: "shop",
    action: "sale_offer_approve",
    actorId: actor.id,
    actorName: actor.username,
    targetType: "sale_offer",
    targetId: String(offer.id),
    message: `Approved player sale: bought ${offer.itemName} x${offer.quantity} for €$${offer.totalPrice} @ ${venue.name}`,
    afterJson: { offerType: "player_sell", totalPrice: offer.totalPrice, quantity: offer.quantity, venueBalanceAfter, sellerPaid: paid } as never,
  });
  await db.insert(activityEvents).values({
    kind: "shop",
    actorId: actor.id,
    actorName: actor.username,
    actorAvatarUrl: actor.avatarUrl,
    message: `${venue.name} bought ${offer.itemName} x${offer.quantity} from a player${hasMoney ? ` for €$${offer.totalPrice}` : ""}`,
  });
  if (soldItem) {
    await recordInventoryEvent({
      instanceUuid: (soldItem as typeof inventoryItems.$inferSelect).instanceUuid,
      kind: "adjusted",
      actorId: actor.id,
      actorName: actor.username,
      fromCharacterId: offer.sellerCharacterId ?? undefined,
      itemName: offer.itemName,
      quantity: offer.quantity,
      price: offer.totalPrice,
      reason: `Sold to ${venue.name}`,
      metadata: { venueKind: kind, venueId, venueName: venue.name, offerId: offer.id, offerType: "player_sell" },
    });
  }

  const [finalOffer] = await db.select().from(saleOffers).where(eq(saleOffers.id, offer.id));
  return { status: 200, body: { offer: finalOffer, venueBalance: venueBalanceAfter, ...(paid ? {} : { payoutFailed: true }) } };
}

// Idempotent seller payout for a player_sell offer. Returns true when the
// credit is settled (including duplicate = already settled).
async function settlePlayerSellCredit(offer: SaleOffer): Promise<boolean> {
  if (offer.totalPrice <= 0) return true;
  const [seller] = await db.select().from(users).where(eq(users.id, offer.createdById));
  if (!seller) return false;
  const result = await applyWalletDelta({
    userId: seller.id,
    discordId: seller.discordId,
    amount: offer.totalPrice,
    source: "website",
    kind: "shop",
    reason: `Sold ${offer.itemName} x${offer.quantity} to a venue`,
    characterId: offer.sellerCharacterId ?? null,
    relatedEntityType: "sale_offer",
    relatedEntityId: offer.id,
    idempotencyKey: `offer:${offer.id}:player-sell-credit`,
  });
  if (!result.ok) {
    logger.error({ offerId: offer.id, result }, "player-sell seller credit failed — re-approve to retry");
    return false;
  }
  void createNotification({
    userId: seller.id,
    type: "sale_offer",
    title: "Your sell offer was accepted",
    body: `${offer.itemName} x${offer.quantity} sold for €$${offer.totalPrice}.`,
    href: hrefInbox(),
  });
  if (seller.discordId) {
    void sendDirectMessage(
      seller.discordId,
      `Your sell offer was accepted: **${offer.itemName}** x${offer.quantity} for **€$${offer.totalPrice}**. The eddies are in your wallet.`,
    ).catch(() => {});
  }
  return true;
}

// Authorization for approve/deny: the buyer (offer owner) or an admin. For
// player_sell offers the CREATOR (the selling player) may also act — but only
// to WITHDRAW: approvePlayerSellOffer re-checks buyer-only, so a seller (or an
// admin) can never approve a charge against someone else's venue account.
async function canDecide(offer: SaleOffer, actor: Actor): Promise<boolean> {
  if (offer.buyerUserId === actor.id || hasRole(actor.roles, "ADMIN")) return true;
  if ((offer.offerType as OfferType) !== "player_sell") return false;
  // The selling player may withdraw their own pending offer…
  if (offer.createdById === actor.id) return true;
  // …and the venue's CURRENT owner may decide even if the venue changed hands
  // after the offer snapshotted the then-owner into buyerUserId. (Approve
  // additionally re-checks live ownership as the authoritative gate.)
  const vt = venueTableFor(offer.kind as OfferKind);
  const vid = (offer.kind as OfferKind) === "store" ? offer.storeId : offer.ripperdocId;
  if (vid == null) return false;
  const [v] = await db.select({ ownerId: vt.ownerId }).from(vt).where(eq(vt.id, vid));
  return !!v && v.ownerId === actor.id;
}

export async function denyOffer(offerId: number, actor: Actor): Promise<OfferResult> {
  const [offer] = await db.select().from(saleOffers).where(eq(saleOffers.id, offerId));
  if (!offer) return { status: 404, body: { error: "Offer not found" } };
  if (!(await canDecide(offer, actor))) return { status: 403, body: { error: "Forbidden" } };
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
  if (!(await canDecide(offer, actor))) return { status: 403, body: { error: "Forbidden" } };
  // stock_add bills the venue account (internal balance) and adds to stock —
  // an entirely different money/stock path, handled in its own function.
  if ((offer.offerType as OfferType) === "stock_add") {
    return await approveStockAddOffer(offer, actor);
  }
  // player_sell debits the venue account and credits the SELLING PLAYER —
  // reverse money/stock direction, handled in its own function.
  if ((offer.offerType as OfferType) === "player_sell") {
    return await approvePlayerSellOffer(offer, actor);
  }
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

  return await completeSaleOffer(offer, actor);
}

// Runs the actual money/stock/inventory movement for a non-stock_add offer.
// Shared by approveOffer (legacy buyer-approval path) and the instant
// venue-sale path in createOffer/createRemoveOffer. Self-contained from the
// economy-mode gate onward: the caller is responsible for loading the offer,
// authorizing the actor, and the pending/expiry/already-approved checks.
// Retry-safe buyer debit for an offer. The naive fixed key `offer:<id>:buyer`
// is unsafe across a failed-then-refunded attempt: the retry's debit would come
// back "duplicate" (already charged once) even though that charge was refunded,
// letting the completion proceed for free. So each refund gets a key derived
// from the debit ledger row it compensates, and this settle loop re-charges
// with a fresh attempt key whenever the previous debit was refunded.
export function offerRefundKeyFor(offerId: number, debitLedgerId: number | null | undefined): string {
  // Legacy fallback: pre-cutover refunds used one fixed key per offer.
  return debitLedgerId ? `offer:${offerId}:refund:${debitLedgerId}` : `offer:${offerId}:buyer-refund`;
}

async function settleOfferBuyerDebit(
  base: Omit<Parameters<typeof applyWalletDelta>[0], "idempotencyKey">,
  offerId: number,
): Promise<{ result: Awaited<ReturnType<typeof applyWalletDelta>>; debitLedgerId: number | null }> {
  let key = `offer:${offerId}:buyer`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await applyWalletDelta({ ...base, idempotencyKey: key });
    if (!result.ok) return { result, debitLedgerId: null };
    if (result.status !== "duplicate") return { result, debitLedgerId: result.ledgerId ?? null };
    // A prior attempt already charged this key. If that charge was later
    // refunded, this retry must charge again under a fresh attempt key.
    const ledgerId = result.ledgerId ?? null;
    const refundKeys = [offerRefundKeyFor(offerId, ledgerId)];
    if (key === `offer:${offerId}:buyer`) refundKeys.push(`offer:${offerId}:buyer-refund`); // legacy fixed key
    const refunds = ledgerId
      ? await db
          .select({ id: walletTransactions.id, idempotencyKey: walletTransactions.idempotencyKey })
          .from(walletTransactions)
          .where(inArray(walletTransactions.idempotencyKey, refundKeys))
      : [];
    if (refunds.length === 0) return { result, debitLedgerId: ledgerId }; // still settled — genuine duplicate
    key = `offer:${offerId}:buyer:r${refunds[0].id}`;
  }
  return {
    result: { ok: false, status: "failed", balance: 0, previousBalance: 0, proposedBalance: 0, error: "Debit settle loop exceeded retries" },
    debitLedgerId: null,
  };
}

async function completeSaleOffer(offer: SaleOffer, actor: Actor): Promise<OfferResult> {
  const offerId = offer.id;
  const mode = await getEconomyMode();
  if (mode === "disabled") {
    return { status: 409, body: { error: "Economy is disabled; offers cannot be approved right now." } };
  }
  if (mode === "test") {
    // Dry-run: report what would happen, move nothing, leave the offer pending.
    const commissionAmount = computeCommissionAmount(offer);
    return {
      status: 200,
      body: { dryRun: true, offer, wouldDebitBuyer: offer.totalPrice, wouldCreditStore: offer.totalPrice, wouldPayCommission: commissionAmount },
    };
  }

  const kind = offer.kind as OfferKind;
  const offerType: OfferType = (offer.offerType as OfferType) ?? "sale";
  const isRemove = offerType === "remove";
  const isInstallOwned = offerType === "install_owned";
  const isService = offerType === "service";
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

  // Install (stock-backed OR owned): re-validate the PC capacity cap at approval
  // time. Other chrome may have landed since the offer was created, so the
  // up-front check isn't enough.
  if (offerType === "install" || isInstallOwned) {
    const used = (await sumCwpByCharacter([buyer.id])).get(buyer.id) ?? 0;
    const cap = checkCwpCapacity({ kind: buyer.kind, used, add: (offer.cwp ?? 0) * offer.quantity });
    if (!cap.ok) return { status: 409, body: { error: cap.reason } };
  }

  // Installed cyberware notes should carry the slot (trailing "slot: <x>"
  // segment, the CyberwareEditor convention) so the staff editor and slot-cap
  // logic don't fall back to "unknown slot". Resolve from the catalog by item
  // name; unknown/custom items simply get no slot segment. Loaded BEFORE the
  // buyer debit so a transient lookup failure can never charge a buyer without
  // completing the offer, and outside the tx to keep it short.
  const cyberSlotByName =
    offerType === "install" || isInstallOwned ? await loadCyberwareSlotByName() : null;
  const withInstallSlot = (base: string, name: string | null): string => {
    const slot = cyberSlotByName ? resolveSlotForItem({ name, notes: null }, cyberSlotByName) : "";
    return slot ? `${base} · slot: ${slot}` : base;
  };

  // 1) Reserve-before-call buyer debit (idempotent on retry). Skipped entirely
  // for free offers (give, or a zero-fee removal) — no money moves.
  let buyerDebitLedgerId: number | null = null;
  if (hasMoney) {
    const debitReason =
      offerType === "install" || isInstallOwned ? `Cyberware install: ${offer.itemName} @ ${venue.name}`
      : offerType === "remove" ? `Cyberware removal: ${offer.itemName} @ ${venue.name}`
      : isService ? `Service: ${offer.itemName} @ ${venue.name}`
      : `Purchase: ${offer.itemName} x${offer.quantity} @ ${venue.name}`;
    const { result: debit, debitLedgerId } = await settleOfferBuyerDebit(
      {
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
      },
      offer.id,
    );
    if (!debit.ok) {
      if (debit.status === "insufficient_funds") return { status: 400, body: { error: "Buyer has insufficient funds" } };
      return { status: 502, body: { error: debit.error ?? "Wallet provider unavailable" } };
    }
    buyerDebitLedgerId = debitLedgerId;
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

    if (offerType === "install" || isInstallOwned) {
      // Race-safe enforcement for BOTH install modes. The pre-tx checks can pass
      // for two concurrent approvals against the same PC. Take a row lock on the
      // buyer so those approvals serialize; the second waiter then sees the
      // first's committed install in the cap/slot re-checks below.
      await tx.execute(sql`SELECT id FROM ${characters} WHERE ${eq(characters.id, buyer.id)} FOR UPDATE`);
    }

    if (offerType === "install") {
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
      // One-per-capped-slot re-check under the same buyer lock (another install
      // may have landed in this slot since the offer was created).
      const slotErrNow = await installSlotClashError({
        executor: tx,
        buyer,
        item: { name: offer.itemName, notes: null },
        qty: offer.quantity,
      });
      if (slotErrNow) {
        completionFailReason = slotErrNow;
        throw new Error("slot-guard-miss"); // rolls back the flip + debit
      }
    }

    if (isInstallOwned) {
      // Install a piece the player already owns: re-verify the target is still
      // an uninstalled chrome item (under the buyer row lock taken above), then
      // stamp the CWP install tag + mark it equipped. No stock leg. Idempotency
      // is covered by the pending->approved flip guard.
      const [target] = await tx
        .select()
        .from(inventoryItems)
        .where(and(eq(inventoryItems.id, offer.installItemId!), eq(inventoryItems.characterId, buyer.id)));
      if (!target || normalizeName(target.category ?? "") !== "cyberware" || parseCwp(target.notes) != null) {
        completionFailReason = "Cyberware to install was not found or is already installed";
        throw new Error("install-owned-target-miss");
      }
      // One-per-capped-slot re-check under the buyer row lock; exclude the
      // piece being installed (it already sits in the buyer's inventory).
      const ownedSlotErr = await installSlotClashError({
        executor: tx,
        buyer,
        item: { name: target.name, notes: target.notes },
        qty: target.quantity ?? 1,
        excludeItemId: target.id,
      });
      if (ownedSlotErr) {
        completionFailReason = ownedSlotErr;
        throw new Error("slot-guard-miss");
      }
      const [updated] = await tx
        .update(inventoryItems)
        .set({
          category: "cyberware",
          equipped: true,
          notes: withInstallSlot(`CWP ${offer.cwp ?? 0} · Installed at ${venue.name} on ${today}`, target.name),
        })
        .where(eq(inventoryItems.id, target.id))
        .returning();
      insertedItem = updated;
    } else if (isRemove) {
      // Un-install. Two destinations (offer.removeDestination):
      //   "patient" (default/null) — flip the item out of the "cyberware"
      //     category so it stops counting toward CWP, but keep it in the
      //     player's inventory.
      //   "clinic" — the item leaves the patient entirely and lands in the
      //     clinic's ripperdoc stock (the ripperdoc keeps the part).
      // Both paths guard on the still-installed state for idempotency.
      const stillInstalled = and(
        eq(inventoryItems.id, offer.removedItemId!),
        eq(inventoryItems.characterId, buyer.id),
        eq(inventoryItems.category, "cyberware"),
      );
      if ((offer as { removeDestination?: string | null }).removeDestination === "clinic") {
        const [taken] = await tx.delete(inventoryItems).where(stillInstalled).returning();
        if (!taken) {
          completionFailReason = "Cyberware to remove was not found (already removed?)";
          throw new Error("remove-target-miss");
        }
        // Land the part in clinic stock at price 0 (the doc sets a resale price
        // later). Keep a "CWP n" tag on the notes — it's the floor a future
        // install charges when the catalog has no authoritative value.
        const partCwp = offer.cwp ?? parseCwp(taken.notes) ?? 0;
        await tx.insert(ripperdocStock).values({
          ripperdocId: venueId!,
          name: taken.name,
          category: "cyberware",
          price: 0,
          cost: 0,
          quantity: Math.max(1, taken.quantity ?? 1),
          notes: `CWP ${partCwp} · Removed from ${buyer.name} on ${today}`,
        });
        removedItem = taken;
      } else {
        const [updated] = await tx
          .update(inventoryItems)
          .set({
            category: "cyberware (removed)",
            notes: sql`coalesce(${inventoryItems.notes}, '') || ${` · Removed at ${venue.name} on ${today}`}`,
          })
          .where(stillInstalled)
          .returning();
        if (!updated) {
          completionFailReason = "Cyberware to remove was not found (already removed?)";
          throw new Error("remove-target-miss");
        }
        removedItem = updated;
      }
    } else if (isService) {
      // Service bill: pure money movement — no stock leg, no inventory leg.
      // The debit above + the venue credit below are the whole effect.
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
        ? withInstallSlot(
            // Resolve from offer.itemName — the same name persisted on the
            // inventory row — not decremented.name, which staff can rename
            // while the offer is pending.
            `CWP ${offer.cwp ?? 0} · Installed at ${venue.name} on ${today}`,
            offer.itemName,
          )
        : null;
      // Gun-store sales land in the buyer's inventory as category "gun" (the
      // stock row's own category is the FIRING CLASS — Power/Tech/Smart — not
      // an inventory kind). Pack the mechanical attrs into notes with the same
      // " · " convention the custom-gun approval path uses.
      const isGunStoreSale =
        kind === "store" && (venue as { kind?: string | null }).kind === "guns";
      const gunNotes = isGunStoreSale
        ? [
            `Category: ${decremented.category ?? "n/a"}`,
            `Power: ${(decremented as { powerLevel?: string | null }).powerLevel ?? "n/a"}`,
            (decremented as { cyberwareReq?: string | null }).cyberwareReq
              ? `Requires: ${(decremented as { cyberwareReq?: string | null }).cyberwareReq}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : null;
      const category = offerType === "install"
        ? "cyberware"
        : isGunStoreSale
          ? "gun"
          : offer.itemCategory ?? (kind === "ripperdoc" ? "cyberware" : null);
      const [item] = await tx
        .insert(inventoryItems)
        .values({
          characterId: buyer.id,
          ownerId: buyer.ownerId,
          name: offer.itemName,
          category,
          quantity: offer.quantity,
          notes: installNotes ?? gunNotes,
          // Installs are live chrome the moment the offer completes — mirror the
          // install-owned branch (and sheet-seeded cyberware) so the character
          // page shows the item as installed, not sitting loose in the stash.
          equipped: offerType === "install",
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
        : isService ? `Service: ${offer.itemName}`
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
        idempotencyKey: offerRefundKeyFor(offer.id, buyerDebitLedgerId),
        allowNegative: true,
      });
      if (!refund.ok) {
        logger.error(
          { offerId: offer.id, venueId, status: refund.status, err: String(completionError) },
          "OFFER_REFUND_FAILED: completion failed and buyer refund failed; buyer remains debited, manual reconciliation required",
        );
        return { status: 409, body: { error: `${reason}; refund failed — please contact staff.`, needsReconcile: true } };
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
        idempotencyKey: offerRefundKeyFor(offer.id, buyerDebitLedgerId),
        allowNegative: true,
      });
      if (!refund.ok) {
        logger.error(
          { offerId: offer.id, venueId, status: refund.status, offerStatus: fresh?.status },
          "OFFER_REFUND_FAILED: buyer debited but offer not approved and refund failed; manual reconciliation required",
        );
        return { status: 409, body: { error: `Offer was ${fresh?.status ?? "resolved"}; refund failed — please contact staff.`, needsReconcile: true } };
      }
      return { status: 409, body: { error: `Offer was already ${fresh?.status ?? "resolved"}; buyer was refunded.` } };
    }
    return { status: 409, body: { error: `Offer was already ${fresh?.status ?? "resolved"}` } };
  }

  // 3) Shift wage split (bars): while at least one worker is clocked in and
  // the store's wage pct is set, the sale splits shiftWagePct% of the total
  // evenly among active workers and REPLACES the seller's profit commission.
  // Otherwise commission settles exactly as before. Both paths are idempotent
  // and retry-safe.
  const wages = await settleShiftWages(offer, { balance: venueBalanceAfter, name: venue.name }, kind, venueId);
  venueBalanceAfter = wages.venueBalanceAfter;
  let commissionPaid = 0;
  if (!wages.shiftRegime) {
    const settlement = await settleCommission(offer, { balance: venueBalanceAfter, name: venue.name }, kind, venueId);
    commissionPaid = settlement.commissionPaid;
    venueBalanceAfter = settlement.venueBalanceAfter;
  }

  // Inventory event + audit (best-effort, decision already committed).
  if (insertedItem) {
    await recordInventoryEvent({
      instanceUuid: (insertedItem as typeof inventoryItems.$inferSelect).instanceUuid,
      // install_owned mutates an existing item in place (it isn't a fresh
      // stock->inventory creation), so log it as an adjustment.
      kind: isInstallOwned ? "adjusted" : "created",
      actorId: actor.id,
      actorName: actor.username,
      toCharacterId: buyer.id,
      toCharacterName: buyer.name,
      itemName: offer.itemName,
      quantity: offer.quantity,
      price: offer.totalPrice,
      reason: offerType === "install" || isInstallOwned ? `Installed at ${venue.name}` : `Offer approved at ${venue.name}`,
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
    : isService ? "paid for"
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
      : isService
        ? `${buyer.name} ${verbPast} ${offer.itemName} at ${venue.name} ${priceTail}`
        : `${buyer.name} ${verbPast} ${offer.itemName} x${offer.quantity} ${offerType === "give" ? "from" : offerType === "install" ? "at" : "from"} ${venue.name} ${priceTail}`,
  });

  const [finalOffer] = await db.select().from(saleOffers).where(eq(saleOffers.id, offerId));
  return { status: 200, body: { offer: finalOffer, inventoryItem: insertedItem, commissionPaid, shiftWagesPaid: wages.wagesPaid, venueBalance: venueBalanceAfter } };
}

// A worker whose shift participates in a sale's wage split.
type ShiftWorker = { shiftId: number; characterId: number; characterName: string | null; userId: string };

// Load the workers for a sale's wage split from the offer's immutable
// shiftWageShiftIds snapshot (written atomically with the reserve). Never
// reconstruct membership from timestamps — a clock-in racing the settlement
// would make retries divide by a different worker count.
async function shiftWorkersFromSnapshot(shiftIds: number[]): Promise<ShiftWorker[]> {
  if (shiftIds.length === 0) return [];
  return db
    .select({
      shiftId: storeShifts.id,
      characterId: storeShifts.characterId,
      characterName: characters.name,
      userId: storeShifts.userId,
    })
    .from(storeShifts)
    .leftJoin(characters, eq(characters.id, storeShifts.characterId))
    .where(inArray(storeShifts.id, shiftIds));
}

// Credit each worker their per-sale wage. Idempotent per (offer, shift) via
// the `offer:<id>:shift:<shiftId>` wallet key — a retry after a crash or a
// failed credit re-attempts only the unpaid workers. Returns the total that
// is now confirmed paid.
async function payShiftWorkers(
  offer: SaleOffer,
  workers: ShiftWorker[],
  perWorker: number,
  venueId: number,
  venueName: string,
): Promise<number> {
  let paid = 0;
  for (const w of workers) {
    const [workerUser] = await db.select().from(users).where(eq(users.id, w.userId));
    if (!workerUser) continue;
    const credit = await applyWalletDelta({
      userId: workerUser.id,
      discordId: workerUser.discordId,
      amount: perWorker,
      source: "shift",
      kind: "shift_wage",
      reason: `Shift wages: ${offer.itemName} @ ${venueName}`,
      characterId: w.characterId,
      counterpartyName: venueName,
      relatedEntityType: "sale_offer",
      relatedEntityId: offer.id,
      storeId: venueId,
      idempotencyKey: `offer:${offer.id}:shift:${w.shiftId}`,
    });
    if (credit.ok) {
      paid += perWorker;
    } else {
      logger.error(
        { offerId: offer.id, shiftId: w.shiftId, venueId, perWorker, status: credit.status },
        "OFFER_SHIFT_WAGE_FAILED: worker wage credit failed; wages reserved (venue debited) but this worker unpaid — re-approve to retry",
      );
    }
  }
  return paid;
}

// Idempotent, retry-safe shift wage settlement for an approved store offer.
// Mirrors settleCommission's two durable phases:
//   reserve — active shifts locked + `shiftWagesSettledAt` stamped + venue
//             debited for the whole split + venue ledger row + per-shift
//             earned totals, committed atomically at most once.
//   pay     — per-worker `offer:<id>:shift:<shiftId>` wallet credits.
// shiftRegime=true means the wage split governs this sale and commission must
// be suppressed (even when the floored per-worker share is 0).
async function settleShiftWages(
  offer: SaleOffer,
  venue: { balance: number; name: string },
  kind: OfferKind,
  venueId: number,
): Promise<{ shiftRegime: boolean; wagesPaid: number; venueBalanceAfter: number }> {
  let venueBalanceAfter = venue.balance;
  const inactive = { shiftRegime: false, wagesPaid: 0, venueBalanceAfter };
  if (kind !== "store" || offer.totalPrice <= 0) return inactive;
  const [cfg] = await db
    .select({ shiftsEnabled: stores.shiftsEnabled, pct: stores.shiftWagePct })
    .from(stores)
    .where(eq(stores.id, venueId));
  if (!cfg?.shiftsEnabled || cfg.pct <= 0) return inactive;

  // Recovery: a prior run already reserved the split — re-pay exactly the
  // snapshotted membership with idempotent credits.
  if (offer.shiftWagesSettledAt) {
    const total = offer.shiftWagesAmount ?? 0;
    const snapshot = offer.shiftWageShiftIds ?? [];
    if (total <= 0 || snapshot.length === 0) return { shiftRegime: true, wagesPaid: 0, venueBalanceAfter };
    const workers = await shiftWorkersFromSnapshot(snapshot);
    const perWorker = Math.floor(total / snapshot.length);
    const wagesPaid = await payShiftWorkers(offer, workers, perWorker, venueId, venue.name);
    return { shiftRegime: true, wagesPaid, venueBalanceAfter };
  }

  // Reserve once: lock the store's active shifts, stamp the settle-once guard,
  // debit the venue for the whole split, ledger it, and bump per-shift earned
  // totals — all-or-nothing. The locked re-read inside the tx is authoritative
  // (a worker clocking out concurrently either makes it into the split or not,
  // never half-way).
  const settledAt = new Date();
  let workers: ShiftWorker[] = [];
  let perWorker = 0;
  let reserved = false;
  await db.transaction(async (tx) => {
    const lockedShifts = await tx
      .select({
        shiftId: storeShifts.id,
        characterId: storeShifts.characterId,
        userId: storeShifts.userId,
      })
      .from(storeShifts)
      .where(
        and(
          eq(storeShifts.storeId, venueId),
          sql`${storeShifts.clockOutAt} IS NULL`,
          sql`${storeShifts.scheduledEndAt} > now()`,
        ),
      )
      .for("update");
    if (lockedShifts.length === 0) return; // nobody on shift → commission as usual
    perWorker = Math.floor((offer.totalPrice * cfg.pct) / 100 / lockedShifts.length);
    const totalWages = perWorker * lockedShifts.length;
    const [stamped] = await tx
      .update(saleOffers)
      .set({
        shiftWagesSettledAt: settledAt,
        shiftWagesAmount: totalWages,
        shiftWageShiftIds: lockedShifts.map((s) => s.shiftId),
      })
      .where(and(eq(saleOffers.id, offer.id), sql`${saleOffers.shiftWagesSettledAt} IS NULL`))
      .returning();
    if (!stamped) return; // concurrent run reserved first — treat as regime-active, it pays
    reserved = true;
    workers = lockedShifts.map((s) => ({ ...s, characterName: null }));
    if (totalWages <= 0) return; // regime active but floored share is 0 — nothing to move
    const [debited] = await tx
      .update(stores)
      .set({ balance: sql`${stores.balance} - ${totalWages}` })
      .where(eq(stores.id, venueId))
      .returning();
    venueBalanceAfter = debited.balance;
    await tx.insert(walletTransactions).values({
      storeId: venueId,
      counterpartyName: `${lockedShifts.length} on shift`,
      amount: -totalWages,
      kind: "shift_wage",
      source: "shift",
      memo: `Shift wages ${cfg.pct}% split ${lockedShifts.length} way${lockedShifts.length === 1 ? "" : "s"} (€$${perWorker} each)`,
      relatedEntityType: "sale_offer",
      relatedEntityId: offer.id,
      previousBalance: debited.balance + totalWages,
      newBalance: debited.balance,
    } as never);
    await tx
      .update(storeShifts)
      .set({
        earnedTotal: sql`${storeShifts.earnedTotal} + ${perWorker}`,
        salesCount: sql`${storeShifts.salesCount} + 1`,
      })
      .where(inArray(storeShifts.id, lockedShifts.map((s) => s.shiftId)));
  });

  if (!reserved) {
    // Either nobody was on shift (commission applies) or a concurrent call
    // holds the reservation (regime active; that call pays the credits).
    const [fresh] = await db
      .select({ settledAt: saleOffers.shiftWagesSettledAt })
      .from(saleOffers)
      .where(eq(saleOffers.id, offer.id));
    return { shiftRegime: !!fresh?.settledAt, wagesPaid: 0, venueBalanceAfter };
  }
  if (perWorker <= 0) return { shiftRegime: true, wagesPaid: 0, venueBalanceAfter };
  const wagesPaid = await payShiftWorkers(offer, workers, perWorker, venueId, venue.name);
  return { shiftRegime: true, wagesPaid, venueBalanceAfter };
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
  const commissionAmount = computeCommissionAmount(offer);
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

  // Retry unpaid shift wages first (independent of commission). The reserve is
  // durable on the offer row; per-worker credits are idempotent, so this only
  // re-attempts workers whose credit never synced.
  if (
    offer.kind === "store" &&
    offer.storeId &&
    offer.shiftWagesSettledAt &&
    (offer.shiftWagesAmount ?? 0) > 0 &&
    (await getEconomyMode()) === "enabled"
  ) {
    const snapshot = offer.shiftWageShiftIds ?? [];
    if (snapshot.length > 0) {
      const workers = await shiftWorkersFromSnapshot(snapshot);
      const [venueRow] = await db.select().from(stores).where(eq(stores.id, offer.storeId));
      const perWorker = Math.floor((offer.shiftWagesAmount ?? 0) / snapshot.length);
      if (venueRow && perWorker > 0) {
        await payShiftWorkers(offer, workers, perWorker, offer.storeId, venueRow.name);
      }
    }
  }
  // A wage-governed sale pays no commission — nothing further to recover.
  if (offer.shiftWagesSettledAt) return alreadyApproved;

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
