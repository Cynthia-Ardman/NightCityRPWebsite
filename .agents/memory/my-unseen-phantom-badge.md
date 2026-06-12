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

3. **Bare submission triggered its own author's badge (the real recurring
   cause).** `my-unseen` is documented to count only rows with reviewer-side
   activity ("a reviewer comment or a decision/close"), but the impl set
   `baseAt = max(submittedAt/createdAt, decidedAt, closedAt)` (always ≥ the
   submission time) and `listUnseenIds` counts any row with **no `review_seen`
   row** (`if (!s || ...)`). So the instant a player submitted a pending
   edit/request/sheet they got a "1" on their OWN My Requests badge with zero
   reviewer activity — a phantom that recurs on every submission. Note the row
   IS renderable, so invariant #1 doesn't catch this; it's a *trigger* bug, not
   a renderability gap. Fix: in `my-unseen` only, pass
   `baseAt = maxDateOrNull(decidedAt/reviewedAt, closedAt)` (drop the submission
   ts; `maxDateOrNull` returns null when none set) and
   `listUnseenIds(..., { excludeCommentAuthor: viewerId })`; `listUnseenIds`
   skips items whose computed `activityAt` is null. Reviewer callers
   (`unseen-counts`/`unseen-ids`/`countUnseen`) still pass `submittedAt` as a
   non-null baseAt and omit `excludeCommentAuthor`, so their behavior is
   unchanged — a new pending submission SHOULD notify reviewers.
   **Why:** the submission timestamp is activity *to a reviewer*, never to the
   author; conflating the two views in one shared `baseAt` is the trap.

4. **`closedAt` re-pinged the submitter on already-seen resolved rows.**
   Note #3's fix kept `closedAt` in the submitter `baseAt`. But a reviewer's
   administrative close (archiving an already-decided ticket) bumped `closedAt`
   past the submitter's `review_seen` row, re-lighting the badge on a request the
   player had already read the decision for — the "completed request stays
   pinged" bug. Fix: submitter `baseAt` now uses ONLY the decision ts
   (`r.decidedAt ?? null` / `r.reviewedAt ?? null`); `closedAt` is dropped from
   the maps (still SELECTed, just unused). Reviewer comments still notify via the
   `lastComment` merge in `listUnseenIds`. **Why:** to the submitter a close is
   not new information — only the decision (and reviewer comments) should ping
   them; reviewer-side callers never used `closedAt` for the submitter view.

**Why not a backend union on `/pending-edits`** (`or(staffWhere, submittedBy=me)`):
the staff Pending Requests queue consumes the same endpoint and does NOT filter
own rows from display, so a union would pollute the reviewer's own queue with
their old terminal edits. Keep the fix on the consumer (MyRequests).

**Rejected alternative:** restricting my-unseen to active states only — kills the
legit "your request was decided" unread dot on resolved rows.
