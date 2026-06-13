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

// Two distinct notions of "reviewer" — keep them apart:
//
//   isReviewer        → STAFF ACCESS to the review queues (view the roster,
//                        open tickets, see the Discord thread, close/reopen,
//                        staff dashboard counts). FIXER, CS_APPROVER, or ADMIN.
//   isEligibleReviewer → APPROVER POOL: who may cast a *counted* vote, appears
//                        in the eligible-reviewer roster, and is counted in the
//                        majority threshold. FIXER or CS_APPROVER only.
//
// Admins are intentionally NOT in the approver pool. An admin who does not also
// hold a fixer/cs-approver role does not appear as an eligible approver and
// cannot vote — they act through the separate admin-only OVERRIDE path instead
// (per-type `/override` endpoints, gated on hasRole ADMIN). This stops a pure
// admin from showing up as a reviewer for character sheets, edits, or misc
// requests while still letting the operator team unilaterally unstick a queue.
//
// Trial fixers are a NARROW mission-author tier — they never review/vote on
// anything. We exclude them up front so a lingering or dual "fixer" role name
// (e.g. stored roles not yet re-synced after the trial-fixer rollout) can't
// leak them into either pool. The marker is id-derived, so this never wrongly
// excludes a real admin/cs-approver.
export function isReviewer(u: User): boolean {
  if (hasRole(u.roles, "TRIAL_FIXER")) return false;
  return hasRole(u.roles, "FIXER") || hasRole(u.roles, "CS_APPROVER") || hasRole(u.roles, "ADMIN");
}

// The approver pool: who may cast a counted vote and is counted in the majority
// threshold. FIXER or CS_APPROVER only — admins are excluded (they override).
export function isEligibleReviewer(u: User): boolean {
  if (hasRole(u.roles, "TRIAL_FIXER")) return false;
  return hasRole(u.roles, "FIXER") || hasRole(u.roles, "CS_APPROVER");
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
