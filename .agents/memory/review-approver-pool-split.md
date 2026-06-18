---
name: Review approver pool vs staff access
description: Two distinct reviewer notions in the review pipeline; approver pool is CS_APPROVER-only (fixers/admins are staff but NOT approvers); read-path tallies must filter to the eligible pool too.
---

The review pipeline (sheets, character edits, misc requests) has TWO distinct
"reviewer" notions in `api-server/src/lib/review.ts` — keep them apart:

- `isReviewer(u)` → STAFF ACCESS: FIXER || CS_APPROVER || ADMIN (minus
  TRIAL_FIXER). Gates queue visibility, roster display, Discord thread,
  close/reopen, dashboard counts.
- `isEligibleReviewer(u)` → APPROVER POOL: **CS_APPROVER ONLY**. NOT fixers,
  NOT admins. Gates who may cast a counted vote, who appears in the
  eligible-reviewer roster, and who counts toward the majority threshold.
  Applies across ALL THREE queues (sheets, edits, AND misc requests like venue
  stock / gun templates — those are no longer "fixer-voted").

**Why:** "Cs Approver" (a distinct Discord role, name-mapped in role config) is a SEPARATE role
from "Fixer". Being a fixer must NOT make you an approver, and not being a fixer
must NOT exclude you. Fixers keep STAFF ACCESS (see queues/roster/thread via
`isReviewer`) but cannot cast a counted vote anywhere. Pure ADMINs likewise are
not approvers — they act through the admin-only OVERRIDE endpoints
(`/override`, `hasRole ADMIN`). Matching by role NAME works: "cs approver" is an
alias of CS_APPROVER in `discord.ts` ROLE_ALIASES, already populated from the
Discord role name — no id-based check needed.

**How to apply:**
- Vote endpoints + any reviewerPool filter gate on `isEligibleReviewer` (now
  CS_APPROVER-only).
- Detail-endpoint `canVote`/`canRequestChanges` use the eligible flag
  (`viewerCanVote`/`canCast`), NOT `isReviewer`/`isStaff`.
- Override endpoints stay `hasRole ADMIN`. Roster visibility / thread / close /
  reopen stay on `isReviewer` (fixers + admins are staff).
- Frontend: `canVote = isCsApprover` gates vote buttons + awaitingVote;
  OVERRIDE on `isAdmin`; SEE THREAD/roster + tab visibility on the broad staff
  set (`isFixer || isCsApprover || isAdmin`, mirrors `isReviewer`).
- Shrinking the pool from fixer+cs to cs-only can push pending tickets over
  threshold — finalize-on-read (see stale-pool-finalize-on-read) self-heals them.
- api-server vote-pipeline tests grant voters BOTH `["fixer","cs approver"]` so
  pool sizes stay identical to the old fixer-based tests.
- READ-PATH TALLY TRAP: list + detail endpoints compute approveCount/rejectCount
  from raw votes. They MUST filter to the eligible-voter set first (mirrors
  `tallyReviewVotes`), or a stale admin-only vote skews the displayed tally even
  though the decision math ignored it. Mirror sheets-list: filter votes for
  counts/voters but keep `myVote` from the full vote list.
- request-changes endpoints are RETIRED (return error); `canRequestChanges` is a
  vestigial UI hint.
