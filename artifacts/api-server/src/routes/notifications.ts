import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, notifications } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Serialize a notification row for the API (dates as ISO strings).
function shape(n: typeof notifications.$inferSelect) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    href: n.href ?? null,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt ? n.readAt.toISOString() : null,
  };
}

// The caller's notification feed, newest first. Cursor-paginated on id
// (before=<id> returns strictly older rows) so new arrivals can't shift pages.
router.get("/notifications", requireAuth, async (req, res): Promise<void> => {
  const limitRaw = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : NaN;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
  const beforeRaw = typeof req.query.before === "string" ? parseInt(req.query.before, 10) : NaN;
  const before = Number.isFinite(beforeRaw) ? beforeRaw : undefined;

  const where = before
    ? and(eq(notifications.userId, req.user!.id), lt(notifications.id, before))
    : eq(notifications.userId, req.user!.id);
  // Fetch one extra row to compute hasMore without a COUNT.
  const rows = await db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  res.json({
    items: page.map(shape),
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit && page.length > 0 ? page[page.length - 1].id : null,
  });
});

// Lightweight unread count for the bell badge (polled).
router.get("/notifications/unread-count", requireAuth, async (req, res): Promise<void> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt)));
  res.json({ count: row?.count ?? 0 });
});

// Mark notifications read: either an explicit id list or all of the caller's
// unread rows. Scoped to the caller — ids belonging to other users are ignored.
router.post("/notifications/mark-read", requireAuth, async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { ids?: unknown; all?: unknown };
  const all = body.all === true;
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
    : [];
  if (!all && ids.length === 0) {
    res.json({ updated: 0 });
    return;
  }
  const scope = all
    ? and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt))
    : and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt), inArray(notifications.id, ids));
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(scope)
    .returning({ id: notifications.id });
  res.json({ updated: updated.length });
});

export default router;
