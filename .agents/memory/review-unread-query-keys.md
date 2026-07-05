---
name: Review unread badges have THREE independent query keys
description: Why marking a review ticket seen must clear all three unread caches, optimistically, from every read entrypoint.
---

The portal has THREE separate unread surfaces backed by THREE React Query keys:
- Per-card magenta line + NEW dot + "New" landing tab → `getGetReviewUnseenIdsQueryKey()` (GET /review/unseen-ids), reviewer-gated, returns `{edit,request,sheet}` id arrays.
- Staff "Pending Requests" tab counts + sidebar nav badge → `getGetReviewUnseenCountsQueryKey()` (GET /review/unseen-counts), reviewer-gated, returns `{edits,requests,sheets,total}` (PLURAL keys).
- Player "My Requests" badge + per-row unread dots → `getGetMyUnseenQueryKey()` (GET /review/my-unseen), submitter's OWN rows, `{edit,request,sheet,total}`.

**Rule:** Any change to `review_seen` state must clear ALL THREE keys, and clearing must be
OPTIMISTIC (not refetch-driven) to feel instant. Use the shared `useMarkReviewSeenInstant()`
hook (artifacts/ncrp-portal/src/hooks/useReviewSeen.ts): it removes the id / decrements the
counts in all three caches up front, then fires `useMarkReviewSeen` and invalidates all
three on settle. Decrement counts only when the id was actually present in the ids/my-unseen
cache, so re-reading is a no-op and badges never go negative.

**Why:** markSeen originally invalidated only counts + my-unseen — NOT unseen-ids — so the
per-card line/dot never cleared on read (the recurring "I opened it but the line stays"
bug). And invalidation alone waits on a refetch, so nothing cleared "instantly".

**Read entrypoints (BOTH must mark seen):** opening the inline "View & Respond" discussion
(ReviewCommentThread mount) AND opening the "See Thread" Discord drawer (DiscordThreadDrawer
onOpen) — the drawer is a primary read action. The drawer also serves missions, which have
NO server unread state; gate the server markSeen on subjectType ∈ {edit,request,sheet}. The
Discord gold-glow is a SEPARATE localStorage marker (`discordThreadSeen:*`) tracking unread
Discord replies; it clears on drawer open and is intentionally independent of server seen.

**How to apply:** When adding any new unread/seen-driven badge, route its clear through
`useMarkReviewSeenInstant`; don't branch on role — clearing all three is cheap and avoids
context-specific drift.

**Numeric discussion-unread badge (VIEW & RESPOND):** GET /review/unread-detail
(`getGetReviewUnreadDetailQueryKey`) returns per-queue `Record<subjectId, count>`. The count is
the reviewer↔player two-party discussion, so it counts ONLY comments authored by that ticket's
SUBMITTER (edit/lore=submittedBy, request=requestedById, sheet=ownerId) newer than the viewer's
lastSeenAt — NOT fellow reviewers' comments (those would inflate the badge whenever staff
discuss). Pass the per-subject submitterId into `countUnreadComments`, don't just exclude the
viewer. markSeen advances lastSeenAt so vote/override/open all zero it automatically.

**Out of scope (separate concern):** my-unseen counts a submission as unseen from creation
(no seen row is written at submit time), so a freshly submitted ticket lights the player's
own badge until they open it. That's the unseen model, not this cache bug.


## Former index detail (full)
mark-seen/post-comment must invalidate BOTH staff unseen-counts AND player my-unseen keys or a badge goes stale; the /review/my-unseen My Requests badge ([detail](my-unseen-phantom-badge.md)) counts own rows across ALL statuses, so every counted row MUST be renderable in MyRequests or the badge sticks.
