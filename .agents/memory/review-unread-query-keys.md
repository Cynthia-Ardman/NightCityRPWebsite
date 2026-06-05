---
name: Review unread badges have two independent query keys
description: Why marking a review ticket seen must invalidate both the staff and player unread caches.
---

The portal has TWO separate unread surfaces backed by TWO React Query keys:
- Staff "Pending Requests" badge/counts → `getGetReviewUnseenCountsQueryKey()` (GET /review/unseen-counts), reviewer-gated, excludes own.
- Player "My Requests" badge + per-row unread dots → `getGetMyUnseenQueryKey()` (GET /review/my-unseen), the submitter's OWN rows.

**Rule:** Any mutation that changes `review_seen` state — `useMarkReviewSeen` (fired by
ReviewCommentThread's markSeenOnMount) and `usePostReviewComment` — must invalidate BOTH
keys, not just one.

**Why:** ReviewCommentThread is shared by staff and submitters. It originally invalidated
only the staff counts key, so a submitter who opened their own ticket wrote the seen row
server-side but the my-unseen cache never refetched → a stale "1" badge that never cleared
until a natural refetch/reload. (Symptom in live data: every unseen row showed seen=NEVER.)

**How to apply:** When adding any new unread/seen-driven badge, check which query key its
mutation invalidates; invalidate every consumer key of the seen state. Don't branch on
role — invalidating both is cheap and avoids context-specific drift.

**Out of scope (separate concern):** my-unseen counts a submission as unseen from creation
(no seen row is written at submit time), so a freshly submitted ticket lights the player's
own badge until they open it. That's the unseen model, not this cache bug.
