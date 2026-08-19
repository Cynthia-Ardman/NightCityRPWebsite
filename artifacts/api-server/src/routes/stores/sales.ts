import type { IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, ripperdocs, characters, inventoryItems } from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { createOffer, createRemoveOffer, createInstallOwnedOffer, createServiceBillOffer } from "../../lib/saleOffers";
import { cwpForItem, parseCwp } from "../../lib/cyberware";
import { checkCwpCapacity } from "../../lib/cyberware-cap";
import { isVenueOperator } from "./venue-shared";

export function registerSales(router: IRouter): void {
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
  // stays in the player's inventory by default ("patient"), just no longer
  // counted as CWP — or, with destination "clinic", moves into the clinic's stock.
  router.post("/ripperdocs/:id/remove", requireAuth, async (req, res): Promise<void> => {
    const venueId = parseInt(String(req.params.id), 10);
    const { removedItemId, buyerCharacterId, fee, memo, destination } = req.body ?? {};
    if (!removedItemId || !buyerCharacterId) {
      res.status(400).json({ error: "removedItemId and buyerCharacterId required" });
      return;
    }
    if (destination != null && destination !== "patient" && destination !== "clinic") {
      res.status(400).json({ error: "destination must be 'patient' or 'clinic'" });
      return;
    }
    const result = await createRemoveOffer({
      venueId,
      removedItemId: parseInt(String(removedItemId), 10),
      buyerCharacterId: parseInt(String(buyerCharacterId), 10),
      fee: fee != null ? Math.max(0, Number(fee) || 0) : null,
      memo,
      destination: destination ?? null,
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
    // "Uninstalled" = chrome the player owns but hasn't had fitted (no CWP tag).
    // These are the candidates the clinic console can install via install_owned.
    const uninstalled = cyberRows.filter((it) => parseCwp(it.notes) == null);
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
      uninstalled: uninstalled.map((it) => ({ id: it.id, name: it.name, quantity: it.quantity, notes: it.notes })),
    });
  });

  // Install a cyberware piece the patient ALREADY owns (an uninstalled inventory
  // item) onto their character. Leaves a PENDING offer the player confirms from
  // their Inbox; an optional install fee is charged on approval. See
  // lib/saleOffers.ts createInstallOwnedOffer for the validation + completion.
  router.post("/ripperdocs/:id/install-owned", requireAuth, async (req, res): Promise<void> => {
    const venueId = parseInt(String(req.params.id), 10);
    const { installItemId, buyerCharacterId, price, cwp, memo } = req.body ?? {};
    if (!installItemId || !buyerCharacterId) {
      res.status(400).json({ error: "installItemId and buyerCharacterId required" });
      return;
    }
    const result = await createInstallOwnedOffer({
      venueId,
      installItemId: parseInt(String(installItemId), 10),
      buyerCharacterId: parseInt(String(buyerCharacterId), 10),
      fee: price != null ? Math.max(0, Number(price) || 0) : null,
      cwp: cwp != null ? Math.max(0, Number(cwp) || 0) : null,
      memo,
      actor: req.user!,
    });
    res.status(result.status).json(result.body);
  });

  // Send a freeform service bill to a character (repair, patch-up, etc). Leaves
  // a PENDING offer the player approves from their Inbox; approving debits their
  // wallet and credits the clinic account. See lib/saleOffers.ts
  // createServiceBillOffer.
  router.post("/ripperdocs/:id/bill", requireAuth, async (req, res): Promise<void> => {
    const venueId = parseInt(String(req.params.id), 10);
    const { buyerCharacterId, amount, note } = req.body ?? {};
    if (!buyerCharacterId || amount == null || !note) {
      res.status(400).json({ error: "buyerCharacterId, amount and note required" });
      return;
    }
    // Coerce and reject malformed numbers here so bad payloads get a
    // deterministic 400 instead of NaN leaking into DB lookups.
    const charId = Number(buyerCharacterId);
    const amt = Number(amount);
    if (!Number.isInteger(charId) || charId <= 0 || !Number.isFinite(amt)) {
      res.status(400).json({ error: "buyerCharacterId and amount must be numbers" });
      return;
    }
    const result = await createServiceBillOffer({
      venueId,
      buyerCharacterId: charId,
      amount: amt,
      note: String(note),
      actor: req.user!,
    });
    res.status(result.status).json(result.body);
  });
}
