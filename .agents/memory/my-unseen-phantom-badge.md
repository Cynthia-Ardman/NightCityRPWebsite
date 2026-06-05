---
name: My Requests "my-unseen" phantom badge
description: Why the My Requests nav unread badge can stick at a count with no openable row, and the invariant that prevents it.
---

# My-unseen phantom badge

The "My Requests" left-nav unread badge is driven by `GET /review/my-unseen`
(`review.ts`). It counts the submitter's OWN edit/request/sheet rows that have
activity (a reviewer comment, decision, or close) newer than their last "seen"
row — across **every status, with no time window**.

The badge / per-row unread dot is cleared per-item by opening the row
(`ReviewCommentThread` marks-seen on mount, which must invalidate
`getGetMyUnseenQueryKey()` — see review-unread-query-keys). If a counted item is
NOT rendered in My Requests, there is no row to open, so the badge can never
clear → a stuck "phantom" count.

**Invariant: every row `my-unseen` can count MUST be renderable in
`MyRequests.tsx`.** The unseen scope and the list-fetch scope have to agree.

## Known divergence sources (both fixed)

1. **Staff-windowed edits.** `/pending-edits` is staff-scoped for reviewers: its
   default view returns open edits + anything decided in the last 7 days. A
   reviewer's own OLD terminal edit (e.g. cancelled >7 days ago) is counted by
   my-unseen but never returned by the default list. Fix: MyRequests fetches all
   three lifecycle buckets (`active`/`resolved`/`archive`) and merges by id —
   together they cover every status with no 7-day window (`resolved` =
   approved/rejected/cancelled, `archive` = closed, no time filter). The existing
   `e.submittedBy === me.id` filter discards other players' edits the staff
   buckets return. For non-reviewers the server ignores `bucket` and each call
   returns all own edits, so the merge just de-dupes.

2. **Draft sheets.** My Requests deliberately hides `status === "draft"` sheets,
   but my-unseen's sheet query had no status filter. Fix: exclude drafts in the
   my-unseen sheet query (`ne(characterSheets.status, "draft")`).

`/requests/mine` and `/sheets` (non-draft) are already owner-scoped across all
statuses, so requests and non-draft sheets were never phantom.

**Why not a backend union on `/pending-edits`** (`or(staffWhere, submittedBy=me)`):
the staff Pending Requests queue consumes the same endpoint and does NOT filter
own rows from display, so a union would pollute the reviewer's own queue with
their old terminal edits. Keep the fix on the consumer (MyRequests).

**Rejected alternative:** restricting my-unseen to active states only — kills the
legit "your request was decided" unread dot on resolved rows.
