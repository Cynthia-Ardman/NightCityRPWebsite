import type { IRouter } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import { db, stores, storeEmployees, characters, storeShifts } from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { isStaffRoles as isStaff } from "../../lib/roleChecks";
import { recordAudit } from "../../lib/audit";
import { SHIFT_HOURS, expireStaleShifts } from "../../lib/shifts";
import { isVenueOperator } from "./venue-shared";

export function registerShifts(router: IRouter): void {
  // ===== Shifts (bar clock-in / wage split) =====

  // Clock in for a shift. Owner or employee only (staff have no wage stake and
  // cannot clock in on someone's behalf). One active shift per USER across all
  // venues, enforced by a partial unique index so two tabs can't double-clock.
  router.post("/stores/:id/shifts/clock-in", requireAuth, async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const [s] = await db.select().from(stores).where(eq(stores.id, id));
    if (!s) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!s.shiftsEnabled) {
      res.status(409).json({ error: "Shifts are not enabled for this venue" });
      return;
    }
    await expireStaleShifts();
    const isOwner = s.ownerId === req.user!.id;
    // Resolve the working character: an explicit body.characterId (must be the
    // caller's), else their employed character here, else the owner character.
    const myEmployed = await db
      .select({ characterId: storeEmployees.characterId })
      .from(storeEmployees)
      .innerJoin(characters, eq(characters.id, storeEmployees.characterId))
      .where(and(eq(storeEmployees.storeId, id), eq(characters.ownerId, req.user!.id)));
    const requestedCharId = Number.isInteger(req.body?.characterId) ? Number(req.body.characterId) : null;
    let characterId: number | null = null;
    if (requestedCharId != null) {
      const allowed =
        myEmployed.some((e) => e.characterId === requestedCharId) ||
        (isOwner &&
          (await db
            .select({ id: characters.id })
            .from(characters)
            .where(and(eq(characters.id, requestedCharId), eq(characters.ownerId, req.user!.id)))).length > 0);
      if (!allowed) {
        res.status(403).json({ error: "That character can't work here" });
        return;
      }
      characterId = requestedCharId;
    } else if (myEmployed.length > 0) {
      characterId = myEmployed[0].characterId;
    } else if (isOwner && s.ownerCharacterId) {
      // Ownership can be reassigned by staff without relinking ownerCharacterId;
      // never attribute a shift to a character the CURRENT owner doesn't own.
      const [ownerChar] = await db
        .select({ id: characters.id })
        .from(characters)
        .where(and(eq(characters.id, s.ownerCharacterId), eq(characters.ownerId, req.user!.id)));
      if (ownerChar) characterId = ownerChar.id;
    }
    if (characterId == null) {
      res.status(isOwner || myEmployed.length > 0 ? 400 : 403).json({
        error: isOwner ? "Pick a character to clock in as" : "Only the owner or employees can clock in",
      });
      return;
    }
    const now = new Date();
    const scheduledEndAt = new Date(now.getTime() + SHIFT_HOURS * 60 * 60 * 1000);
    const [shift] = await db
      .insert(storeShifts)
      .values({ storeId: id, characterId, userId: req.user!.id, clockInAt: now, scheduledEndAt })
      .onConflictDoNothing({
        target: [storeShifts.userId],
        where: sql`clock_out_at IS NULL`,
      })
      .returning();
    if (!shift) {
      res.status(409).json({ error: "Already clocked in (here or at another venue)" });
      return;
    }
    await recordAudit({
      req,
      category: "shop",
      action: "shift_clock_in",
      targetType: "store",
      targetId: String(id),
      message: `Clocked in at ${s.name} (shift #${shift.id})`,
      after: { shiftId: shift.id, characterId, scheduledEndAt },
    });
    res.status(201).json(shift);
  });

  // Clock out of my active shift at this venue.
  router.post("/stores/:id/shifts/clock-out", requireAuth, async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    await expireStaleShifts();
    const [shift] = await db
      .update(storeShifts)
      .set({ clockOutAt: sql`now()` })
      .where(
        and(
          eq(storeShifts.storeId, id),
          eq(storeShifts.userId, req.user!.id),
          sql`${storeShifts.clockOutAt} IS NULL`,
        ),
      )
      .returning();
    if (!shift) {
      res.status(404).json({ error: "No active shift here" });
      return;
    }
    await recordAudit({
      req,
      category: "shop",
      action: "shift_clock_out",
      targetType: "store",
      targetId: String(id),
      message: `Clocked out (shift #${shift.id}, earned €$${shift.earnedTotal})`,
      after: { shiftId: shift.id, earnedTotal: shift.earnedTotal, salesCount: shift.salesCount },
    });
    res.json(shift);
  });

  // My active shift anywhere (for the "on shift" badge). 200 with null when off.
  router.get("/shifts/me", requireAuth, async (req, res): Promise<void> => {
    await expireStaleShifts();
    const [shift] = await db
      .select({
        id: storeShifts.id,
        storeId: storeShifts.storeId,
        storeName: stores.name,
        characterId: storeShifts.characterId,
        characterName: characters.name,
        clockInAt: storeShifts.clockInAt,
        scheduledEndAt: storeShifts.scheduledEndAt,
        earnedTotal: storeShifts.earnedTotal,
        salesCount: storeShifts.salesCount,
      })
      .from(storeShifts)
      .innerJoin(stores, eq(stores.id, storeShifts.storeId))
      .leftJoin(characters, eq(characters.id, storeShifts.characterId))
      .where(and(eq(storeShifts.userId, req.user!.id), sql`${storeShifts.clockOutAt} IS NULL`));
    res.json({ shift: shift ?? null });
  });

  // Shift report for a venue. Owners/staff see every worker's shifts; employees
  // see the currently-active crew plus their own history.
  router.get("/stores/:id/shifts", requireAuth, async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    const [s] = await db.select().from(stores).where(eq(stores.id, id));
    if (!s) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const manages = s.ownerId === req.user!.id || isStaff(req.user!.roles);
    if (!manages && !(await isVenueOperator("store", s, id, req.user!))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    await expireStaleShifts(id);
    const rows = await db
      .select({
        id: storeShifts.id,
        characterId: storeShifts.characterId,
        characterName: characters.name,
        userId: storeShifts.userId,
        clockInAt: storeShifts.clockInAt,
        scheduledEndAt: storeShifts.scheduledEndAt,
        clockOutAt: storeShifts.clockOutAt,
        earnedTotal: storeShifts.earnedTotal,
        salesCount: storeShifts.salesCount,
      })
      .from(storeShifts)
      .leftJoin(characters, eq(characters.id, storeShifts.characterId))
      .where(eq(storeShifts.storeId, id))
      .orderBy(desc(storeShifts.clockInAt))
      .limit(200);
    const visible = manages ? rows : rows.filter((r) => r.clockOutAt === null || r.userId === req.user!.id);
    res.json({
      shifts: visible,
      totals: manages
        ? {
            wagesPaid: rows.reduce((a, r) => a + r.earnedTotal, 0),
            sales: rows.reduce((a, r) => a + r.salesCount, 0),
          }
        : undefined,
    });
  });
}
