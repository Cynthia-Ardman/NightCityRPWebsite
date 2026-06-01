import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  reviewComments,
  reviewSeen,
  pendingCharacterEdits,
  customRequests,
  characterSheets,
  characters,
  users,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole, sendDirectMessage } from "../lib/discord";
import { isReviewer } from "../lib/review";

// ---------------------------------------------------------------------------
// Generic review discussion + notification API.
//
// One small API serves all three majority-vote review queues — character
// EDITS ('edit'), custom REQUESTS ('request'), and character SHEETS ('sheet').
// It provides:
//   * a two-way COMMENT THREAD (fixers <-> players) that never changes a
//     subject's status, so a comment can never block an approval; and
//   * per-user SEEN tracking that drives the unseen notification counts (a
//     subject stops counting toward a reviewer's badge once they open it, and
//     re-counts when the player posts a fresh reply).
// LORE is intentionally excluded — it is a single-admin flow with no voting.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

const SUBJECT_TYPES = ["edit", "request", "sheet"] as const;
type SubjectType = (typeof SUBJECT_TYPES)[number];

function parseSubjectType(v: unknown): SubjectType | null {
  return SUBJECT_TYPES.includes(v as SubjectType) ? (v as SubjectType) : null;
}

type ResolvedSubject = {
  submitterId: string;
  status: string;
  // Short human label used in notification DMs.
  label: string;
};

// Resolve a review subject to its submitter + status (and a label for DMs),
// regardless of which queue it lives in. Returns null when the subject does
// not exist.
async function resolveSubject(type: SubjectType, id: number): Promise<ResolvedSubject | null> {
  if (type === "edit") {
    const [row] = await db
      .select({ submitterId: pendingCharacterEdits.submittedBy, status: pendingCharacterEdits.status, name: characters.name })
      .from(pendingCharacterEdits)
      .leftJoin(characters, eq(characters.id, pendingCharacterEdits.characterId))
      .where(eq(pendingCharacterEdits.id, id));
    if (!row) return null;
    return { submitterId: row.submitterId, status: row.status, label: `the edit to ${row.name ?? "your character"}` };
  }
  if (type === "request") {
    const [row] = await db
      .select({ submitterId: customRequests.requestedById, status: customRequests.status, title: customRequests.title })
      .from(customRequests)
      .where(eq(customRequests.id, id));
    if (!row) return null;
    return { submitterId: row.submitterId, status: row.status, label: `your request "${row.title}"` };
  }
  // sheet
  const [row] = await db
    .select({ submitterId: characterSheets.ownerId, status: characterSheets.status, name: characterSheets.name })
    .from(characterSheets)
    .where(eq(characterSheets.id, id));
  if (!row) return null;
  return { submitterId: row.submitterId, status: row.status, label: `the sheet for ${row.name}` };
}

// Both the submitter and any reviewer may read/post on a subject's thread.
function mayAccess(subject: ResolvedSubject, user: { id: string; roles: string[] }): boolean {
  return subject.submitterId === user.id || isReviewer(user as never);
}

function parseParams(req: { params: Record<string, unknown> }): { type: SubjectType; id: number } | null {
  const type = parseSubjectType(String(req.params.type));
  const id = parseInt(String(req.params.id), 10);
  if (!type || !Number.isFinite(id) || id <= 0) return null;
  return { type, id };
}

// GET /review/:type/:id/comments — full thread, oldest first (chat order).
router.get("/review/:type/:id/comments", requireAuth, async (req, res): Promise<void> => {
  const parsed = parseParams(req);
  if (!parsed) { res.status(400).json({ error: "Bad subject" }); return; }
  const subject = await resolveSubject(parsed.type, parsed.id);
  if (!subject) { res.status(404).json({ error: "Not found" }); return; }
  if (!mayAccess(subject, req.user!)) { res.status(403).json({ error: "Forbidden" }); return; }
  const rows = await db
    .select({
      id: reviewComments.id,
      authorId: reviewComments.authorId,
      authorName: users.username,
      authorAvatarUrl: users.avatarUrl,
      body: reviewComments.body,
      createdAt: reviewComments.createdAt,
    })
    .from(reviewComments)
    .leftJoin(users, eq(users.id, reviewComments.authorId))
    .where(and(eq(reviewComments.subjectType, parsed.type), eq(reviewComments.subjectId, parsed.id)))
    .orderBy(reviewComments.createdAt);
  res.json(
    rows.map((r) => ({
      id: r.id,
      subjectType: parsed.type,
      subjectId: parsed.id,
      authorId: r.authorId,
      authorName: r.authorName,
      authorAvatarUrl: r.authorAvatarUrl,
      isReviewer: r.authorId !== subject.submitterId,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

// POST /review/:type/:id/comments — post a comment. Never changes the
// subject's status. Best-effort DM the submitter when a reviewer comments so
// the player knows a fixer responded.
router.post("/review/:type/:id/comments", requireAuth, async (req, res): Promise<void> => {
  const parsed = parseParams(req);
  if (!parsed) { res.status(400).json({ error: "Bad subject" }); return; }
  const subject = await resolveSubject(parsed.type, parsed.id);
  if (!subject) { res.status(404).json({ error: "Not found" }); return; }
  if (!mayAccess(subject, req.user!)) { res.status(403).json({ error: "Forbidden" }); return; }
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) { res.status(400).json({ error: "Comment body required" }); return; }
  if (body.length > 4000) { res.status(400).json({ error: "Comment too long" }); return; }
  const [created] = await db
    .insert(reviewComments)
    .values({ subjectType: parsed.type, subjectId: parsed.id, authorId: req.user!.id, body })
    .returning();
  // Posting marks it seen for the author (they obviously saw the thread).
  await db
    .insert(reviewSeen)
    .values({ userId: req.user!.id, subjectType: parsed.type, subjectId: parsed.id, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: [reviewSeen.userId, reviewSeen.subjectType, reviewSeen.subjectId],
      set: { lastSeenAt: new Date() },
    });
  // Best-effort: notify the submitter when a reviewer (not the submitter)
  // leaves a comment. Never blocks the response.
  if (req.user!.id !== subject.submitterId) {
    (async () => {
      try {
        const [u] = await db.select({ discordId: users.discordId }).from(users).where(eq(users.id, subject.submitterId));
        if (u?.discordId) {
          await sendDirectMessage(u.discordId, `${req.user!.username} commented on ${subject.label}:\n${body.slice(0, 1500)}`);
        }
      } catch {
        /* DM delivery is best-effort */
      }
    })();
  }
  res.status(201).json({
    id: created.id,
    subjectType: parsed.type,
    subjectId: parsed.id,
    authorId: created.authorId,
    authorName: req.user!.username,
    authorAvatarUrl: req.user!.avatarUrl,
    isReviewer: req.user!.id !== subject.submitterId,
    body: created.body,
    createdAt: created.createdAt.toISOString(),
  });
});

// POST /review/:type/:id/seen — mark a subject as seen by the current user.
// Called when a reviewer opens a detail/expanded view; drops it from their
// unseen count.
router.post("/review/:type/:id/seen", requireAuth, async (req, res): Promise<void> => {
  const parsed = parseParams(req);
  if (!parsed) { res.status(400).json({ error: "Bad subject" }); return; }
  const subject = await resolveSubject(parsed.type, parsed.id);
  if (!subject) { res.status(404).json({ error: "Not found" }); return; }
  if (!mayAccess(subject, req.user!)) { res.status(403).json({ error: "Forbidden" }); return; }
  await db
    .insert(reviewSeen)
    .values({ userId: req.user!.id, subjectType: parsed.type, subjectId: parsed.id, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: [reviewSeen.userId, reviewSeen.subjectType, reviewSeen.subjectId],
      set: { lastSeenAt: new Date() },
    });
  res.json({ ok: true });
});

// Count how many of `items` the viewer has NOT seen since their latest
// activity. An item's activityAt = max(its base timestamp, its newest
// comment). Unseen = no seen row OR lastSeenAt < activityAt.
async function countUnseen(
  subjectType: SubjectType,
  items: Array<{ id: number; baseAt: Date }>,
  viewerId: string,
): Promise<number> {
  if (items.length === 0) return 0;
  const ids = items.map((i) => i.id);
  const commentRows = await db
    .select({ subjectId: reviewComments.subjectId, last: sql<string>`max(${reviewComments.createdAt})` })
    .from(reviewComments)
    .where(and(eq(reviewComments.subjectType, subjectType), inArray(reviewComments.subjectId, ids)))
    .groupBy(reviewComments.subjectId);
  const lastComment = new Map(commentRows.map((r) => [r.subjectId, new Date(r.last)]));
  const seenRows = await db
    .select({ subjectId: reviewSeen.subjectId, lastSeenAt: reviewSeen.lastSeenAt })
    .from(reviewSeen)
    .where(and(eq(reviewSeen.userId, viewerId), eq(reviewSeen.subjectType, subjectType), inArray(reviewSeen.subjectId, ids)));
  const seen = new Map(seenRows.map((r) => [r.subjectId, r.lastSeenAt]));
  let count = 0;
  for (const item of items) {
    const c = lastComment.get(item.id);
    const activityAt = c && c > item.baseAt ? c : item.baseAt;
    const s = seen.get(item.id);
    if (!s || s.getTime() < activityAt.getTime()) count++;
  }
  return count;
}

// GET /review/unseen-counts — per-queue count of actionable items the current
// reviewer has not yet seen. Role-gated like the queue lists; each item's own
// submitter is excluded (you don't review your own). LORE is not included.
router.get("/review/unseen-counts", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const viewerId = u.id;
  const ACTIONABLE = ["pending", "changes_requested"] as const;
  const isAdmin = hasRole(u.roles, "ADMIN");
  const canMisc = hasRole(u.roles, "FIXER") || isAdmin;
  const canSheets = hasRole(u.roles, "CS_APPROVER") || isAdmin;
  const canEdits = isReviewer(u as never);

  let edits = 0;
  let requests = 0;
  let sheets = 0;

  if (canEdits) {
    const rows = await db
      .select({ id: pendingCharacterEdits.id, submittedBy: pendingCharacterEdits.submittedBy, baseAt: pendingCharacterEdits.submittedAt })
      .from(pendingCharacterEdits)
      .where(inArray(pendingCharacterEdits.status, ACTIONABLE as unknown as string[]));
    edits = await countUnseen("edit", rows.filter((r) => r.submittedBy !== viewerId).map((r) => ({ id: r.id, baseAt: r.baseAt })), viewerId);
  }
  if (canMisc) {
    const rows = await db
      .select({ id: customRequests.id, requestedById: customRequests.requestedById, baseAt: customRequests.createdAt })
      .from(customRequests)
      .where(inArray(customRequests.status, ACTIONABLE as unknown as string[]));
    requests = await countUnseen("request", rows.filter((r) => r.requestedById !== viewerId).map((r) => ({ id: r.id, baseAt: r.baseAt })), viewerId);
  }
  if (canSheets) {
    const rows = await db
      .select({ id: characterSheets.id, ownerId: characterSheets.ownerId, baseAt: characterSheets.createdAt })
      .from(characterSheets)
      .where(inArray(characterSheets.status, ACTIONABLE as unknown as string[]));
    sheets = await countUnseen("sheet", rows.filter((r) => r.ownerId !== viewerId).map((r) => ({ id: r.id, baseAt: r.baseAt })), viewerId);
  }

  res.json({ edits, requests, sheets, total: edits + requests + sheets });
});

export default router;
