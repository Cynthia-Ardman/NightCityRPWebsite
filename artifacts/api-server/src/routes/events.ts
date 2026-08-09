import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, events, type EventRecurrenceRule } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole } from "../lib/discord";
import { recordAudit } from "../lib/audit";
import {
  listEvents,
  getEventDetail,
  createEvent,
  updateEvent,
  splitEventOccurrence,
  cancelEvent,
  signUpAsEventNpc,
  withdrawEventNpcSignup,
  confirmEventNpcSignup,
  checkEventConflict,
  isEventType,
  convertMissionToEvent,
  type EventViewer,
} from "../lib/eventsService";
import {
  isTicketPayoutMode,
  parseTicketTypeInputs,
  upsertTicketTypes,
  purchaseTicket,
  refundTicket,
  refundAllForCancelledEvent,
  retryTicketPayout,
  setTicketAttendance,
  listEventTickets,
  listMyTickets,
  listCheckinStaff,
  setCheckinStaff,
  isCheckinStaff,
} from "../lib/eventTicketsService";

const router: IRouter = Router();

function viewerOf(req: Request): EventViewer {
  const u = req.user;
  // Anonymous viewer (public calendar): no id matches any signup/ticket, no
  // manager fields. Only the two public GET routes reach here without a user.
  if (!u) return { id: "", isManager: false, isAdmin: false };
  const isAdmin = hasRole(u.roles, "ADMIN");
  return { id: u.id, isManager: isAdmin || hasRole(u.roles, "FIXER"), isAdmin };
}

function isManager(req: Request): boolean {
  const roles = req.user?.roles ?? [];
  return hasRole(roles, "ADMIN") || hasRole(roles, "FIXER");
}

function parseDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function eventIdParam(req: Request, res: Response): number | null {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return id;
}

// PUBLIC (no auth): the calendar is visible to logged-out visitors so they can
// see what's happening before joining. listEvents exposes no viewer-specific
// or manager-only data for an anonymous viewer.
router.get("/events", async (req, res): Promise<void> => {
  const limit = Math.min(1000, parseInt(String(req.query.limit ?? "500"), 10) || 500);
  res.json(await listEvents(viewerOf(req), { limit }));
});

// --------- SPECIFIC ROUTES (must precede /events/:id) ---------

// Overlap check against existing Discord scheduled events, so a fixer creating
// an event can see whether one already exists at that time (avoid duplicates).
router.get("/events/conflicts", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const startAt = parseDate(req.query.startAt);
  const endAt = parseDate(req.query.endAt);
  if (!startAt || !endAt) {
    res.status(400).json({ error: "Valid startAt and endAt are required" });
    return;
  }
  const excludeEventId = typeof req.query.excludeEventId === "string" ? req.query.excludeEventId : null;
  res.json(await checkEventConflict({ startAt, endAt, excludeEventId }));
});

// PUBLIC (no auth): event detail backs the public calendar's chip links.
// Manager-only fields (roster, sync errors) stay null for anonymous viewers.
router.get("/events/:id", async (req, res): Promise<void> => {
  const id = eventIdParam(req, res);
  if (id == null) return;
  // Optional occurrence deep link (?occurrenceStartAt=ISO) for recurring
  // events: scopes date display + NPC roster to that occurrence.
  let occurrenceStartAt: Date | null = null;
  const rawOcc = req.query.occurrenceStartAt;
  if (typeof rawOcc === "string" && rawOcc) {
    occurrenceStartAt = new Date(rawOcc);
    if (Number.isNaN(occurrenceStartAt.getTime())) {
      res.status(400).json({ error: "occurrenceStartAt must be a valid ISO date-time" });
      return;
    }
  }
  const detail = await getEventDetail(id, viewerOf(req), occurrenceStartAt);
  if (!detail) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  res.json(detail);
});

function parseBody(b: Record<string, unknown>) {
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const eventType = isEventType(b.eventType) ? b.eventType : "social";
  const location = typeof b.location === "string" && b.location.trim() ? b.location.trim() : null;
  const description = typeof b.description === "string" && b.description.trim() ? b.description.trim() : null;
  const imageUrl = typeof b.imageUrl === "string" && b.imageUrl.trim() ? b.imageUrl.trim() : null;
  const needsNpcs = b.needsNpcs === true;
  const npcBlurb = typeof b.npcBlurb === "string" && b.npcBlurb.trim() ? b.npcBlurb.trim() : null;
  return { title, eventType, location, description, imageUrl, needsNpcs, npcBlurb };
}

/**
 * Parse and validate an inbound recurrenceRule value. Returns:
 *   - An EventRecurrenceRule object when valid (frequency=2/weekly, interval 1-52).
 *   - null when explicitly cleared.
 *   - undefined when not provided in the request (leave existing rule alone).
 *   - { error: string } when the value is present but invalid.
 */
function parseRecurrenceRuleInput(
  raw: unknown,
  key: string,
): EventRecurrenceRule | null | undefined | { error: string } {
  if (!(key in (raw as Record<string, unknown>))) return undefined;
  const v = (raw as Record<string, unknown>)[key];
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) {
    return { error: "recurrenceRule must be null or an object with frequency and interval" };
  }
  const r = v as Record<string, unknown>;
  const frequency = typeof r.frequency === "number" ? r.frequency : NaN;
  const interval = typeof r.interval === "number" ? Math.floor(r.interval) : NaN;
  if (frequency !== 2) {
    return { error: "recurrenceRule.frequency must be 2 (weekly — the only supported value)" };
  }
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
    return { error: "recurrenceRule.interval must be an integer between 1 and 52" };
  }
  // byWeekday, count, until are intentionally ignored from input — the rule
  // anchors to the start time's weekday and runs open-ended.
  return { frequency: 2, interval, byWeekday: null, count: null, until: null };
}

router.post("/events", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const b = req.body ?? {};
  const parsed = parseBody(b);
  if (!parsed.title) {
    res.status(400).json({ error: "Title is required" });
    return;
  }
  const startAt = parseDate(b.startAt);
  const endAt = parseDate(b.endAt);
  if (!startAt || !endAt) {
    res.status(400).json({ error: "Valid start and end times are required" });
    return;
  }
  if (endAt.getTime() <= startAt.getTime()) {
    res.status(400).json({ error: "End time must be after start time" });
    return;
  }
  // Recurrence rule (optional; null = no recurrence).
  const recurrenceRuleResult = parseRecurrenceRuleInput(b, "recurrenceRule");
  if (recurrenceRuleResult && typeof recurrenceRuleResult === "object" && "error" in recurrenceRuleResult) {
    res.status(400).json({ error: recurrenceRuleResult.error });
    return;
  }
  const recurrenceRule = recurrenceRuleResult as EventRecurrenceRule | null | undefined;
  // Main Sessions are deliberately discrete weekly rows, never recurrence
  // series (see main-sessions-discrete) — mirror the portal's disabled Repeat
  // control server-side so a direct API call can't create a recurring session.
  if (parsed.eventType === "session" && recurrenceRule) {
    res.status(400).json({ error: "Main Session events cannot be recurring — create discrete weekly events instead" });
    return;
  }
  // Ticket configuration (optional).
  const ticketPayoutMode = isTicketPayoutMode(b.ticketPayoutMode) ? b.ticketPayoutMode : undefined;
  const ticketRunnerUserId =
    typeof b.ticketRunnerUserId === "string" && b.ticketRunnerUserId.trim() ? b.ticketRunnerUserId.trim() : null;
  let ticketTypes: ReturnType<typeof parseTicketTypeInputs> | undefined;
  if (b.ticketTypes !== undefined) {
    ticketTypes = parseTicketTypeInputs(b.ticketTypes);
    if (!Array.isArray(ticketTypes)) {
      res.status(400).json({ error: ticketTypes.error });
      return;
    }
  }
  const created = await createEvent(
    { ...parsed, startAt, endAt, recurrenceRule: recurrenceRule ?? null, ticketPayoutMode, ticketRunnerUserId },
    req.user!.id,
  );
  if (Array.isArray(ticketTypes) && ticketTypes.length) {
    const tt = await upsertTicketTypes(created.id, ticketTypes);
    if (!tt.ok) {
      // Compensate: the event was just created and has no children yet, so a
      // failed ticket-type setup must not leave a half-configured event behind.
      await db.delete(events).where(eq(events.id, created.id));
      res.status(tt.httpStatus).json({ error: tt.error });
      return;
    }
  }
  await recordAudit({
    req,
    category: "mission",
    action: "event.create",
    targetType: "event",
    targetId: created.id,
    message: `Created event "${parsed.title}" (${parsed.eventType})`,
    after: { id: created.id, title: parsed.title, eventType: parsed.eventType },
  });
  const detail = await getEventDetail(created.id, viewerOf(req));
  res.status(201).json(detail);
});

// Convert an existing MISSION into an event (REPLACE). Soft-cancels the mission
// and creates a scheduled event carrying its shared fields. The Discord
// scheduled event is handed off (no teardown / recreate).
router.post("/missions/:id/convert-to-event", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const missionId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(missionId)) {
    res.status(400).json({ error: "Invalid mission id" });
    return;
  }
  const b = req.body ?? {};
  const eventType = isEventType(b.eventType) ? b.eventType : "social";
  const needsNpcs = b.needsNpcs === true;
  const endAt = b.endAt !== undefined ? parseDate(b.endAt) : null;
  if (b.endAt !== undefined && !endAt) {
    res.status(400).json({ error: "Invalid end time" });
    return;
  }
  const result = await convertMissionToEvent(missionId, req.user!.id, {
    eventType,
    needsNpcs,
    npcBlurb: needsNpcs && typeof b.npcBlurb === "string" && b.npcBlurb.trim() ? b.npcBlurb.trim() : null,
    endAt,
  });
  if (!result.ok) {
    res.status(result.httpStatus ?? 400).json({ error: result.error ?? "Conversion failed" });
    return;
  }
  await recordAudit({
    req,
    category: "mission",
    action: "mission.convert_to_event",
    targetType: "event",
    targetId: result.newId!,
    message: `Converted mission #${missionId} into event #${result.newId} (${eventType})`,
    after: { missionId, eventId: result.newId, eventType },
  });
  const detail = await getEventDetail(result.newId!, viewerOf(req));
  res.status(201).json(detail);
});

router.patch("/events/:id", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const id = eventIdParam(req, res);
  if (id == null) return;
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) {
    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!title) {
      res.status(400).json({ error: "Title cannot be empty" });
      return;
    }
    patch.title = title;
  }
  if (b.eventType !== undefined) patch.eventType = isEventType(b.eventType) ? b.eventType : "social";
  if (b.location !== undefined) patch.location = typeof b.location === "string" && b.location.trim() ? b.location.trim() : null;
  if (b.description !== undefined) patch.description = typeof b.description === "string" && b.description.trim() ? b.description.trim() : null;
  if (b.imageUrl !== undefined) patch.imageUrl = typeof b.imageUrl === "string" && b.imageUrl.trim() ? b.imageUrl.trim() : null;
  if (b.needsNpcs !== undefined) patch.needsNpcs = b.needsNpcs === true;
  if (b.npcBlurb !== undefined) patch.npcBlurb = typeof b.npcBlurb === "string" && b.npcBlurb.trim() ? b.npcBlurb.trim() : null;
  let startAt: Date | undefined;
  let endAt: Date | undefined;
  if (b.startAt !== undefined) {
    const d = parseDate(b.startAt);
    if (!d) {
      res.status(400).json({ error: "Invalid start time" });
      return;
    }
    startAt = d;
    patch.startAt = d;
  }
  if (b.endAt !== undefined) {
    const d = parseDate(b.endAt);
    if (!d) {
      res.status(400).json({ error: "Invalid end time" });
      return;
    }
    endAt = d;
    patch.endAt = d;
  }
  if (startAt && endAt && endAt.getTime() <= startAt.getTime()) {
    res.status(400).json({ error: "End time must be after start time" });
    return;
  }
  if (b.ticketPayoutMode !== undefined) {
    if (!isTicketPayoutMode(b.ticketPayoutMode)) {
      res.status(400).json({ error: "ticketPayoutMode must be 'runner' or 'sink'" });
      return;
    }
    patch.ticketPayoutMode = b.ticketPayoutMode;
  }
  if (b.ticketRunnerUserId !== undefined) {
    patch.ticketRunnerUserId =
      typeof b.ticketRunnerUserId === "string" && b.ticketRunnerUserId.trim() ? b.ticketRunnerUserId.trim() : null;
  }
  // Recurrence rule: parse and validate if provided.
  const recurrenceRuleResult = parseRecurrenceRuleInput(b, "recurrenceRule");
  if (recurrenceRuleResult && typeof recurrenceRuleResult === "object" && "error" in recurrenceRuleResult) {
    res.status(400).json({ error: recurrenceRuleResult.error });
    return;
  }
  const patchRecurrenceRule = recurrenceRuleResult as EventRecurrenceRule | null | undefined;
  if (patchRecurrenceRule !== undefined) patch.recurrenceRule = patchRecurrenceRule;
  // ---- "Just this occurrence" scope: split the occurrence out of the series
  // instead of editing the parent row. Ticket-tier edits and recurrenceRule
  // changes stay series-wide and are rejected here so they can't silently no-op.
  if (b.applyScope !== undefined && b.applyScope !== "series" && b.applyScope !== "occurrence") {
    res.status(400).json({ error: "applyScope must be 'series' or 'occurrence'" });
    return;
  }
  if (b.applyScope === "occurrence") {
    const occ = parseDate(b.occurrenceStartAt);
    if (!occ) {
      res.status(400).json({ error: "occurrenceStartAt is required for occurrence-scoped edits" });
      return;
    }
    if (b.ticketTypes !== undefined) {
      res.status(400).json({ error: "Ticket tiers can only be edited on the whole series" });
      return;
    }
    if (patchRecurrenceRule !== undefined) {
      res.status(400).json({ error: "recurrenceRule can only be changed on the whole series, not a single occurrence" });
      return;
    }
    // Strip recurrenceRule from the patch before passing to splitEventOccurrence
    // (child events are always single-occurrence).
    const { recurrenceRule: _rr, ...occPatch } = patch;
    const split = await splitEventOccurrence(id, occ, occPatch);
    if (!split.ok || !split.child) {
      res.status(split.httpStatus ?? 500).json({ error: split.error ?? "Split failed" });
      return;
    }
    await recordAudit({
      req,
      category: "mission",
      action: "event.split_occurrence",
      targetType: "event",
      targetId: split.child.id,
      message: `Edited single occurrence ${occ.toISOString()} of recurring event #${id} → new event #${split.child.id} "${split.child.title}"`,
      after: { parentEventId: id, occurrenceStartAt: occ.toISOString() },
    });
    res.status(201).json(await getEventDetail(split.child.id, viewerOf(req)));
    return;
  }
  // Main Sessions can never be recurring (deliberately discrete weekly rows):
  // reject when the EFFECTIVE post-patch state would be a session with a
  // non-null recurrenceRule — whether the type or the rule comes from this
  // patch or from the stored row. Runs only for series-scoped edits: an
  // occurrence-scoped edit above always yields a non-recurring child (and
  // already rejects recurrenceRule changes). This friendly 400 covers the
  // normal path; the events_session_not_recurring DB CHECK constraint closes
  // the concurrent-PATCH race for good.
  if (patchRecurrenceRule || patch.eventType === "session") {
    const [existing] = await db
      .select({ eventType: events.eventType, recurrenceRule: events.recurrenceRule })
      .from(events)
      .where(eq(events.id, id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    const effectiveType = typeof patch.eventType === "string" ? patch.eventType : existing.eventType;
    const effectiveRule = patchRecurrenceRule !== undefined ? patchRecurrenceRule : existing.recurrenceRule;
    if (effectiveType === "session" && effectiveRule) {
      res.status(400).json({ error: "Main Session events cannot be recurring — create discrete weekly events instead" });
      return;
    }
  }
  // Replace-set the ticket types BEFORE the event update so a validation error
  // aborts the whole edit.
  if (b.ticketTypes !== undefined) {
    const inputs = parseTicketTypeInputs(b.ticketTypes);
    if (!Array.isArray(inputs)) {
      res.status(400).json({ error: inputs.error });
      return;
    }
    const tt = await upsertTicketTypes(id, inputs);
    if (!tt.ok) {
      res.status(tt.httpStatus).json({ error: tt.error });
      return;
    }
  }
  const updated = await updateEvent(id, patch);
  if (!updated) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  await recordAudit({
    req,
    category: "mission",
    action: "event.update",
    targetType: "event",
    targetId: id,
    message: `Updated event "${updated.title}"`,
  });
  res.json(await getEventDetail(id, viewerOf(req)));
});

router.delete("/events/:id", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const id = eventIdParam(req, res);
  if (id == null) return;
  const cancelled = await cancelEvent(id);
  if (!cancelled) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  // Auto-refund every purchased, un-attended ticket; the summary rides back on
  // the response so the fixer sees refunded/failed counts immediately.
  const ticketRefunds = await refundAllForCancelledEvent(id, req.user!.id);
  await recordAudit({
    req,
    category: "mission",
    action: "event.cancel",
    targetType: "event",
    targetId: id,
    message: `Cancelled event "${cancelled.title}" (tickets refunded: ${ticketRefunds.refunded}, failed: ${ticketRefunds.failures.length})`,
    after: { ticketRefunds: { refunded: ticketRefunds.refunded, skipped: ticketRefunds.skipped, failures: ticketRefunds.failures } },
  });
  res.json({ ok: true, ticketRefunds });
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

// "My Tickets" — every ticket the viewer ever bought, past and future, joined
// to the LIVE event row so edits propagate automatically.
router.get("/me/tickets", requireAuth, async (req, res): Promise<void> => {
  res.json(await listMyTickets(req.user!.id));
});

// Buy one ticket. Atomic capacity reservation + idempotent wallet legs.
router.post("/events/:id/tickets", requireAuth, async (req, res): Promise<void> => {
  const id = eventIdParam(req, res);
  if (id == null) return;
  const ticketTypeId = Number(req.body?.ticketTypeId);
  if (!Number.isInteger(ticketTypeId)) {
    res.status(400).json({ error: "ticketTypeId is required" });
    return;
  }
  const result = await purchaseTicket({
    eventId: id,
    ticketTypeId,
    buyer: { id: req.user!.id, discordId: req.user!.discordId },
  });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  await recordAudit({
    req,
    category: "mission",
    action: "event.ticket.purchase",
    targetType: "event",
    targetId: id,
    message: `Bought ticket "${result.ticket.ticketTypeName}" for "${result.ticket.eventTitle}" (${result.ticket.pricePaid} eddies, wallet ${result.walletStatus})`,
    after: { ticketId: result.ticket.id, ticketTypeId, pricePaid: result.ticket.pricePaid, walletStatus: result.walletStatus },
  });
  res.status(201).json({ ticket: result.ticket, walletStatus: result.walletStatus });
});

// Purchaser roster — managers or designated check-in staff for this event.
router.get("/events/:id/tickets", requireAuth, async (req, res): Promise<void> => {
  const id = eventIdParam(req, res);
  if (id == null) return;
  if (!isManager(req) && !(await isCheckinStaff(id, req.user!.id))) {
    res.status(403).json({ error: "Manager or check-in staff access required" });
    return;
  }
  res.json(await listEventTickets(id));
});

// Toggle attendance (idempotent, undoable). Managers or check-in staff.
router.post("/events/:id/tickets/:ticketId/attendance", requireAuth, async (req, res): Promise<void> => {
  const id = eventIdParam(req, res);
  if (id == null) return;
  const ticketId = parseInt(String(req.params.ticketId), 10);
  if (!Number.isInteger(ticketId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (typeof req.body?.attended !== "boolean") {
    res.status(400).json({ error: "attended must be a boolean" });
    return;
  }
  if (!isManager(req) && !(await isCheckinStaff(id, req.user!.id))) {
    res.status(403).json({ error: "Manager or check-in staff access required" });
    return;
  }
  const result = await setTicketAttendance({
    eventId: id,
    ticketId,
    attended: req.body.attended,
    byUserId: req.user!.id,
  });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  await recordAudit({
    req,
    category: "mission",
    action: req.body.attended ? "event.ticket.attend" : "event.ticket.unattend",
    targetType: "event",
    targetId: id,
    message: `${req.body.attended ? "Marked" : "Unmarked"} ${result.ticket.buyerName ?? result.ticket.buyerUserId} as attended (${result.ticket.ticketTypeName})`,
    after: { ticketId, attended: req.body.attended },
  });
  res.json({ ticket: result.ticket });
});

// Refund one ticket — the BUYER or a manager, any time before attendance.
router.post("/events/:id/tickets/:ticketId/refund", requireAuth, async (req, res): Promise<void> => {
  const id = eventIdParam(req, res);
  if (id == null) return;
  const ticketId = parseInt(String(req.params.ticketId), 10);
  if (!Number.isInteger(ticketId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!isManager(req)) {
    // Non-managers may only refund their own ticket. Ownership is re-checked
    // here (cheap read) — refundTicket itself is authz-agnostic.
    const mine = (await listMyTickets(req.user!.id)).some((t) => t.id === ticketId && t.eventId === id);
    if (!mine) {
      res.status(403).json({ error: "You can only refund your own tickets" });
      return;
    }
  }
  const result = await refundTicket({ eventId: id, ticketId, byUserId: req.user!.id });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  await recordAudit({
    req,
    category: "mission",
    action: "event.ticket.refund",
    targetType: "event",
    targetId: id,
    message: `Refunded ticket "${result.ticket.ticketTypeName}" for ${result.ticket.buyerName ?? result.ticket.buyerUserId} (${result.ticket.pricePaid} eddies)`,
    after: { ticketId, pricePaid: result.ticket.pricePaid },
  });
  res.json({ ticket: result.ticket });
});

// Retry a bounced runner credit (manager only; never re-charges the buyer).
router.post("/events/:id/tickets/:ticketId/retry-payout", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const id = eventIdParam(req, res);
  if (id == null) return;
  const ticketId = parseInt(String(req.params.ticketId), 10);
  if (!Number.isInteger(ticketId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const result = await retryTicketPayout(id, ticketId);
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  await recordAudit({
    req,
    category: "mission",
    action: "event.ticket.retry_payout",
    targetType: "event",
    targetId: id,
    message: `Retried runner payout for ticket #${ticketId} (${result.ticket.pricePaid} eddies)`,
    after: { ticketId },
  });
  res.json({ ticket: result.ticket });
});

// Check-in staff management (manager only).
router.get("/events/:id/checkin-staff", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const id = eventIdParam(req, res);
  if (id == null) return;
  res.json(await listCheckinStaff(id));
});

router.put("/events/:id/checkin-staff", requireAuth, async (req, res): Promise<void> => {
  if (!isManager(req)) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const id = eventIdParam(req, res);
  if (id == null) return;
  const raw = req.body?.userIds;
  if (!Array.isArray(raw) || raw.some((u) => typeof u !== "string")) {
    res.status(400).json({ error: "userIds must be an array of user ids" });
    return;
  }
  const result = await setCheckinStaff(id, raw as string[], req.user!.id);
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  await recordAudit({
    req,
    category: "mission",
    action: "event.checkin_staff.set",
    targetType: "event",
    targetId: id,
    message: `Set check-in staff (${raw.length} user${raw.length === 1 ? "" : "s"})`,
    after: { userIds: raw },
  });
  res.json(await listCheckinStaff(id));
});

// Player signs up to act as an NPC on an event that has needsNpcs set.
router.post("/events/:id/npc-signups", requireAuth, async (req, res): Promise<void> => {
  const id = eventIdParam(req, res);
  if (id == null) return;
  const b = req.body ?? {};
  let characterId: number | null = null;
  if (b.characterId !== undefined && b.characterId !== null) {
    characterId = Number(b.characterId);
    if (!Number.isInteger(characterId)) {
      res.status(400).json({ error: "characterId must be an integer" });
      return;
    }
  }
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
  // Optional concrete occurrence (recurring events). Invalid dates are a 400
  // rather than silently falling back to the base occurrence.
  let occurrenceStartAt: Date | null = null;
  if (b.occurrenceStartAt !== undefined && b.occurrenceStartAt !== null) {
    occurrenceStartAt = new Date(String(b.occurrenceStartAt));
    if (Number.isNaN(occurrenceStartAt.getTime())) {
      res.status(400).json({ error: "occurrenceStartAt must be a valid ISO date-time" });
      return;
    }
  }
  const result = await signUpAsEventNpc({ eventId: id, userId: req.user!.id, characterId, note, occurrenceStartAt });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getEventDetail(id, viewerOf(req)));
});

// Player withdraws their own active NPC sign-up.
router.delete("/events/:id/npc-signups/me", requireAuth, async (req, res): Promise<void> => {
  const id = eventIdParam(req, res);
  if (id == null) return;
  // Optional occurrence scoping (?occurrenceStartAt=ISO). Omitted = withdraw
  // every active signup on the event (legacy behavior).
  let occurrenceStartAt: Date | null = null;
  const rawOcc = req.query.occurrenceStartAt;
  if (typeof rawOcc === "string" && rawOcc) {
    occurrenceStartAt = new Date(rawOcc);
    if (Number.isNaN(occurrenceStartAt.getTime())) {
      res.status(400).json({ error: "occurrenceStartAt must be a valid ISO date-time" });
      return;
    }
  }
  const result = await withdrawEventNpcSignup({ eventId: id, userId: req.user!.id, occurrenceStartAt });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getEventDetail(id, viewerOf(req)));
});

// Organizer (fixer/admin) confirms an event NPC sign-up: attended (pays the
// supplied per-person fee) or no_show. Mirrors the mission confirm route.
router.post("/events/:id/npc-signups/:signupId/confirm", requireAuth, async (req, res): Promise<void> => {
  const id = eventIdParam(req, res);
  if (id == null) return;
  const signupId = parseInt(String(req.params.signupId), 10);
  if (!Number.isInteger(signupId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const action = req.body?.action;
  if (action !== "attended" && action !== "no_show") {
    res.status(400).json({ error: "action must be 'attended' or 'no_show'" });
    return;
  }
  let amount = 0;
  if (action === "attended") {
    amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount < 0) {
      res.status(400).json({ error: "amount must be a non-negative integer" });
      return;
    }
  }
  const result = await confirmEventNpcSignup({
    eventId: id,
    signupId,
    action,
    amount,
    viewer: viewerOf(req),
    req,
  });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getEventDetail(id, viewerOf(req)));
});

export default router;
