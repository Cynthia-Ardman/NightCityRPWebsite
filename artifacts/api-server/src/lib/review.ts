import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, users, reviewVotes, reviewComments, type User } from "@workspace/db";
import { hasRole } from "./discord";

// Either the root db handle or a transaction handle — the vote helpers run
// both standalone and inside a locked decision transaction.
type DbConn = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Shared review-pipeline primitives.
//
// The portal runs three majority-vote review queues — character EDITS, new
// character SHEETS, and custom/misc REQUESTS. They all share the same notion
// of "who may review" and "how many approvals decide it". This module is the
// single source of truth for that math so the three route files can never
// drift apart. Character edits keep their dedicated `pending_edit_approvals`
// table; sheets and requests use the generic `review_votes` table via the
// helpers at the bottom.
// ---------------------------------------------------------------------------

// Two distinct notions of "reviewer" — keep them apart:
//
//   isReviewer        → STAFF ACCESS to the review queues (view the roster,
//                        open tickets, see the Discord thread, close/reopen,
//                        staff dashboard counts). FIXER, CS_APPROVER, or ADMIN.
//   isEligibleReviewer → APPROVER POOL: who may cast a *counted* vote, appears
//                        in the eligible-reviewer roster, and is counted in the
//                        majority threshold. CS_APPROVER ONLY.
//
// The approver pool is CS_APPROVER only — across ALL three review queues
// (character sheets, character edits, AND misc/custom requests like venue stock
// or gun templates). "Cs Approver" is a SEPARATE Discord role from "Fixer":
// holding a fixer role does NOT make you an approver, and you can be an approver
// without being a fixer. So fixers retain STAFF ACCESS (they still see the
// queues, the roster, comments, and the Discord thread via isReviewer) but can
// no longer cast a counted vote anywhere.
//
// Admins are likewise NOT in the approver pool — they act through the separate
// admin-only OVERRIDE path instead (per-type `/override` endpoints, gated on
// hasRole ADMIN), which unilaterally unsticks a queue without being counted as
// an approver.
//
// Trial fixers are a NARROW mission-author tier — they never review/vote on
// anything. They are excluded from staff access up front so a lingering or dual
// "fixer" role name (e.g. stored roles not yet re-synced after the trial-fixer
// rollout) can't leak them into the reviewer pool.
export function isReviewer(u: User): boolean {
  if (hasRole(u.roles, "TRIAL_FIXER")) return false;
  return hasRole(u.roles, "FIXER") || hasRole(u.roles, "CS_APPROVER") || hasRole(u.roles, "ADMIN");
}

// The approver pool: who may cast a counted vote and is counted in the majority
// threshold. CS_APPROVER ONLY — fixers (staff, but not approvers) and admins
// (who override) are both excluded.
export function isEligibleReviewer(u: User): boolean {
  return hasRole(u.roles, "CS_APPROVER");
}

// A reviewer's public identity, surfaced on detail responses so the UI can
// show the full roster of who may vote — including those who have not voted
// yet (eligible roster minus the cast votes).
export type EligibleReviewer = {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  // Display-only: true when this reviewer is a trial fixer (still on probation).
  isTrialFixer: boolean;
};

// All distinct users currently holding a reviewer role, minus an excluded
// user (the submitter), joined to their display identity. Computed live on
// every tally so role grants/revokes take immediate effect on the majority
// threshold. Small set in practice.
export async function listEligibleReviewers(excludeUserId: string | null): Promise<EligibleReviewer[]> {
  const rows = await db
    .select({ id: users.id, roles: users.roles, name: users.username, avatarUrl: users.avatarUrl })
    .from(users);
  return rows
    .filter((r) => isEligibleReviewer({ roles: r.roles ?? [] } as User))
    .filter((r) => r.id !== excludeUserId)
    .map((r) => ({
      id: r.id,
      name: r.name,
      avatarUrl: r.avatarUrl,
      isTrialFixer: hasRole(r.roles ?? [], "TRIAL_FIXER"),
    }));
}

// Id-only view of the eligible reviewer pool, used by the majority math.
export async function listEligibleReviewerIds(excludeUserId: string | null): Promise<string[]> {
  return (await listEligibleReviewers(excludeUserId)).map((r) => r.id);
}

// Majority = floor(n / 2) + 1. With n=0 (no other reviewers) this returns 1
// so any single qualified vote applies.
export function majorityOf(n: number): number {
  return Math.floor(n / 2) + 1;
}

// ---------------------------------------------------------------------------
// Generic review_votes helpers (sheets + requests).
// ---------------------------------------------------------------------------

export type ReviewSubjectType = "sheet" | "request" | "lore";

// A response-shaped result returned by the per-type close/reopen handlers in
// the route files and surfaced verbatim by the unified /review/:type/:id/close
// and /reopen endpoints.
export type ReviewActionResult = { status: number; body: unknown };

// Tally the votes for one subject against the eligible-reviewer majority.
// `submitterId` is excluded from the eligible pool. Pass a transaction handle
// as `conn` to read votes inside a locked decision transaction.
export async function tallyReviewVotes(opts: {
  subjectType: ReviewSubjectType;
  subjectId: number;
  submitterId: string | null;
  conn?: DbConn;
}): Promise<{
  approveCount: number;
  rejectCount: number;
  threshold: number;
  eligibleVoterCount: number;
  decided: "approved" | "rejected" | null;
}> {
  const conn = opts.conn ?? db;
  const all = await conn
    .select()
    .from(reviewVotes)
    .where(and(eq(reviewVotes.subjectType, opts.subjectType), eq(reviewVotes.subjectId, opts.subjectId)));
  const eligibleIds = await listEligibleReviewerIds(opts.submitterId);
  const eligibleSet = new Set(eligibleIds);
  const effective = all.filter((v) => eligibleSet.has(v.voterId));
  const approveCount = effective.filter((v) => v.vote === "approve").length;
  const rejectCount = effective.filter((v) => v.vote === "reject").length;
  const threshold = majorityOf(eligibleIds.length);
  let decided: "approved" | "rejected" | null = null;
  if (approveCount >= threshold) decided = "approved";
  else if (rejectCount >= threshold) decided = "rejected";
  return { approveCount, rejectCount, threshold, eligibleVoterCount: eligibleIds.length, decided };
}

// The most recent reviewer to have cast a given vote on a subject, or null if
// none. Used to attribute an AUTO-FINALIZED decision (one that resolves because
// the eligible pool shrank, not because a fresh vote tipped it) to the closest
// thing to a deciding reviewer — never to whoever's queue load happened to
// trigger the re-evaluation.
export async function latestVoterIdFor(opts: {
  subjectType: ReviewSubjectType;
  subjectId: number;
  vote: "approve" | "reject";
  conn?: DbConn;
}): Promise<string | null> {
  const conn = opts.conn ?? db;
  const [row] = await conn
    .select({ voterId: reviewVotes.voterId })
    .from(reviewVotes)
    .where(
      and(
        eq(reviewVotes.subjectType, opts.subjectType),
        eq(reviewVotes.subjectId, opts.subjectId),
        eq(reviewVotes.vote, opts.vote),
      ),
    )
    .orderBy(desc(reviewVotes.votedAt))
    .limit(1);
  return row?.voterId ?? null;
}

// Cast one reviewer's vote with TOGGLE semantics. Use inside the decision txn.
// If the reviewer re-casts the SAME vote they already have, the vote is CLEARED
// (deleted) so a second click on "approve"/"reject" un-votes. Switching to the
// other value just updates in place. Returns the reviewer's resulting vote, or
// null if it was cleared.
export async function castReviewVote(opts: {
  subjectType: ReviewSubjectType;
  subjectId: number;
  voterId: string;
  vote: "approve" | "reject";
  note: string | null;
  conn?: DbConn;
}): Promise<"approve" | "reject" | null> {
  const conn = opts.conn ?? db;
  const [existing] = await conn
    .select({ vote: reviewVotes.vote })
    .from(reviewVotes)
    .where(
      and(
        eq(reviewVotes.subjectType, opts.subjectType),
        eq(reviewVotes.subjectId, opts.subjectId),
        eq(reviewVotes.voterId, opts.voterId),
      ),
    );
  if (existing && existing.vote === opts.vote) {
    await conn
      .delete(reviewVotes)
      .where(
        and(
          eq(reviewVotes.subjectType, opts.subjectType),
          eq(reviewVotes.subjectId, opts.subjectId),
          eq(reviewVotes.voterId, opts.voterId),
        ),
      );
    return null;
  }
  await conn
    .insert(reviewVotes)
    .values({
      subjectType: opts.subjectType,
      subjectId: opts.subjectId,
      voterId: opts.voterId,
      vote: opts.vote,
      note: opts.note,
    })
    .onConflictDoUpdate({
      target: [reviewVotes.subjectType, reviewVotes.subjectId, reviewVotes.voterId],
      set: { vote: opts.vote, note: opts.note, votedAt: new Date() },
    });
  return opts.vote;
}

// Delete every vote for a subject — called when an item is resubmitted so the
// next review round starts from a clean slate.
export async function clearReviewVotes(opts: {
  subjectType: ReviewSubjectType;
  subjectId: number;
  conn?: DbConn;
}): Promise<void> {
  const conn = opts.conn ?? db;
  await conn
    .delete(reviewVotes)
    .where(and(eq(reviewVotes.subjectType, opts.subjectType), eq(reviewVotes.subjectId, opts.subjectId)));
}

export type ReviewVoteRow = {
  id: number;
  voterId: string;
  voterName: string | null;
  voterAvatarUrl: string | null;
  vote: string;
  note: string | null;
  votedAt: Date;
};

// Fetch votes for a subject joined to voter identity, newest first. Used by
// the detail endpoints to render the "votes cast" panel.
export async function listReviewVotes(opts: {
  subjectType: ReviewSubjectType;
  subjectId: number;
}): Promise<ReviewVoteRow[]> {
  return db
    .select({
      id: reviewVotes.id,
      voterId: reviewVotes.voterId,
      voterName: users.username,
      voterAvatarUrl: users.avatarUrl,
      vote: reviewVotes.vote,
      note: reviewVotes.note,
      votedAt: reviewVotes.votedAt,
    })
    .from(reviewVotes)
    .leftJoin(users, eq(users.id, reviewVotes.voterId))
    .where(and(eq(reviewVotes.subjectType, opts.subjectType), eq(reviewVotes.subjectId, opts.subjectId)))
    .orderBy(desc(reviewVotes.votedAt));
}

// Bulk-load votes for many subjects of one type in a single query, grouped by
// subjectId. Used by list endpoints to attach tallies without N+1 queries.
export async function loadVotesBySubject(opts: {
  subjectType: ReviewSubjectType;
  subjectIds: number[];
}): Promise<Map<number, ReviewVoteRow[]>> {
  const out = new Map<number, ReviewVoteRow[]>();
  if (opts.subjectIds.length === 0) return out;
  const rows = await db
    .select({
      id: reviewVotes.id,
      subjectId: reviewVotes.subjectId,
      voterId: reviewVotes.voterId,
      voterName: users.username,
      voterAvatarUrl: users.avatarUrl,
      vote: reviewVotes.vote,
      note: reviewVotes.note,
      votedAt: reviewVotes.votedAt,
    })
    .from(reviewVotes)
    .leftJoin(users, eq(users.id, reviewVotes.voterId))
    .where(and(eq(reviewVotes.subjectType, opts.subjectType), inArray(reviewVotes.subjectId, opts.subjectIds)))
    .orderBy(desc(reviewVotes.votedAt));
  for (const r of rows) {
    const { subjectId, ...rest } = r;
    const list = out.get(subjectId);
    if (list) list.push(rest);
    else out.set(subjectId, [rest]);
  }
  return out;
}

// Compute each subject's "last activity" timestamp = max(its base timestamp,
// its newest review comment). This mirrors the unseen-tracking activityAt
// (comments-only) so "recently updated" sorting in the review queues stays
// consistent with the unread-badge signal. Returns a Map keyed by subject id;
// every input id is present (defaulting to its baseAt) so callers never miss a
// row. Bulk: one grouped comment query, no N+1.
export async function loadLastActivityBySubject(
  subjectType: "sheet" | "request" | "edit" | "lore",
  items: Array<{ id: number; baseAt: Date }>,
): Promise<Map<number, Date>> {
  const out = new Map<number, Date>(items.map((i) => [i.id, i.baseAt]));
  if (items.length === 0) return out;
  const ids = items.map((i) => i.id);
  const rows = await db
    .select({ subjectId: reviewComments.subjectId, last: sql<string>`max(${reviewComments.createdAt})` })
    .from(reviewComments)
    .where(and(eq(reviewComments.subjectType, subjectType), inArray(reviewComments.subjectId, ids)))
    .groupBy(reviewComments.subjectId);
  for (const r of rows) {
    const d = new Date(r.last);
    const cur = out.get(r.subjectId);
    if (!cur || cur < d) out.set(r.subjectId, d);
  }
  return out;
}
