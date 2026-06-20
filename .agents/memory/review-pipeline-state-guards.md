---
name: Review-pipeline state guards
description: Why request-changes/resubmit/submit must use status-guarded conditional UPDATEs, not read-then-write.
---

In the three review queues (character EDITS = pending_character_edits/pending_edit_approvals; new SHEETS + custom REQUESTS = review_votes), the **vote** and **override** paths lock the subject row `FOR UPDATE` inside a txn. The **request-changes**, **resubmit**, and sheet **submit** paths are read-then-write and do NOT take that lock.

**Rule:** the state mutation in request-changes/resubmit/submit must be an atomic conditional UPDATE guarded by the current status, returning the row, and 409 if no row matched:
- request-changes: `UPDATE ... SET status='changes_requested' WHERE id=? AND status='pending' RETURNING` → 409 if none.
- resubmit: inside a txn, `UPDATE ... SET status='pending' WHERE id=? AND status='changes_requested' RETURNING`; only then clear votes/approvals; 409 if none.
- sheet submit/resubmit: `... WHERE id=? AND status IN ('draft','changes_requested')`.

**Why:** a plain read-then-write lets a concurrent deciding vote/override slip in between the read and the write. Unconditional write would clobber an already-decided (approved/rejected) row back to changes_requested/pending, and a resubmit flipping approved→pending could let a later vote materialize the character/inventory a SECOND time.

**How to apply:** any new transition handler on these subjects that isn't already holding `FOR UPDATE` must guard its UPDATE by the expected source status and surface 409 on a no-op. See request-review-race.md for the approve/reject-specific variant (lock + re-check).

## Reopen must clear votes; staged decisions stay voteable (requests queue)

**Rule (custom REQUESTS queue):** `reopenRequest` MUST `clearReviewVotes` inside its txn. The `/requests/:id/vote` guard allows `pending|approved|rejected` (NOT just pending) and re-derives status from the live tally every cast — a removed/flipped vote (castReviewVote is toggle: re-cast same vote = remove) walks a decided ticket back to `pending` (wipe reviewedBy/At/Note/decisionParams/overriddenBy + `request_vote_reverted` audit). `/requests/:id/override` `editable` includes `rejected` so admin can override-approve a vote-rejected staged ticket.

**Why:** preserving votes on reopen made reopen a visible no-op — `finalizeDecidedRequestsInPlace` (finalize-on-read in GET /requests) re-tallied the carried-over votes and instantly re-decided the ticket. Under deferred-effects, approved/rejected are only STAGED (effect commits at close), so they must remain editable until close — reviewers shouldn't have to reopen just to change their minds.

**How to apply:** do NOT block the vote path on `appliedRef` — a reopened-after-applied ticket is `pending` with `appliedRef` preserved, and re-voting it is the entire point of reopen (re-close is idempotent because close only materializes on `approved && !appliedRef`). The `review.ts` reopen dispatcher comment is per-queue: only the request queue clears votes; sheet/edit handlers manage their own vote lifecycle (sheets reopen still PRESERVES votes — leave it).
