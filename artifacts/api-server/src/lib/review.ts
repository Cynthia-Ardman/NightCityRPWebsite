import { and, desc, eq, inArray } from "drizzle-orm";
import { db, users, reviewVotes, type User } from "@workspace/db";
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

// A reviewer is anyone with FIXER, CS_APPROVER, or ADMIN. Admins are included
// so the operator team can always unstick a vote. The submitter of a given
// subject is excluded from that subject's eligible pool at tally time (you
// can't approve your own submission).
export function isReviewer(u: User): boolean {
  return hasRole(u.roles, "FIXER") || hasRole(u.roles, "CS_APPROVER") || hasRole(u.roles, "ADMIN");
}

// All distinct users currently holding a reviewer role, minus an excluded
// user (the submitter). Computed live on every tally so role grants/revokes
// take immediate effect on the majority threshold. Small set in practice.
export async function listEligibleReviewerIds(excludeUserId: string | null): Promise<string[]> {
  const rows = await db.select({ id: users.id, roles: users.roles }).from(users);
  return rows
    .filter((r) => isReviewer({ roles: r.roles ?? [] } as User))
    .map((r) => r.id)
    .filter((id) => id !== excludeUserId);
}

// Majority = floor(n / 2) + 1. With n=0 (no other reviewers) this returns 1
// so any single qualified vote applies.
export function majorityOf(n: number): number {
  return Math.floor(n / 2) + 1;
}

// ---------------------------------------------------------------------------
// Generic review_votes helpers (sheets + requests).
// ---------------------------------------------------------------------------

export type ReviewSubjectType = "sheet" | "request";

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

// Upsert one reviewer's vote (last write wins). Use inside the decision txn.
export async function castReviewVote(opts: {
  subjectType: ReviewSubjectType;
  subjectId: number;
  voterId: string;
  vote: "approve" | "reject";
  note: string | null;
  conn?: DbConn;
}): Promise<void> {
  const conn = opts.conn ?? db;
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
