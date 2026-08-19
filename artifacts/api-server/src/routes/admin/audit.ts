import type { IRouter } from "express";
import { eq, desc, sql, and, gte, type SQL } from "drizzle-orm";
import { db, activityEvents } from "@workspace/db";
import { isNull, or, ilike, inArray } from "drizzle-orm";
import { auditLog } from "@workspace/db";
import { adminOnly } from "./shared";

export function registerAudit(router: IRouter): void {
  router.get("/admin/activity", adminOnly, async (_req, res): Promise<void> => {
    const rows = await db.select().from(activityEvents).orderBy(desc(activityEvents.createdAt)).limit(100);
    res.json(rows);
  });

  // New unified audit log feed (separate from /admin/audit which still reads the
  // legacy player-facing activity_events). Supports combined filters (category,
  // action list, actor id-or-name, date range, target, free-text) plus stable
  // keyset pagination via beforeId (rows are ordered by id DESC, so the client
  // passes the smallest id it has seen to fetch the next page).
  router.get("/admin/audit-log", adminOnly, async (req, res): Promise<void> => {
    const category = req.query.category ? String(req.query.category) : null;
    const actions = req.query.action
      ? String(req.query.action)
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
      : [];
    const actorId = req.query.actorId ? String(req.query.actorId).trim() : null;
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const until = req.query.until ? new Date(String(req.query.until)) : null;
    const targetType = req.query.targetType ? String(req.query.targetType).trim() : null;
    const targetId = req.query.targetId ? String(req.query.targetId).trim() : null;
    const q = req.query.q ? String(req.query.q).trim() : null;
    const beforeId = req.query.beforeId ? parseInt(String(req.query.beforeId), 10) : null;
    const limit = Math.min(500, parseInt(String(req.query.limit ?? "200"), 10) || 200);
    // Actor filter matches EITHER the exact actor id OR a case-insensitive
    // substring of the stored actor display name, so staff can search "vinnybot"
    // without knowing the Discord id. Escape LIKE wildcards in the typed term.
    const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const actorLike = actorId ? `%${escapeLike(actorId)}%` : null;
    // Free-text search matches message, action, and the JSON change details
    // (before/after), so staff can find e.g. an amount or an old value.
    const qLike = q ? `%${escapeLike(q)}%` : null;
    const conds: SQL[] = [
      category && category !== "all" ? eq(auditLog.category, category) : null,
      actions.length === 1 ? eq(auditLog.action, actions[0]) : actions.length > 1 ? inArray(auditLog.action, actions) : null,
      actorId && actorLike ? (or(eq(auditLog.actorId, actorId), ilike(auditLog.actorName, actorLike)) as SQL) : null,
      since && !isNaN(since.getTime()) ? gte(auditLog.createdAt, since) : null,
      until && !isNaN(until.getTime()) ? sql`${auditLog.createdAt} <= ${until}` : null,
      targetType ? eq(auditLog.targetType, targetType) : null,
      targetId ? eq(auditLog.targetId, targetId) : null,
      qLike
        ? (or(
            ilike(auditLog.message, qLike),
            ilike(auditLog.action, qLike),
            sql`${auditLog.beforeJson}::text ILIKE ${qLike}`,
            sql`${auditLog.afterJson}::text ILIKE ${qLike}`,
          ) as SQL)
        : null,
      beforeId !== null && Number.isFinite(beforeId) ? sql`${auditLog.id} < ${beforeId}` : null,
    ].filter((c): c is SQL => c !== null);
    const base = db.select().from(auditLog);
    const rows = conds.length
      ? await base.where(and(...conds)).orderBy(desc(auditLog.id)).limit(limit)
      : await base.orderBy(desc(auditLog.id)).limit(limit);
    res.json(rows);
  });

  router.get("/admin/audit", adminOnly, async (req, res): Promise<void> => {
    const kind = req.query.kind ? String(req.query.kind) : null;
    const actorId = req.query.actorId ? String(req.query.actorId).trim() : null;
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const limit = Math.min(500, parseInt(String(req.query.limit ?? "100"), 10) || 100);
    // Same id-or-name matching as /admin/audit-log.
    const actorLike = actorId ? `%${actorId.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
    const conds = [
      kind ? eq(activityEvents.kind, kind) : null,
      actorId && actorLike ? or(eq(activityEvents.actorId, actorId), ilike(activityEvents.actorName, actorLike)) : null,
      since && !isNaN(since.getTime()) ? gte(activityEvents.createdAt, since) : null,
    ].filter(Boolean) as ReturnType<typeof eq>[];
    const rows = conds.length
      ? await db.select().from(activityEvents).where(and(...conds)).orderBy(desc(activityEvents.createdAt)).limit(limit)
      : await db.select().from(activityEvents).orderBy(desc(activityEvents.createdAt)).limit(limit);
    res.json(rows);
  });
}
