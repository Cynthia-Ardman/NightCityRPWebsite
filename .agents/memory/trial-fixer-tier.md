---
name: Trial-fixer author-only tier
description: How the TRIAL_FIXER role is gated so it can author missions but never review/vote.
---

Trial fixers are a NARROW tier: they may author/propose missions but are otherwise
normal users — NOT on any approval roster, vote tally, or eligibleReviewers list.

**Rule:** enforce on TWO surfaces, or stale data bypasses the gate:
1. `lib/review.ts isReviewer` returns false when `hasRole(roles,"TRIAL_FIXER")`, checked
   BEFORE the FIXER/CS_APPROVER/ADMIN checks. This is the robust runtime gate even if
   stored roles still carry a lingering "fixer" name.
2. `lib/discord.ts applyRoleIdGrants` strips FIXER∪COORDINATOR names (built from
   ROLE_NAMES) before adding the trial marker when the trial-fixer role id is present.
   This is the canonical data fix that self-heals `isFixer` on the next role_sync.

**Why:** a transitional/mistaken dual grant (trial-fixer id + leftover "fixer" name)
would otherwise let a trial fixer vote. Gating only one surface is a silent bypass —
same failure mode as the cyberware/audit "enforcement surfaces" entries.

**How to apply:** any new review/eligibility path must run through `isReviewer`; any new
role-derivation path must respect the strip. The marker is display-only and does not
confer COORDINATOR access.

## Trial fixers self-manage their OWN approved mission (roster/post/pay only)

A trial fixer may FULLY run a mission they personally authored once it reaches
`workflowState ∈ {approved, posted}` — roster (accept/reject/remove), post-to-board,
and pay-actors — but nothing else. Per-mission manage auth is centralized:
`canManageMissionRow(m, viewer) = isManager OR (isTrialAuthor && owns m && approved/posted)`,
surfaced via `getMissionManageAuth`/`getMissionDetail.canManage` and enforced on write
routes through `ensureCanManageMission`.

**Two recurring leak classes when widening `canManage` to trial owners:**
1. **Global cross-mission tools** (e.g. `actor-search`) must NOT key off `canAuthorMissions`
   — that opens them to EVERY trial fixer. Scope to actual owners via
   `viewerHasManageableMission(viewerId)` (owns ≥1 approved/posted mission).
2. **`canManage`-gated UI that hits manager/reviewer-only endpoints** (convert-to-event is
   `isManager`-only; `/review/:type/:id/discord-thread` is `isReviewer`-only — and trial
   fixers are NOT reviewers) becomes dead-UI/403 for trial owners. Gate those on a
   frontend `isFullManager = me.isFixer || me.isAdmin` (useAuthMe), NOT on `canManage`.

**Why:** widening `canManage` is invisible to every sibling that trusted it to mean
"full manager"; each must be re-classified as roster/post/pay (allow owner) vs
full-manager/reviewer (keep restricted). Completion stays on `canComplete` (excluded).

**How to apply:** before reusing `canManage` for a new control, check the target
endpoint's real auth; if it's manager/reviewer-only, gate the UI on `isFullManager`.
