---
name: Admin edit-and-push-through keeps votes
description: Admin (non-owner) edits of in-flight submissions must keep votes; owner edits clear them. Where the owner-vs-admin fork lives and the frontend gotcha.
---

Admins can edit a still-open submission's content and KEEP existing votes/approvals
(no re-review, no re-announce). Owner edits of the same submission still CLEAR votes
and go back for review. The fork is owner-vs-admin, decided server-side on every path:

- Character pending-edits: amend branch forks on `isAdminAmend` (non-owner + ADMIN).
  Admin amend updates only content fields (proposedDiff/beforeSnapshot/updateNote),
  preserves status/decidedAt/pendingEditApprovals, skips announceEdit.
- Misc custom-requests PATCH: clearReviewVotes runs only when `isOwnerEditing`
  (requestedById === user.id); admin edit keeps votes + writes an audit row.
- New character sheets (sheets.ts): already edit pending in place without clearing
  votes — no change needed.

**Why:** "edit and push through so we don't wait on the player" — admins fix small
problems in an already-approved/voted submission without resetting the queue.

**How to apply / gotcha:** the backend treats an admin who is ALSO the owner as an
owner (clears votes). So any admin-edit BUTTON must exclude the viewer's own rows
(`requestedById !== me?.id`, or `submittedBy !== me`) or the UI promises "votes kept"
while the backend silently clears them. Match the frontend gate to the backend fork.
