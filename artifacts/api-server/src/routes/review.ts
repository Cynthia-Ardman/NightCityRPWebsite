import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import {
  db,
  reviewComments,
  reviewSeen,
  pendingCharacterEdits,
  customRequests,
  characterSheets,
  characters,
  missions,
  lorePendingEdits,
  loreEntries,
  users,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole, sendDirectMessage, listThreadMessages, threadWebUrl, type DiscordThreadMessage } from "../lib/discord";
import { isReviewer, type ReviewActionResult } from "../lib/review";
import { closeRequest, reopenRequest, STAFF_QUEUE_EXCLUDED_REQUEST_TYPES, PLAYER_DECIDED_REQUEST_TYPES } from "./requests";
import { closeEdit, reopenEdit } from "./pending-edits";
import { closeSheet, reopenSheet } from "./sheets";
import { closeLore, reopenLore } from "./lore";

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
// LORE proposals ('lore') also ride this pipeline — they vote/tally/close like
// the others, but materialize via lore's own applyProposal at the close step.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

const SUBJECT_TYPES = ["edit", "request", "sheet", "lore"] as const;
type SubjectType = (typeof SUBJECT_TYPES)[number];

function parseSubjectType(v: unknown): SubjectType | null {
  return SUBJECT_TYPES.includes(v as SubjectType) ? (v as SubjectType) : null;
}

// The read-only Discord thread mirror also serves MISSIONS, which have a
// discussion thread but are NOT part of the majority-vote review pipeline
// (comments / seen / votes / close stay edit|request|sheet only). Keep the
// extra type scoped to the thread endpoint so the vote-pipeline routes never
// accept it.
const THREAD_SUBJECT_TYPES = ["edit", "request", "sheet", "lore", "mission"] as const;
type ThreadSubjectType = (typeof THREAD_SUBJECT_TYPES)[number];

function parseThreadSubjectType(v: unknown): ThreadSubjectType | null {
  return THREAD_SUBJECT_TYPES.includes(v as ThreadSubjectType) ? (v as ThreadSubjectType) : null;
}

// Absolute portal deep-link for the SUBMITTER of a review subject, used in the
// "a reviewer commented" DM so the player can jump straight to the ticket and
// reply. Base-URL rule mirrors announceRequest (PUBLIC_BASE_URL, then the
// first REPLIT_DOMAINS entry) — keep the two in lockstep. Returns null when no
// public base is configured: a relative path is useless (non-clickable) in a
// Discord DM.
function submitterLink(type: SubjectType, id: number): string | null {
  // Requests, sheets and character edits all surface on the player's
  // My Submissions page, which reads ?focus=<type>-<id> to auto-expand the
  // matching row's discussion. Lore proposals have no player thread page, so
  // point at the player's own lore list instead.
  const path = type === "lore" ? "/directory/lore/mine" : `/submissions?focus=${type}-${id}`;
  const base = (process.env.PUBLIC_BASE_URL ?? process.env.REPLIT_DOMAINS?.split(",")[0] ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return base ? `https://${base}${path}` : null;
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
async function resolveSubject(type: ThreadSubjectType, id: number): Promise<ResolvedSubject | null> {
  if (type === "mission") {
    const [row] = await db
      .select({ submitterId: missions.fixerId, status: missions.workflowState, title: missions.title })
      .from(missions)
      .where(eq(missions.id, id));
    if (!row) return null;
    return { submitterId: row.submitterId ?? "", status: row.status, label: `the mission "${row.title}"` };
  }
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
  if (type === "lore") {
    const [row] = await db
      .select({ submitterId: lorePendingEdits.submittedBy, status: lorePendingEdits.status, name: loreEntries.name })
      .from(lorePendingEdits)
      .leftJoin(loreEntries, eq(loreEntries.id, lorePendingEdits.loreEntryId))
      .where(eq(lorePendingEdits.id, id));
    if (!row) return null;
    return { submitterId: row.submitterId, status: row.status, label: `your lore proposal${row.name ? ` for ${row.name}` : ""}` };
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
          const link = submitterLink(parsed.type, parsed.id);
          await sendDirectMessage(
            u.discordId,
            `${req.user!.username} commented on ${subject.label}:\n${body.slice(0, 1500)}` +
              (link ? `\n\nView & reply: ${link}` : ""),
          );
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
  // The reviewer pool is generic (FIXER / CS_APPROVER / ADMIN) for every review
  // subject — sheets, custom requests, and character edits all draw from the
  // same pool (see isReviewer / isEligibleReviewer). Count unseen items for all
  // three queues off that single pool so badges match who can actually act
  // (previously requests excluded CS_APPROVER and sheets excluded FIXER).
  const canMisc = isReviewer(u as never);
  const canSheets = isReviewer(u as never);
  const canEdits = isReviewer(u as never);
  const canLore = isReviewer(u as never);

  let edits = 0;
  let requests = 0;
  let sheets = 0;
  let lore = 0;

  if (canEdits) {
    const rows = await db
      .select({ id: pendingCharacterEdits.id, submittedBy: pendingCharacterEdits.submittedBy, baseAt: pendingCharacterEdits.submittedAt })
      .from(pendingCharacterEdits)
      .where(inArray(pendingCharacterEdits.status, ACTIONABLE as unknown as string[]));
    edits = await countUnseen("edit", rows.filter((r) => r.submittedBy !== viewerId).map((r) => ({ id: r.id, baseAt: r.baseAt })), viewerId);
  }
  if (canMisc) {
    // Mirror the staff /requests queue exactly: exclude the My-Requests-only
    // types it never renders, or the dashboard card counts a ticket the queue
    // it links to can't show (phantom "1 pending request, nothing there").
    const rows = await db
      .select({ id: customRequests.id, requestedById: customRequests.requestedById, baseAt: customRequests.createdAt })
      .from(customRequests)
      .where(and(
        inArray(customRequests.status, ACTIONABLE as unknown as string[]),
        notInArray(customRequests.type, STAFF_QUEUE_EXCLUDED_REQUEST_TYPES as unknown as string[]),
      ));
    requests = await countUnseen("request", rows.filter((r) => r.requestedById !== viewerId).map((r) => ({ id: r.id, baseAt: r.baseAt })), viewerId);
  }
  if (canSheets) {
    const rows = await db
      .select({ id: characterSheets.id, ownerId: characterSheets.ownerId, baseAt: characterSheets.createdAt })
      .from(characterSheets)
      .where(inArray(characterSheets.status, ACTIONABLE as unknown as string[]));
    sheets = await countUnseen("sheet", rows.filter((r) => r.ownerId !== viewerId).map((r) => ({ id: r.id, baseAt: r.baseAt })), viewerId);
  }
  if (canLore) {
    const rows = await db
      .select({ id: lorePendingEdits.id, submittedBy: lorePendingEdits.submittedBy, baseAt: lorePendingEdits.createdAt })
      .from(lorePendingEdits)
      .where(inArray(lorePendingEdits.status, ACTIONABLE as unknown as string[]));
    lore = await countUnseen("lore", rows.filter((r) => r.submittedBy !== viewerId).map((r) => ({ id: r.id, baseAt: r.baseAt })), viewerId);
  }

  res.json({ edits, requests, sheets, lore, total: edits + requests + sheets + lore });
});

// Like countUnseen but returns the unseen subject ids (drives per-row dots on
// both the player and staff pages).
async function listUnseenIds(
  subjectType: SubjectType,
  items: Array<{ id: number; baseAt: Date | null }>,
  viewerId: string,
  opts: { excludeCommentAuthor?: string } = {},
): Promise<number[]> {
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);
  const commentConds = [eq(reviewComments.subjectType, subjectType), inArray(reviewComments.subjectId, ids)];
  // Submitter view passes excludeCommentAuthor=self so the player's own replies
  // don't re-notify themselves; reviewer callers omit it and see every comment.
  if (opts.excludeCommentAuthor) commentConds.push(ne(reviewComments.authorId, opts.excludeCommentAuthor));
  const commentRows = await db
    .select({ subjectId: reviewComments.subjectId, last: sql<string>`max(${reviewComments.createdAt})` })
    .from(reviewComments)
    .where(and(...commentConds))
    .groupBy(reviewComments.subjectId);
  const lastComment = new Map(commentRows.map((r) => [r.subjectId, new Date(r.last)]));
  const seenRows = await db
    .select({ subjectId: reviewSeen.subjectId, lastSeenAt: reviewSeen.lastSeenAt })
    .from(reviewSeen)
    .where(and(eq(reviewSeen.userId, viewerId), eq(reviewSeen.subjectType, subjectType), inArray(reviewSeen.subjectId, ids)));
  const seen = new Map(seenRows.map((r) => [r.subjectId, r.lastSeenAt]));
  const out: number[] = [];
  for (const item of items) {
    const c = lastComment.get(item.id);
    const activityAt = maxDateOrNull(item.baseAt, c ?? null);
    // A null activityAt means there is nothing for this viewer to be notified
    // about (no decision/close and no qualifying comment). Reviewer callers
    // always pass a non-null baseAt (submittedAt), so this only skips bare
    // submissions in the submitter view — which is exactly the phantom-badge
    // case: a freshly submitted pending row must NOT light up its own author's
    // badge before any reviewer has acted on it.
    if (!activityAt) continue;
    const s = seen.get(item.id);
    if (!s || s.getTime() < activityAt.getTime()) out.push(item.id);
  }
  return out;
}

function maxDate(...dates: Array<Date | null | undefined>): Date {
  let m = new Date(0);
  for (const d of dates) if (d && d.getTime() > m.getTime()) m = d;
  return m;
}

// Like maxDate but returns null when none of the inputs are set, so callers can
// distinguish "no activity at all" from "activity at the epoch".
function maxDateOrNull(...dates: Array<Date | null | undefined>): Date | null {
  let m: Date | null = null;
  for (const d of dates) if (d && (!m || d.getTime() > m.getTime())) m = d;
  return m;
}

// GET /review/my-unseen — the SUBMITTER's unread view. Returns, per queue, the
// ids of the player's OWN submissions that have activity (a reviewer comment or
// a decision/close) the player has not seen yet, plus a grand total for the nav
// badge. Unlike the reviewer endpoints this is not role-gated and only ever
// looks at rows the caller submitted.
router.get("/review/my-unseen", requireAuth, async (req, res): Promise<void> => {
  const viewerId = req.user!.id;

  const editRows = await db
    .select({ id: pendingCharacterEdits.id, submittedAt: pendingCharacterEdits.submittedAt, decidedAt: pendingCharacterEdits.decidedAt, closedAt: pendingCharacterEdits.closedAt })
    .from(pendingCharacterEdits)
    .where(eq(pendingCharacterEdits.submittedBy, viewerId));
  // Exclude player-decided rows (employment invites / mission participation):
  // the portal renders those on the Inbox page, not My Submissions, so counting
  // them here would light a Submissions badge with no row to open and clear.
  const requestRows = await db
    .select({ id: customRequests.id, createdAt: customRequests.createdAt, reviewedAt: customRequests.reviewedAt, closedAt: customRequests.closedAt })
    .from(customRequests)
    .where(
      and(
        eq(customRequests.requestedById, viewerId),
        notInArray(customRequests.type, PLAYER_DECIDED_REQUEST_TYPES as unknown as string[]),
      ),
    );
  // Exclude drafts: My Submissions deliberately hides draft sheets (they live only
  // in the owner's draft editor), so counting them here would create an unread
  // badge with no row to open and clear — the same phantom class as the
  // staff-windowed edits above.
  const sheetRows = await db
    .select({ id: characterSheets.id, createdAt: characterSheets.createdAt, decidedAt: characterSheets.decidedAt, closedAt: characterSheets.closedAt })
    .from(characterSheets)
    .where(and(eq(characterSheets.ownerId, viewerId), ne(characterSheets.status, "draft")));
  const loreRows = await db
    .select({ id: lorePendingEdits.id, createdAt: lorePendingEdits.createdAt, decidedAt: lorePendingEdits.decidedAt, closedAt: lorePendingEdits.closedAt })
    .from(lorePendingEdits)
    .where(eq(lorePendingEdits.submittedBy, viewerId));

  // The SUBMITTER is only notified by reviewer-side activity: a decision
  // (decidedAt/reviewedAt) or a comment from someone other than themselves.
  // The bare submission timestamp (submittedAt/createdAt) is deliberately NOT a
  // trigger here — including it made every freshly submitted pending row light
  // up its own author's "My Submissions" badge with nothing new to read, the
  // recurring phantom-pending-edit bug.
  // closedAt is ALSO deliberately excluded: a reviewer's administrative close
  // (archiving an already-resolved ticket) was re-pinging the submitter on a
  // request they'd already seen the decision for, so a "completed" request kept
  // a stuck unread dot/badge. Closing now clears on its own — the decision (and
  // any reviewer comment) is what notifies the player.
  const edit = await listUnseenIds("edit", editRows.map((r) => ({ id: r.id, baseAt: r.decidedAt ?? null })), viewerId, { excludeCommentAuthor: viewerId });
  const request = await listUnseenIds("request", requestRows.map((r) => ({ id: r.id, baseAt: r.reviewedAt ?? null })), viewerId, { excludeCommentAuthor: viewerId });
  const sheet = await listUnseenIds("sheet", sheetRows.map((r) => ({ id: r.id, baseAt: r.decidedAt ?? null })), viewerId, { excludeCommentAuthor: viewerId });
  const lore = await listUnseenIds("lore", loreRows.map((r) => ({ id: r.id, baseAt: r.decidedAt ?? null })), viewerId, { excludeCommentAuthor: viewerId });

  res.json({ edit, request, sheet, lore, total: edit.length + request.length + sheet.length + lore.length });
});

// GET /review/unseen-ids — the REVIEWER's per-row unread view. Same actionable
// scope and role gating as /review/unseen-counts, but returns the ids so the
// staff page can render a dot on each unseen ticket.
router.get("/review/unseen-ids", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const viewerId = u.id;
  const ACTIONABLE = ["pending", "changes_requested"] as const;
  // The reviewer pool is generic (FIXER / CS_APPROVER / ADMIN) for every review
  // subject — sheets, custom requests, and character edits all draw from the
  // same pool (see isReviewer / isEligibleReviewer). Count unseen items for all
  // three queues off that single pool so badges match who can actually act
  // (previously requests excluded CS_APPROVER and sheets excluded FIXER).
  const canMisc = isReviewer(u as never);
  const canSheets = isReviewer(u as never);
  const canEdits = isReviewer(u as never);
  const canLore = isReviewer(u as never);

  let edit: number[] = [];
  let request: number[] = [];
  let sheet: number[] = [];
  let lore: number[] = [];

  if (canEdits) {
    const rows = await db
      .select({ id: pendingCharacterEdits.id, submittedBy: pendingCharacterEdits.submittedBy, baseAt: pendingCharacterEdits.submittedAt })
      .from(pendingCharacterEdits)
      .where(inArray(pendingCharacterEdits.status, ACTIONABLE as unknown as string[]));
    edit = await listUnseenIds("edit", rows.filter((r) => r.submittedBy !== viewerId).map((r) => ({ id: r.id, baseAt: r.baseAt })), viewerId);
  }
  if (canMisc) {
    // Same exclusion as /review/unseen-counts so the misc-tab badge and the
    // landing-tab logic never light up for a type the queue doesn't render.
    const rows = await db
      .select({ id: customRequests.id, requestedById: customRequests.requestedById, baseAt: customRequests.createdAt })
      .from(customRequests)
      .where(and(
        inArray(customRequests.status, ACTIONABLE as unknown as string[]),
        notInArray(customRequests.type, STAFF_QUEUE_EXCLUDED_REQUEST_TYPES as unknown as string[]),
      ));
    request = await listUnseenIds("request", rows.filter((r) => r.requestedById !== viewerId).map((r) => ({ id: r.id, baseAt: r.baseAt })), viewerId);
  }
  if (canSheets) {
    const rows = await db
      .select({ id: characterSheets.id, ownerId: characterSheets.ownerId, baseAt: characterSheets.createdAt })
      .from(characterSheets)
      .where(inArray(characterSheets.status, ACTIONABLE as unknown as string[]));
    sheet = await listUnseenIds("sheet", rows.filter((r) => r.ownerId !== viewerId).map((r) => ({ id: r.id, baseAt: r.baseAt })), viewerId);
  }
  if (canLore) {
    const rows = await db
      .select({ id: lorePendingEdits.id, submittedBy: lorePendingEdits.submittedBy, baseAt: lorePendingEdits.createdAt })
      .from(lorePendingEdits)
      .where(inArray(lorePendingEdits.status, ACTIONABLE as unknown as string[]));
    lore = await listUnseenIds("lore", rows.filter((r) => r.submittedBy !== viewerId).map((r) => ({ id: r.id, baseAt: r.baseAt })), viewerId);
  }

  res.json({ edit, request, sheet, lore });
});

// Count, per subject id, the discussion comments the viewer has NOT read yet.
// This is the REVIEWER-side badge, so "unread" means comments from the OTHER
// PARTY — i.e. the ticket's submitter (player) — not fellow reviewers. A
// comment counts when it was authored by that ticket's submitter and its
// createdAt is after the viewer's lastSeenAt (all of them when there's no seen
// row). Unlike countUnseen / listUnseenIds this is purely comment-driven — a
// brand-new ticket with no submitter comments has a count of 0 — so it powers
// the numeric badge on the per-card VIEW & RESPOND button independent of the
// "pending seen" line.
async function countUnreadComments(
  subjectType: SubjectType,
  items: Array<{ id: number; submitterId: string | null }>,
  viewerId: string,
): Promise<Record<number, number>> {
  const ids = items.map((i) => i.id);
  if (ids.length === 0) return {};
  const submitterBySubject = new Map(items.map((i) => [i.id, i.submitterId]));
  const commentRows = await db
    .select({
      subjectId: reviewComments.subjectId,
      authorId: reviewComments.authorId,
      createdAt: reviewComments.createdAt,
    })
    .from(reviewComments)
    .where(and(
      eq(reviewComments.subjectType, subjectType),
      inArray(reviewComments.subjectId, ids),
    ));
  const seenRows = await db
    .select({ subjectId: reviewSeen.subjectId, lastSeenAt: reviewSeen.lastSeenAt })
    .from(reviewSeen)
    .where(and(eq(reviewSeen.userId, viewerId), eq(reviewSeen.subjectType, subjectType), inArray(reviewSeen.subjectId, ids)));
  const seen = new Map(seenRows.map((r) => [r.subjectId, r.lastSeenAt]));
  const out: Record<number, number> = {};
  for (const c of commentRows) {
    // Only the submitter's comments count toward the reviewer's unread badge;
    // skip fellow reviewers' comments (and the viewer's own, which the submitter
    // filter already excludes since submitter !== viewer for included rows).
    const submitterId = submitterBySubject.get(c.subjectId) ?? null;
    if (!submitterId || c.authorId !== submitterId) continue;
    const s = seen.get(c.subjectId);
    if (!s || s.getTime() < c.createdAt.getTime()) out[c.subjectId] = (out[c.subjectId] ?? 0) + 1;
  }
  return out;
}

// GET /review/unread-detail — the REVIEWER's per-item unread DISCUSSION count.
// Same actionable scope + role gating as /review/unseen-ids, but returns, per
// queue, a map of subjectId -> number of unread discussion comments (from the
// other party) so each card's VIEW & RESPOND button can show a numeric badge.
router.get("/review/unread-detail", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  const viewerId = u.id;
  const ACTIONABLE = ["pending", "changes_requested"] as const;
  const can = isReviewer(u as never);

  let edit: Record<number, number> = {};
  let request: Record<number, number> = {};
  let sheet: Record<number, number> = {};
  let lore: Record<number, number> = {};

  if (can) {
    const editRows = await db
      .select({ id: pendingCharacterEdits.id, submittedBy: pendingCharacterEdits.submittedBy })
      .from(pendingCharacterEdits)
      .where(inArray(pendingCharacterEdits.status, ACTIONABLE as unknown as string[]));
    edit = await countUnreadComments("edit", editRows.filter((r) => r.submittedBy !== viewerId).map((r) => ({ id: r.id, submitterId: r.submittedBy })), viewerId);

    const requestRows = await db
      .select({ id: customRequests.id, requestedById: customRequests.requestedById })
      .from(customRequests)
      .where(and(
        inArray(customRequests.status, ACTIONABLE as unknown as string[]),
        notInArray(customRequests.type, STAFF_QUEUE_EXCLUDED_REQUEST_TYPES as unknown as string[]),
      ));
    request = await countUnreadComments("request", requestRows.filter((r) => r.requestedById !== viewerId).map((r) => ({ id: r.id, submitterId: r.requestedById })), viewerId);

    const sheetRows = await db
      .select({ id: characterSheets.id, ownerId: characterSheets.ownerId })
      .from(characterSheets)
      .where(inArray(characterSheets.status, ACTIONABLE as unknown as string[]));
    sheet = await countUnreadComments("sheet", sheetRows.filter((r) => r.ownerId !== viewerId).map((r) => ({ id: r.id, submitterId: r.ownerId })), viewerId);

    const loreRows = await db
      .select({ id: lorePendingEdits.id, submittedBy: lorePendingEdits.submittedBy })
      .from(lorePendingEdits)
      .where(inArray(lorePendingEdits.status, ACTIONABLE as unknown as string[]));
    lore = await countUnreadComments("lore", loreRows.filter((r) => r.submittedBy !== viewerId).map((r) => ({ id: r.id, submitterId: r.submittedBy })), viewerId);
  }

  res.json({ edit, request, sheet, lore });
});

// POST /review/:type/:id/close — a reviewer archives a RESOLVED ticket. When the
// ticket was approved this is where its deferred effect (lease / inventory /
// character materialization / diff) is finally committed. Dispatches to the
// per-queue close handler which owns the materialize logic. Idempotent.
// Mechanical params (rent / cwp / stock price) are entered by the closer at this
// CLOSE & APPLY step for custom requests — voting/override stays a single click.
// They are optional here (edits/sheets ignore them; non-param request types need
// none) and forwarded to closeRequest, which validates + applies them.
const CloseBodySchema = z.object({
  note: z.string().trim().max(2000).optional(),
  // property
  monthlyRent: z.number().optional(),
  kind: z.enum(["residential", "business"]).optional(),
  businessName: z.string().trim().max(200).optional(),
  district: z.string().trim().max(120).optional(),
  tier: z.string().trim().max(60).optional(),
  // cyberware
  cwp: z.number().optional(),
  slot: z.string().trim().max(120).optional(),
  // gun
  category: z.string().trim().max(60).optional(),
  weaponType: z.string().trim().max(60).optional(),
  fireMode: z.string().trim().max(60).optional(),
  powerLevel: z.string().trim().max(60).optional(),
  manufacturer: z.string().trim().max(120).optional(),
  // venue_stock
  unitCost: z.number().optional(),
  retail: z.number().optional(),
  qty: z.number().optional(),
  // character sheet (close): per-item mechanical attributes for CUSTOM
  // (non-catalog) cyberware / guns, keyed by index in the sheet's arrays.
  // Catalog items auto-resolve and are omitted.
  sheetCyberware: z
    .array(
      z.object({
        index: z.number().int().min(0),
        cwp: z.number().int(),
        slot: z.string().trim().max(120),
      }),
    )
    .optional(),
  sheetGuns: z
    .array(
      z.object({
        index: z.number().int().min(0),
        category: z.string().trim().max(60),
        weaponType: z.string().trim().max(60),
        fireMode: z.string().trim().max(60),
        powerLevel: z.string().trim().max(60),
        manufacturer: z.string().trim().max(120).optional(),
      }),
    )
    .optional(),
});

router.post("/review/:type/:id/close", requireAuth, async (req, res): Promise<void> => {
  const parsed = parseParams(req);
  if (!parsed) { res.status(400).json({ error: "Bad subject" }); return; }
  if (!isReviewer(req.user!)) { res.status(403).json({ error: "Only fixers / approvers / admins can close tickets" }); return; }
  const bodyParsed = CloseBodySchema.safeParse(req.body ?? {});
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid close payload" }); return; }
  const { note: rawNote, sheetCyberware, sheetGuns, ...closeParams } = bodyParsed.data;
  const note = rawNote || undefined;
  let result: ReviewActionResult;
  if (parsed.type === "edit") result = await closeEdit(req, parsed.id, note);
  else if (parsed.type === "request") result = await closeRequest(req, parsed.id, note, closeParams);
  else if (parsed.type === "lore") result = await closeLore(req, parsed.id, note);
  else result = await closeSheet(req, parsed.id, note, { sheetCyberware, sheetGuns });
  res.status(result.status).json(result.body);
});

// POST /review/:type/:id/reopen — a reviewer sends a resolved (approved |
// rejected) or closed ticket back to pending for another vote. Vote-clearing is
// per-queue: the request queue clears prior votes (so finalize-on-read doesn't
// instantly re-decide a reopened ticket), while the edit/sheet handlers manage
// their own vote lifecycle. Custom requests may reopen even when the effect was
// already applied: appliedRef is preserved so the live effect stays intact and a
// later re-close is idempotent. Dispatches to the per-queue handler.
router.post("/review/:type/:id/reopen", requireAuth, async (req, res): Promise<void> => {
  const parsed = parseParams(req);
  if (!parsed) { res.status(400).json({ error: "Bad subject" }); return; }
  if (!isReviewer(req.user!)) { res.status(403).json({ error: "Only fixers / approvers / admins can reopen tickets" }); return; }
  let result: ReviewActionResult;
  if (parsed.type === "edit") result = await reopenEdit(req, parsed.id);
  else if (parsed.type === "request") result = await reopenRequest(req, parsed.id);
  else if (parsed.type === "lore") result = await reopenLore(req, parsed.id);
  else result = await reopenSheet(req, parsed.id);
  res.status(result.status).json(result.body);
});

// ---------------------------------------------------------------------------
// Read-only Discord thread mirror (staff only). Each ticket's cs-approver
// thread is DISPLAYED on its detail page — the portal never posts to Discord.
// The cs-approver channel is internal, so this is gated to reviewers, NOT the
// submitter (unlike the comment thread above which both sides share).
// ---------------------------------------------------------------------------

// Look up the Discord thread id stored on a subject's row.
async function resolveThreadId(type: ThreadSubjectType, id: number): Promise<string | null> {
  if (type === "mission") {
    const [row] = await db.select({ t: missions.discordThreadId }).from(missions).where(eq(missions.id, id));
    return row?.t ?? null;
  }
  if (type === "edit") {
    const [row] = await db.select({ t: pendingCharacterEdits.discordThreadId }).from(pendingCharacterEdits).where(eq(pendingCharacterEdits.id, id));
    return row?.t ?? null;
  }
  if (type === "request") {
    const [row] = await db.select({ t: customRequests.discordThreadId }).from(customRequests).where(eq(customRequests.id, id));
    return row?.t ?? null;
  }
  // Lore proposals have no Discord thread mirror — the cs-approver thread
  // integration is scoped to edit/request/sheet/mission rows.
  if (type === "lore") return null;
  const [row] = await db.select({ t: characterSheets.discordThreadId }).from(characterSheets).where(eq(characterSheets.id, id));
  return row?.t ?? null;
}

// Tiny in-process cache so a reviewer's panel polling (and several reviewers on
// the same ticket) don't hammer the Discord API / hit rate limits. Keyed by
// thread id; short TTL so new replies still surface within a few seconds.
const THREAD_CACHE_TTL_MS = 8_000;
const threadCache = new Map<string, { at: number; messages: DiscordThreadMessage[] }>();

async function getThreadMessagesCached(threadId: string): Promise<DiscordThreadMessage[]> {
  const hit = threadCache.get(threadId);
  const now = Date.now();
  if (hit && now - hit.at < THREAD_CACHE_TTL_MS) return hit.messages;
  const messages = await listThreadMessages(threadId);
  threadCache.set(threadId, { at: now, messages });
  return messages;
}

// GET /review/:type/:id/discord-thread — the ticket's cs-approver thread,
// read-only. Reviewers only. Degrades gracefully: when no thread is linked yet
// (dev env, or a ticket created before backfill) returns linked:false with an
// empty message list instead of erroring.
router.get("/review/:type/:id/discord-thread", requireAuth, async (req, res): Promise<void> => {
  const type = parseThreadSubjectType(String(req.params.type));
  const id = parseInt(String(req.params.id), 10);
  if (!type || !Number.isFinite(id) || id <= 0) { res.status(400).json({ error: "Bad subject" }); return; }
  const parsed = { type, id };
  if (!isReviewer(req.user!)) { res.status(403).json({ error: "Reviewers only" }); return; }
  const subject = await resolveSubject(parsed.type, parsed.id);
  if (!subject) { res.status(404).json({ error: "Not found" }); return; }
  const threadId = await resolveThreadId(parsed.type, parsed.id);
  if (!threadId) {
    res.json({ linked: false, threadId: null, webUrl: null, messages: [] });
    return;
  }
  const messages = await getThreadMessagesCached(threadId);
  res.json({ linked: true, threadId, webUrl: threadWebUrl(threadId), messages });
});

export default router;
