---
name: Vote toggle (un-vote)
description: Re-casting the same review vote clears it; voting is single-click toggle across all three review types. Pause is a third, marker-only vote.
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

## Pause vote (marker only)

A third vote value `pause` exists on all three queues (NOT lore, NOT
player-facing MyRequests). It follows the same toggle/switch semantics but is a
VISIBLE MARKER ONLY: tallies expose a separate `pauseCount`, and NO decision
path (threshold check, auto-finalize/finalize-on-read, close) ever counts or is
blocked by pauses — only approve/reject decide. `pauseCount` is OPTIONAL in
every OpenAPI schema (reused shapes — see openapi-list-only-fields). Pipeline
tests in all three `*.pipeline.test.ts` files lock the marker-only + toggle
guarantee; any future vote type must preserve "pauses never decide or veto".

**How to apply:** toggle only happens while status is `pending` (handlers guard
+ FOR UPDATE lock), so you can never un-decide a finalized ticket. Clearing only
LOWERS counts → can't spuriously decide. Override endpoints are admin-only and
NOT toggle. Any new vote surface that re-uses `castReviewVote` inherits toggle —
don't assume idempotent upsert.
