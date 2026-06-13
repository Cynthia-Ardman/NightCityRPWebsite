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
