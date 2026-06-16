---
name: Dashboard counts must mirror review-queue semantics
description: Why staff dashboard tallies have to match the actual reviewable queue, not a raw global count.
---

The staff dashboard surfaces "N pending X" cards that link to a review queue. If the
dashboard count is a RAW GLOBAL tally while the queue (and the sidebar unseen-counts)
exclude the viewer's OWN submissions, the dashboard can read "1 pending" with nothing for
the viewer to action — because a reviewer can't vote on their own submission
(canVote = !isOwner).

**Rule:** A dashboard "to-review" count must use the SAME gating as the queue it links to:
reviewer-gated, and excluding the viewer's own rows. Use `ownerId IS DISTINCT FROM viewerId`
(treats null owner as "not me", so unowned rows still surface).

**Why:** The review unseen-counts endpoint already excludes own submissions; a divergent
dashboard count is the outlier that produces the phantom-pending complaint.

**How to apply:** When adding/auditing any dashboard staff tally, check it against the
queue's filter (own-exclusion + role gate). Note the queue LIST itself (e.g. /sheets/pending)
may still include own rows for visibility — that's a separate, lower-severity inconsistency.

## Second parity axis: request TYPE exclusion (not just own-exclusion)

The staff custom-request queue (`GET /requests`) excludes the My-Requests-only types
`stock_cost` (owner-approved), `employee_invite` (invitee-decided), and
`mission_participation` (player-decided) — they never appear in staff triage. But the
reviewer unseen endpoints (`/review/unseen-counts` and `/review/unseen-ids`, which feed the
dashboard "Pending Requests" card, the misc-tab badge, AND PendingRequests' land-on-first-
unseen-tab logic) historically selected actionable `customRequests` by STATUS only, with no
type exclusion. A pending+unseen request of an excluded type then counted on the card/badge
while the queue it links to rendered nothing → recurring phantom "1 pending request, nothing
there". `mission_participation` is created on every mission roster, so this recurs often.

**Rule:** count surfaces and the queue must exclude the SAME types. The list is exported as
`STAFF_QUEUE_EXCLUDED_REQUEST_TYPES` from `requests.ts` (single source of truth) and reused
by both the queue and the two reviewer unseen blocks via `notInArray`. Any new staff
custom-request count must reuse that constant, not re-list types inline.

**Why:** own-exclusion alone is insufficient parity; type-exclusion is a second independent
axis that produced the same phantom symptom.

## Third axis: client-side cache invalidation after a vote

Even with correct server-side parity, the dashboard "Pending Sheets" card and the
sidebar staff sheet badge can show a STALE count after a reviewer votes, because
those are independent react-query caches. The sheet vote/override/resubmit
mutations (SheetDetail's shared `invalidate()`) must invalidate
`getGetDashboardSummaryQueryKey()` (Home's Pending Sheets card) and
`getGetReviewUnseenCountsQueryKey()` (AppLayout staff badge) — not just the sheet
detail + pending list. Opening the sheet only marks-seen (clears unseen badges via
ReviewCommentThread); it does NOT refetch the dashboard summary, whose count is the
voted-exclusion query.

**Rule:** any review action that changes what a staff count surface should show
must invalidate that surface's query key, not only the detail/list it lives on.

## Fourth axis: UNSEEN vs UNVOTED — all review cards source from /review/unseen-counts

The recurring "Sheets to Review: N but nothing new/unread" phantom came from the
two dashboard review cards using DIFFERENT metrics: the "Requests to Review" card
(and the sidebar badge) used `/review/unseen-counts` (UNSEEN = excludes own +
already-opened, clears the moment the reviewer OPENS the item), while the "Sheets
to Review" card used a separate `dashboard/summary.pendingSheets` tally that counted
pending sheets the reviewer had NOT yet VOTED on (clears only on a cast vote). A
reviewer who opened every pending sheet but abstained saw a permanent count with
nothing they perceived as new. (Both items were legitimately below the majority
threshold — NOT stranded; verify threshold = `majorityOf(eligibleReviewers)` before
suspecting a finalize-on-read bug.)

**Rule:** every dashboard review card AND the sidebar badge must source from the
single `/review/unseen-counts` endpoint (which returns edits/requests/sheets).
Never add a second divergent "pending/unvoted" tally for a review card. The
dashboard `summary.pendingSheets` field was REMOVED for this reason; `Home.tsx`
sheets card now reads `reviewUnseen.sheets`.

**Why:** "unvoted" and "unseen" are different metrics; a "new/unread" nudge card
must use unseen (which the user reads as "nothing new"), and a single source
prevents the two cards from diverging again. This SUPERSEDES axis 3's note about
invalidating `getGetDashboardSummaryQueryKey()` for the sheets card — the sheets
card no longer reads the dashboard summary at all.
