---
name: Cyberware vs general billing scope
description: lifeStatus exclusion applies to cyberware billing only, not rent/trauma/baseline; and the free corporate trauma tier
---

# Cyberware household excludes LOA/retired/dead; general billing does not

Cyberware meds + household-multiplier billing must EXCLUDE characters whose
`characters.lifeStatus` (lowercased) ∈ {dead, retired, loa}, effective the
instant the status flips. Rent, trauma, baseline, and xanadu fees still bill the
FULL set of approved non-archived PCs.

**Why:** users asked that switching a character to LOA/retired/dead immediately
stop their meds cost and stop them inflating other household members' bills —
but those statuses are not meant to waive rent/trauma/baseline.

**How to apply:**
- Shared helper `countsForCyberwareBilling(c)` + `CYBERWARE_EXCLUDED_LIFE_STATUSES`
  live in `lib/jobs.ts`. The `cyberware_humanity` cron `.filter`s `approvedChars`
  through it BEFORE owner grouping.
- `dashboard.ts /dashboard/upcoming-bills` keeps the full `billable` set for
  rent/trauma/baseline and derives a SEPARATE `cyberBillable = billable.filter(countsForCyberwareBilling)`
  used only for cyberware calcs (billableIds, charLastCheckup, maxChromeCount,
  household, anchor loop, breakdown). Do NOT collapse these two sets.
- Keyed on the headline `lifeStatus` dropdown field, NOT the transient
  `character_status.loa`.

# Free "corporate" trauma tier (fixer-assignable only)

`traumaTeamTier` now includes `"corporate"` (a comped corporate-sponsorship
tier), cost 0 in `DEFAULT_TRAUMA_TEAM_COSTS`.

**Why:** corporate is a free perk only staff should grant.

**How to apply:**
- Cost-0 means cron + dashboard already skip charging it via their existing
  `traumaCost > 0` guards — don't add special-casing.
- Player gate is enforced server-side in `createPendingEdit` (pending-edits.ts):
  if the noop-stripped diff sets `traumaTeamTier === "corporate"` and the
  submitter isn't ADMIN/FIXER → `forbidden` error kind → 403 in characters.ts
  PATCH. The diff is noop-stripped, so only changing INTO corporate is blocked;
  a player who already has it keeps it.
- Any NEW server write path that sets traumaTeamTier must re-apply this gate
  (admin.ts create is staff-only; player create path doesn't accept trauma tier).
- Enum lives in 3 OpenAPI schemas + EditableSchema + admin TRAUMA_TIERS set;
  after editing openapi.yaml run codegen + rebuild api-client-react dist.


## Former index detail (full)
LOA/retired/dead excluded from cyberware household+meds ONLY (separate cyberBillable), not rent/trauma/baseline; free "corporate" trauma tier (cost 0, fixer-only via createPendingEdit forbidden gate).
