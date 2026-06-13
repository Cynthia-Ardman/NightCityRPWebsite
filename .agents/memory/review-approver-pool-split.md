---
name: Review approver pool vs staff access
description: Two distinct reviewer notions in the review pipeline; admins are staff but NOT approvers; read-path tallies must filter to the eligible pool too.
---

The review pipeline (sheets, character edits, misc requests) has TWO distinct
"reviewer" notions in `api-server/src/lib/review.ts` — keep them apart:

- `isReviewer(u)` → STAFF ACCESS: FIXER || CS_APPROVER || ADMIN (minus
  TRIAL_FIXER). Gates queue visibility, roster display, Discord thread,
  close/reopen, dashboard counts.
- `isEligibleReviewer(u)` → APPROVER POOL: FIXER || CS_APPROVER only (minus
  TRIAL_FIXER). NO admin. Gates who may cast a counted vote, who appears in the
  eligible-reviewer roster, and who counts toward the majority threshold.

**Why:** a pure ADMIN (no fixer/cs-approver) must NOT show up as an eligible
approver or be able to vote — they act through the separate admin-only OVERRIDE
endpoints (`/override`, gated on `hasRole ADMIN`). Mixing the two let admins leak
into the approver roster + vote math.

**How to apply:**
- Vote endpoints + any reviewerPool filter gate on `isEligibleReviewer`.
- Detail-endpoint `canVote`/`canRequestChanges` use the eligible flag
  (`viewerCanVote`/`canCast`), NOT `isReviewer`/`isStaff`.
- Override endpoints stay `hasRole ADMIN`. Roster visibility / thread / close /
  reopen stay on `isReviewer` (admin is staff).
- Frontend: `canVote = isFixer || isCsApprover` gates vote buttons + awaitingVote;
  OVERRIDE on `isAdmin`; SEE THREAD/roster on `isReviewer`.
- READ-PATH TALLY TRAP: list + detail endpoints compute approveCount/rejectCount
  from raw votes. They MUST filter to the eligible-voter set first (mirrors
  `tallyReviewVotes`), or a stale admin-only vote skews the displayed tally even
  though the decision math ignored it. Mirror sheets-list: filter votes for
  counts/voters but keep `myVote` from the full vote list.
- request-changes endpoints are RETIRED (return error); `canRequestChanges` is a
  vestigial UI hint.
