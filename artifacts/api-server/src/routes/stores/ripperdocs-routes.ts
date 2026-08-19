import type { IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
  ripperdocs,
  ripperdocEmployees,
  ripperdocStock,
  characters,
  auditLog,
} from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { reconcileBusinessChannelAccess } from "../../lib/businessChannelAccess";
import { logger } from "../../lib/logger";
import { isStaffRoles as isStaff } from "../../lib/roleChecks";
import {
  auditMeta,
  loadManageableRipperdoc,
  loadVenueLease,
  buildDiff,
  resolveLeaseAssociation,
  createEmployeeInvite,
  createVenueStockRequest,
  patchVenueEmployee,
} from "./venue-shared";

export function registerRipperdocs(router: IRouter): void {
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
      .select({ id: ripperdocEmployees.id, characterId: characters.id, name: characters.name, role: ripperdocEmployees.role, commissionPct: ripperdocEmployees.commissionPct, ownerId: characters.ownerId })
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
    const lease = await loadVenueLease(r.housingId);
    res.json({ ...r, employees: emps.map(({ ownerId: _o, ...e }) => e), stock, lease });
  });

  router.patch("/ripperdocs/:id", requireAuth, async (req, res): Promise<void> => {
    const r = await loadManageableRipperdoc(req, res);
    if (!r) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = ["name", "purpose", "location", "description", "bannerUrl", "ownerCharacterId"];
    if (isStaff(req.user!.roles)) fields.push("ownerId", "housingId");
    const { patch, before, after } = buildDiff(r as unknown as Record<string, unknown>, body, fields);
    const leaseErr = await resolveLeaseAssociation(r, patch, before, after);
    if (leaseErr) {
      res.status(400).json({ error: leaseErr });
      return;
    }
    if (Object.keys(patch).length === 0) {
      res.json({ ...r, lease: await loadVenueLease(r.housingId) });
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
    // See store transfer above — keep business-owners channel access in sync.
    if ("ownerId" in patch) {
      void reconcileBusinessChannelAccess().catch((err) =>
        logger.warn({ err, ripperdocId: r.id }, "business channel access reconcile (ripperdoc transfer) failed"),
      );
    }
    res.json({ ...updated, lease: await loadVenueLease(updated.housingId) });
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
    // The former owner loses access unless they still own another business.
    void reconcileBusinessChannelAccess().catch((err) =>
      logger.warn({ err, ripperdocId: r.id }, "business channel access reconcile (ripperdoc delete) failed"),
    );
    res.sendStatus(204);
  });

  router.post("/ripperdocs/:id/employees", requireAuth, async (req, res): Promise<void> => {
    const r = await loadManageableRipperdoc(req, res);
    if (!r) return;
    await createEmployeeInvite({ req, res, kind: "ripperdoc", venueId: r.id, venueName: r.name });
  });

  // Ripperdoc owner requests a custom (off-catalog) item be stocked → fixer vote.
  router.post("/ripperdocs/:id/request-stock", requireAuth, async (req, res): Promise<void> => {
    const r = await loadManageableRipperdoc(req, res);
    if (!r) return;
    await createVenueStockRequest({ req, res, kind: "ripperdoc", venue: r });
  });

  // Edit an employee's role and/or commission percentage. Owner or staff.
  router.patch("/ripperdocs/:id/employees/:employeeId", requireAuth, async (req, res): Promise<void> => {
    const r = await loadManageableRipperdoc(req, res);
    if (!r) return;
    await patchVenueEmployee({
      req,
      res,
      table: ripperdocEmployees,
      venueCol: ripperdocEmployees.ripperdocId,
      venueId: r.id,
      employeeId: parseInt(String(req.params.employeeId), 10),
      targetType: "ripperdoc",
      action: "ripperdoc_employee_update",
    });
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
    const { name, category, price, cost, quantity, notes, slot, cwp, description } = req.body ?? {};
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name required" });
      return;
    }
    if (typeof slot !== "string" || !slot.trim()) {
      res.status(400).json({ error: "slot required" });
      return;
    }
    const cleanPrice = Math.max(0, Math.round(Number(price) || 0));
    const cleanCost = Math.max(0, Math.round(Number(cost) || 0));
    const cleanQty = Math.max(0, Math.round(Number(quantity) || 0));
    // Encode cyberware slot + CWP into notes using the importer/parseCwp
    // convention ("CWP <n> · Slot: <slot>") so downstream CWP derivation keeps
    // working. An explicit `notes` body field wins if provided.
    let finalNotes: string | null = typeof notes === "string" && notes.trim() ? notes.trim() : null;
    if (finalNotes === null) {
      const parts: string[] = [];
      const cwpNum = cwp != null && cwp !== "" ? Math.max(0, Math.round(Number(cwp))) : null;
      if (cwpNum != null && Number.isFinite(cwpNum)) parts.push(`CWP ${cwpNum}`);
      parts.push(`Slot: ${slot.trim()}`);
      finalNotes = parts.join(" · ");
    }
    const { ip, ua } = auditMeta(req);
    // Insert + audit atomically so a manual stock add can never land without an
    // audit trail (the task requires every manual add be logged).
    const it = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(ripperdocStock)
        .values({
          ripperdocId: r.id,
          name: name.trim(),
          category: typeof category === "string" && category.trim() ? category.trim() : null,
          price: cleanPrice,
          cost: cleanCost,
          quantity: cleanQty,
          notes: finalNotes,
          description: typeof description === "string" && description.trim() ? description.trim() : null,
        })
        .returning();
      await tx.insert(auditLog).values({
        category: "shop",
        action: "ripperdoc_stock_add",
        actorId: req.user?.id ?? null,
        actorName: req.user?.username ?? null,
        actorIp: ip,
        actorUa: ua,
        targetType: "ripperdoc",
        targetId: String(r.id),
        message: `Manually added "${row.name}" x${row.quantity} to ${r.name} cyberware stock`,
        afterJson: row as never,
      });
      return row;
    });
    res.status(201).json(it);
  });

  router.patch("/ripperdocs/:id/stock/:stockId", requireAuth, async (req, res): Promise<void> => {
    const r = await loadManageableRipperdoc(req, res);
    if (!r) return;
    const stockId = parseInt(String(req.params.stockId), 10);
    const { name, category, price, cost, quantity, notes, description } = req.body ?? {};
    const patch: Record<string, unknown> = {
      ...(name !== undefined ? { name } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(price !== undefined ? { price: Math.max(0, Math.round(Number(price) || 0)) } : {}),
      ...(cost !== undefined ? { cost: Math.max(0, Math.round(Number(cost) || 0)) } : {}),
      ...(quantity !== undefined ? { quantity: Math.max(0, Math.round(Number(quantity) || 0)) } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(description !== undefined ? { description } : {}),
    };
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "No changes" });
      return;
    }
    const { ip, ua } = auditMeta(req);
    // Capture the before-row and write the audit in the same transaction so a
    // manual stock edit can never land without a trail (mirrors the store path).
    const result = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(ripperdocStock)
        .where(and(eq(ripperdocStock.id, stockId), eq(ripperdocStock.ripperdocId, r.id)));
      if (!before) return null;
      const [u] = await tx
        .update(ripperdocStock)
        .set(patch)
        .where(and(eq(ripperdocStock.id, stockId), eq(ripperdocStock.ripperdocId, r.id)))
        .returning();
      await tx.insert(auditLog).values({
        category: "shop",
        action: "ripperdoc_stock_edit",
        actorId: req.user?.id ?? null,
        actorName: req.user?.username ?? null,
        actorIp: ip,
        actorUa: ua,
        targetType: "ripperdoc",
        targetId: String(r.id),
        message: `Edited cyberware stock "${u.name}" in ${r.name}`,
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

  router.delete("/ripperdocs/:id/stock/:stockId", requireAuth, async (req, res): Promise<void> => {
    const r = await loadManageableRipperdoc(req, res);
    if (!r) return;
    const stockId = parseInt(String(req.params.stockId), 10);
    await db.delete(ripperdocStock).where(and(eq(ripperdocStock.id, stockId), eq(ripperdocStock.ripperdocId, r.id)));
    res.sendStatus(204);
  });
}
