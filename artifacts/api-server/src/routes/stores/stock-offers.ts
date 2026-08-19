import type { IRouter } from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../../middlewares/auth";
import { hasRole } from "../../lib/discord";
import { createStockAddOffer, createPlayerSellOffer } from "../../lib/saleOffers";

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

// Player-initiated: offer an item from one of my characters' inventories to a
// venue. The venue owner approves/denies at /inbox; on approval the venue
// account pays the player and the item moves into venue stock.
async function createSellItemOffer(req: Request, res: Response, kind: "store" | "ripperdoc"): Promise<void> {
  const venueId = parseInt(String(req.params.id), 10);
  const { inventoryItemId, unitPrice, quantity, memo } = req.body ?? {};
  const itemId = parseInt(String(inventoryItemId), 10);
  if (!Number.isInteger(venueId) || !Number.isInteger(itemId)) {
    res.status(400).json({ error: "inventoryItemId is required" });
    return;
  }
  const result = await createPlayerSellOffer({
    kind,
    venueId,
    inventoryItemId: itemId,
    unitPrice: Number(unitPrice) || 0,
    quantity: Math.max(1, Number(quantity) || 1),
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

export function registerStockOffers(router: IRouter): void {
  router.post("/stores/:id/stock-offer", requireAuth, (req, res) => createStockOffer(req, res, "store"));
  router.post("/ripperdocs/:id/stock-offer", requireAuth, (req, res) => createStockOffer(req, res, "ripperdoc"));

  router.post("/stores/:id/sell-item", requireAuth, (req, res) => createSellItemOffer(req, res, "store"));
  router.post("/ripperdocs/:id/sell-item", requireAuth, (req, res) => createSellItemOffer(req, res, "ripperdoc"));
}
