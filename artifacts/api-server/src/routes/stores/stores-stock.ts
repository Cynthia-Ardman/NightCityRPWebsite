import type { IRouter } from "express";
import { eq, and, desc, sql, notInArray } from "drizzle-orm";
import {
  db,
  stores,
  storeEmployees,
  storeStock,
  characters,
  auditLog,
  users,
  customRequests,
} from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { logger } from "../../lib/logger";
import { isStaffRoles as isStaff } from "../../lib/roleChecks";
import { announceRequest, sanitizeImageUrls } from "../requests";
import {
  auditMeta,
  loadManageableStore,
  isVenueOperator,
  patchVenueEmployee,
  createVenueStockRequest,
  shapeCustomRequest,
} from "./venue-shared";

export function registerStoresStock(router: IRouter): void {
  // Store owner requests a custom (off-catalog) item be stocked → fixer vote.
  router.post("/stores/:id/request-stock", requireAuth, async (req, res): Promise<void> => {
    const s = await loadManageableStore(req, res);
    if (!s) return;
    await createVenueStockRequest({ req, res, kind: "store", venue: s });
  });

  // Gun-store operator (owner, employee, or staff) submits a CUSTOM GUN request:
  // a new weapon the store wants fabricated, with proposed mechanical specs and
  // an optional named buyer + sale price. Goes to the fixer review queue as a
  // `gun` custom request; on approve+close the weapon materializes into THIS
  // STORE's stock, and (buyer + price set) a pending sale offer lands in the
  // buyer's Inbox. Gun stores only — their catalog is regulated, and this is the
  // fixer-approved path for operators to expand it.
  router.post("/stores/:id/gun-requests", requireAuth, async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const [s] = await db.select().from(stores).where(eq(stores.id, id));
    if (!s) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (s.kind !== "guns") {
      res.status(400).json({ error: "Only gun stores can submit custom gun requests" });
      return;
    }
    if (!(await isVenueOperator("store", s, s.id, req.user!))) {
      res.status(403).json({ error: "Not authorized to operate this store" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!name || !description) {
      res.status(400).json({ error: "name and description required" });
      return;
    }
    // Proposed mechanical specs. All optional at submit — the fixers confirm (or
    // override) them at CLOSE & APPLY — but whatever the operator supplies is
    // carried on details.specs and pre-fills the close dialog.
    const specStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const specs: Record<string, string> = {};
    for (const key of ["category", "weaponType", "fireMode", "powerLevel", "manufacturer"] as const) {
      const v = specStr(body[key]);
      if (v) specs[key] = v;
    }

    // Optional named buyer: must be a live, claimed character (we'll need a
    // wallet to charge on offer approval).
    let buyer: { id: number; name: string; ownerId: string } | null = null;
    if (body.buyerCharacterId != null && body.buyerCharacterId !== "") {
      const bid = parseInt(String(body.buyerCharacterId), 10);
      const [c] = await db.select().from(characters).where(eq(characters.id, bid));
      if (!c) {
        res.status(404).json({ error: "Buyer character not found" });
        return;
      }
      if (c.archived) {
        res.status(400).json({ error: "Buyer character is archived" });
        return;
      }
      if (!c.ownerId) {
        res.status(409).json({ error: "Buyer character is unclaimed" });
        return;
      }
      buyer = { id: c.id, name: c.name, ownerId: c.ownerId };
    }
    // Optional sale price (required for the auto-offer; without it the gun just
    // lands in stock). int4 columns cap money — mirror requests.ts MAX_MONEY.
    let salePrice: number | null = null;
    if (body.salePrice != null && body.salePrice !== "") {
      const p = Math.round(Number(body.salePrice));
      if (!Number.isFinite(p) || p < 0) {
        res.status(400).json({ error: "salePrice must be a non-negative number" });
        return;
      }
      salePrice = Math.min(p, 2_000_000_000);
    }

    // Attribute the request to the buyer character when named (so the buyer sees
    // it on My Submissions), else the store owner's character (mirrors
    // createVenueStockRequest — custom_requests.characterId is NOT NULL).
    let characterId = buyer?.id ?? s.ownerCharacterId ?? null;
    if (!characterId) {
      const [owned] = await db
        .select({ id: characters.id })
        .from(characters)
        .where(eq(characters.ownerId, s.ownerId))
        .limit(1);
      characterId = owned?.id ?? null;
    }
    if (!characterId) {
      res.status(400).json({ error: "No owner character to attribute this request to" });
      return;
    }

    const cleanedImages = sanitizeImageUrls(body.imageUrls, body.imageUrl);
    const [inserted] = await db
      .insert(customRequests)
      .values({
        type: "gun",
        characterId,
        requestedById: req.user!.id,
        title: name,
        description,
        imageUrl: cleanedImages[0] ?? null,
        imageUrls: cleanedImages,
        details: {
          storeId: s.id,
          storeName: s.name,
          ...(Object.keys(specs).length > 0 ? { specs } : {}),
          ...(buyer ? { buyerCharacterId: buyer.id, buyerCharacterName: buyer.name } : {}),
          ...(salePrice != null ? { salePrice } : {}),
        } as never,
      })
      .returning();
    // Announce to cs-approver + open the thread mirror — required at every
    // custom-request insert site (fire-and-forget, deployment-gated).
    const submitterName = req.user!.username;
    void (async () => {
      const [charRow] = await db
        .select({ name: characters.name })
        .from(characters)
        .where(eq(characters.id, inserted.characterId))
        .limit(1);
      await announceRequest(inserted.id, "gun", name, charRow?.name ?? "(unknown)", submitterName);
    })().catch((err) => logger.warn({ err, requestId: inserted.id }, "store gun request announce failed"));
    res.status(201).json(shapeCustomRequest(inserted));
  });

  // Operator-visible list of open/in-flight custom gun requests for this store.
  // Gated on isVenueOperator (owner | staff | employee) so the whole crew stays
  // informed — not just the individual submitter who sees it under My Submissions.
  // Terminal statuses (approved / rejected / closed / cancelled) are excluded to
  // match the CatalogRequestSection "Your Requests" banner pattern.
  router.get("/stores/:id/gun-requests", requireAuth, async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const [s] = await db.select().from(stores).where(eq(stores.id, id));
    if (!s) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!(await isVenueOperator("store", s, s.id, req.user!))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const TERMINAL = ["approved", "rejected", "closed", "cancelled"];
    const rows = await db
      .select({
        id: customRequests.id,
        title: customRequests.title,
        status: customRequests.status,
        createdAt: customRequests.createdAt,
        requestedById: customRequests.requestedById,
        requestedByName: users.username,
      })
      .from(customRequests)
      .leftJoin(users, eq(users.id, customRequests.requestedById))
      .where(
        and(
          eq(customRequests.type, "gun"),
          sql`${customRequests.details}->>'storeId' = ${String(id)}`,
          notInArray(customRequests.status, TERMINAL),
        ),
      )
      .orderBy(desc(customRequests.createdAt));
    res.json(
      rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        requestedById: r.requestedById,
        requestedByName: r.requestedByName ?? null,
      })),
    );
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
    // Gun stores carry a regulated catalog — their OWNERS may not add or edit
    // stock; only staff (admin/fixer) can. Other store kinds stay owner-editable.
    if (s.kind === "guns" && !isStaff(req.user!.roles)) {
      res.status(403).json({ error: "Gun store stock is managed by staff only" });
      return;
    }
    const { name, category, price, cost, quantity, notes, description, powerLevel, cyberwareReq } = req.body ?? {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name required" });
      return;
    }
    const cleanPrice = Math.max(0, Math.round(Number(price) || 0));
    const cleanCost = Math.max(0, Math.round(Number(cost) || 0));
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
          cost: cleanCost,
          quantity: cleanQty,
          notes: notes ?? null,
          description: typeof description === "string" && description.trim() ? description.trim() : null,
          powerLevel: typeof powerLevel === "string" && powerLevel.trim() ? powerLevel.trim() : null,
          cyberwareReq:
            typeof cyberwareReq === "string" && cyberwareReq.trim() ? cyberwareReq.trim() : null,
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
    // Gun store stock is staff-managed only (see POST above for the rationale).
    if (s.kind === "guns" && !isStaff(req.user!.roles)) {
      res.status(403).json({ error: "Gun store stock is managed by staff only" });
      return;
    }
    const stockId = parseInt(String(req.params.stockId), 10);
    const { name, category, price, cost, quantity, notes, description, powerLevel, cyberwareReq } = req.body ?? {};
    const patch: Record<string, unknown> = {
      ...(name !== undefined ? { name } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(price !== undefined ? { price: Math.max(0, Math.round(Number(price) || 0)) } : {}),
      ...(cost !== undefined ? { cost: Math.max(0, Math.round(Number(cost) || 0)) } : {}),
      ...(quantity !== undefined ? { quantity: Math.max(0, Math.round(Number(quantity) || 0)) } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(powerLevel !== undefined
        ? { powerLevel: typeof powerLevel === "string" && powerLevel.trim() ? powerLevel.trim() : null }
        : {}),
      ...(cyberwareReq !== undefined
        ? { cyberwareReq: typeof cyberwareReq === "string" && cyberwareReq.trim() ? cyberwareReq.trim() : null }
        : {}),
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
}
