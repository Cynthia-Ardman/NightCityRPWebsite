---
name: Vote toggle (un-vote)
description: Re-casting the same review vote clears it; voting is single-click toggle across all three review types.
---

# Vote toggle (un-vote)

Reviewer voting on requests, sheets and pending-edits is TOGGLE: clicking the
vote value you already hold (approve→approve or reject→reject) CLEARS your vote
(deletes the row); switching value (approve↔reject) updates in place.

- requests + sheets: shared `castReviewVote` (lib/review.ts) does
  select-existing → delete-if-same → else upsert; returns the resulting vote or
  `null` when cleared.
- pending-edits: votes live in the SEPARATE `pendingEditApprovals` table, so the
  toggle is replicated INLINE in the vote handler (inside the FOR UPDATE tx); the
  vote response includes a `cleared` boolean.

**Why:** product requirement — a second click un-votes so reviewers can retract.

**How to apply:** toggle only happens while status is `pending` (handlers guard
+ FOR UPDATE lock), so you can never un-decide a finalized ticket. Clearing only
LOWERS counts → can't spuriously decide. Override endpoints are admin-only and
NOT toggle. Any new vote surface that re-uses `castReviewVote` inherits toggle —
don't assume idempotent upsert.
