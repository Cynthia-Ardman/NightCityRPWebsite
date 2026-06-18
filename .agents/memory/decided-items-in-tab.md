---
name: Decided items render in-tab (no Ready-to-Apply banner)
description: How approved/rejected sheets/edits/misc render as glow cards inside their own queue tabs with Close & Apply / Reopen, pinned to top.
---

The Pending Requests page has NO top "Ready to Apply" banner. Instead, every
review queue tab surfaces its OWN decided-but-not-closed items (status
`approved`/`rejected`) inline as green/red glow cards with the Close & Apply /
Close + Reopen lifecycle actions.

**The pattern (mirror MiscRequestsTab for any new queue):**
- Fetch BOTH the `active` bucket and the `resolved` bucket.
- Filter resolved to ONLY `approved`/`rejected` (drop `cancelled`), merge into the
  active grid, then `sortReviewItems(...)` then `decidedFirst(...)` (in
  `requests/reviewSort.tsx`) to pin decided rows to the top while preserving sort
  order within each group.
- Render `<LifecycleActions subjectType=... id status actions />` (from
  `components/review/ReviewLifecycleUI.tsx`) and set the card `tone`
  (`approved`/`rejected`) on `ReviewQueueCard`.
- `actions = useReviewTicketActions(invalidate)`.

**Why:** decided items must be actionable where the reviewer already is, not in a
separate banner; decided-first keeps just-acted items visible.

**activeOnly trap (PendingEditsList ReviewerEditsList):** the merge of decided
rows into the active grid happens ONLY in embedded `activeOnly` mode (the tab on
Pending Requests). The full standalone edits page (`activeOnly=false`) keeps
decided rows in their own Resolved bucket section — merging there would
double-render. Resolved bucket is always fetched now; archive stays gated on
`!activeOnly`.
