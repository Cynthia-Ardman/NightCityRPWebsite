import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/auth";
import { hasRole } from "../lib/discord";
import { recordAudit } from "../lib/audit";
import {
  listEvents,
  getEventDetail,
  createEvent,
  updateEvent,
  cancelEvent,
  signUpAsEventNpc,
  withdrawEventNpcSignup,
  checkEventConflict,
  isEventType,
  convertMissionToEvent,
  type EventViewer,
} from "../lib/eventsService";

const router: IRouter = Router();

function viewerOf(req: Request): EventViewer {
  const u = req.user!;
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

router.get("/events", requireAuth, async (req, res): Promise<void> => {
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

router.get("/events/:id", requireAuth, async (req, res): Promise<void> => {
  const id = eventIdParam(req, res);
  if (id == null) return;
  const detail = await getEventDetail(id, viewerOf(req));
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
  const created = await createEvent(
    { ...parsed, startAt, endAt },
    req.user!.id,
  );
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
  await recordAudit({
    req,
    category: "mission",
    action: "event.cancel",
    targetType: "event",
    targetId: id,
    message: `Cancelled event "${cancelled.title}"`,
  });
  res.json({ ok: true });
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
  const result = await signUpAsEventNpc({ eventId: id, userId: req.user!.id, characterId, note });
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
  const result = await withdrawEventNpcSignup({ eventId: id, userId: req.user!.id });
  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error });
    return;
  }
  res.json(await getEventDetail(id, viewerOf(req)));
});

export default router;
