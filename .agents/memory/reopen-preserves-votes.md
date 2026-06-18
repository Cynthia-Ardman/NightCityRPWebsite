---
name: Reopen preserves votes
description: Reopening a resolved review ticket must keep prior votes; resubmit/edit-while-pending must clear them.
---

# Reopen preserves votes (not resubmit)

Across all three review types — requests (`reopenRequest`), sheets (`reopenSheet`),
pending-edits (`reopenEdit`) — REOPEN must PRESERVE the prior-round
votes/approvals (`reviewVotes` / `pendingEditApprovals`). Only the "decided"
markers are wiped (reviewedBy/At, overriddenBy, decisionParams, closedAt/By;
appliedRef is preserved). Do NOT call `clearReviewVotes` / delete approvals in a
reopen path.

**Why:** reviewers shouldn't have to re-cast the same decision just because a
ticket was reopened. Preserving is SAFE because every type has finalize-on-read
(`finalizeDecidedRequest/Sheet/Edit` + `*InPlace` on queue AND detail reads):
a reopened ticket lands `pending` with votes intact, then the next reviewer read
re-evaluates them against the live eligible pool/threshold and auto-finalizes
back to approved/rejected — no stranding. `castReviewVote` is an upsert
(onConflictDoUpdate on subjectType+subjectId+voterId), so any later same-voter
re-vote stays idempotent.

**How to apply:** in reopen paths, keep votes. In paths where the *content
changed by the submitter* — resubmit and edit-while-pending PATCH — votes/approvals
MUST still be cleared (a fresh round starts from zero). Don't conflate the two.
