import type { IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
  stores,
  storeEmployees,
  storeStock,
  characters,
  auditLog,
  housing,
  catalogRent,
} from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { reconcileBusinessChannelAccess } from "../../lib/businessChannelAccess";
import { logger } from "../../lib/logger";
import { isStaffRoles as isStaff } from "../../lib/roleChecks";
import {
  auditMeta,
  clampPct,
  loadManageableStore,
  loadVenueLease,
  buildDiff,
  resolveLeaseAssociation,
  createEmployeeInvite,
} from "./venue-shared";

export function registerBusinessLeases(router: IRouter): void {
  // Staff-only: every business lease, with its building and tenant, so a fixer/
  // admin can associate a venue with a specific lease from the management page.
  router.get("/business-leases", requireAuth, async (req, res): Promise<void> => {
    if (!isStaff(req.user!.roles)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const rows = await db
      .select({
        id: housing.id,
        address: housing.address,
        monthlyRent: housing.monthlyRent,
        listingId: housing.listingId,
        characterId: housing.characterId,
        characterName: characters.name,
        district: catalogRent.district,
        tier: catalogRent.tier,
      })
      .from(housing)
      .leftJoin(characters, eq(characters.id, housing.characterId))
      .leftJoin(catalogRent, eq(catalogRent.id, housing.listingId))
      .where(eq(housing.kind, "business"))
      .orderBy(housing.address);
    res.json(rows);
  });
}

export function registerStores(router: IRouter): void {
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
      .select({ id: storeEmployees.id, characterId: characters.id, name: characters.name, role: storeEmployees.role, commissionPct: storeEmployees.commissionPct, ownerId: characters.ownerId })
      .from(storeEmployees)
      .innerJoin(characters, eq(characters.id, storeEmployees.characterId))
      .where(eq(storeEmployees.storeId, id));
    const isOwner = s.ownerId === req.user!.id;
    const isEmployee = emps.some((e) => e.ownerId === req.user!.id);
    if (!isOwner && !isStaff(req.user!.roles) && !isEmployee) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const stock = await db.select().from(storeStock).where(eq(storeStock.storeId, id));
    const lease = await loadVenueLease(s.housingId);
    res.json({ ...s, employees: emps.map(({ ownerId: _o, ...e }) => e), stock, lease });
  });

  router.patch("/stores/:id", requireAuth, async (req, res): Promise<void> => {
    const s = await loadManageableStore(req, res);
    if (!s) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Only staff may reassign ownership (to another user). Owners cannot hand
    // their venue to someone else through the edit form.
    const fields = ["name", "kind", "purpose", "location", "description", "bannerUrl", "ownerCharacterId"];
    // Wage split % — owner or staff (loadManageableStore already gates). Clamp
    // to an integer 0-100 like commission percentages.
    if (body.shiftWagePct !== undefined) {
      body.shiftWagePct = clampPct(body.shiftWagePct);
      fields.push("shiftWagePct");
    }
    if (isStaff(req.user!.roles)) {
      fields.push("ownerId", "housingId");
      // Only staff may turn the shift system on/off for a venue.
      if (body.shiftsEnabled !== undefined) {
        body.shiftsEnabled = body.shiftsEnabled === true;
        fields.push("shiftsEnabled");
      }
    } else if (body.shiftsEnabled !== undefined) {
      res.status(403).json({ error: "Only staff can enable or disable shifts" });
      return;
    }
    const { patch, before, after } = buildDiff(s as unknown as Record<string, unknown>, body, fields);
    const leaseErr = await resolveLeaseAssociation(s, patch, before, after);
    if (leaseErr) {
      res.status(400).json({ error: leaseErr });
      return;
    }
    if (Object.keys(patch).length === 0) {
      res.json({ ...s, lease: await loadVenueLease(s.housingId) });
      return;
    }
    const { ip, ua } = auditMeta(req);
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx.update(stores).set(patch).where(eq(stores.id, s.id)).returning();
      await tx.insert(auditLog).values({
        category: "shop",
        action: "store_update",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "store",
        targetId: String(s.id),
        message: `Edited store "${u.name}"`,
        beforeJson: before as never,
        afterJson: after as never,
      });
      return u;
    });
    // Ownership transfer changes who should hold business-owners channel access:
    // grant the new owner, revoke the old one if they no longer own any business.
    if ("ownerId" in patch) {
      void reconcileBusinessChannelAccess().catch((err) =>
        logger.warn({ err, storeId: s.id }, "business channel access reconcile (store transfer) failed"),
      );
    }
    res.json({ ...updated, lease: await loadVenueLease(updated.housingId) });
  });

  // Delete a store. Owner or staff. The FK cascade on store_employees /
  // store_stock removes the venue's staff and inventory; the delete + audit run
  // in one transaction so the trail can't drift from the deletion.
  router.delete("/stores/:id", requireAuth, async (req, res): Promise<void> => {
    const s = await loadManageableStore(req, res);
    if (!s) return;
    const { ip, ua } = auditMeta(req);
    await db.transaction(async (tx) => {
      await tx.delete(stores).where(eq(stores.id, s.id));
      await tx.insert(auditLog).values({
        category: "shop",
        action: "store_delete",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorIp: ip,
        actorUa: ua,
        targetType: "store",
        targetId: String(s.id),
        message: `Deleted store "${s.name}"`,
        beforeJson: s as never,
        afterJson: null,
      });
    });
    // The former owner loses business-owners channel access unless they still own
    // another business (the reconcile only revokes when they own none).
    void reconcileBusinessChannelAccess().catch((err) =>
      logger.warn({ err, storeId: s.id }, "business channel access reconcile (store delete) failed"),
    );
    res.sendStatus(204);
  });

  router.post("/stores/:id/employees", requireAuth, async (req, res): Promise<void> => {
    const s = await loadManageableStore(req, res);
    if (!s) return;
    await createEmployeeInvite({ req, res, kind: "store", venueId: s.id, venueName: s.name });
  });
}
