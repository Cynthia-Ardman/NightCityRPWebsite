---
name: Stale-pool finalize-on-read
description: Why review tickets strand pending and how reviewer reads must self-heal them
---

A review decision (approve/reject) is only evaluated at the moment a vote is
cast. The threshold is `majorityOf(eligibleReviewerPool)`. When the eligible
pool SHRINKS afterward (a reviewer's role is revoked or they leave the guild),
the threshold can drop below the already-cast approvals — but nothing
re-evaluates, so the ticket stays `pending` with no Close & Apply.

**Why:** vote-cast is the only decision trigger; pool size is computed live at
read time but the status transition was never re-run after the pool changed.

**How to apply:** on reviewer-facing reads, re-evaluate and finalize stuck
pending tickets, applying the SAME status transition the vote handler makes.
Must be: locked (`FOR UPDATE` on the row), re-check `status === 'pending'`
inside the tx, idempotent, and reviewer-gated. Materialization stays DEFERRED
to close — finalize only flips status (+ stages decisionParams for request
approve / sets decisionBy/Note for sheets / decisionSummary for edits).
All three surfaces need it: requests (`/requests` list), sheets
(`/sheets/pending` + `/sheets/:id`), pending-edits (`/pending-edits` +
`/pending-edits/:id`). requests+sheets use review_votes; edits use
pendingEditApprovals (raw FOR UPDATE, no audit row, activityEvents on reject).
