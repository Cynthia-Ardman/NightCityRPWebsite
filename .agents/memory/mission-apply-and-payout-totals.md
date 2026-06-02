---
name: Mission apply UI + actor-payout totals
description: Two product/semantic decisions for the mission flow — staff may apply as players, and payout batch totals are display-parity sums.
---

## Mission apply UI is NOT manager-gated
ApplySection on the mission detail renders for EVERYONE (incl. fixers/admins), and
getMissionDetail always populates `myApplication` from the viewer's own application
(do not force it null for managers). ApplySection self-hides unless the mission is
open or the viewer already has a non-withdrawn application.

**Why:** NCRP staff also play characters. The old `!data.canManage` gate (and
manager `myApplication=null`) meant staff clicking APPLY landed on the detail page
with no PC-selection form, and couldn't reapply after a manual add/remove. The
backend `applyToMission` permits any user (incl. the owning fixer) to apply with
their own character; the UI must not be more restrictive.

**How to apply:** Keep the full applicant pool (`applications`) manager-gated via
`ownsMissionApplications`, but never gate the viewer's own apply form / own
application status on manage rights.

## Actor-payout batch total = display-parity sum, not "disbursed"
`getStandaloneActorPayouts` `totalPaid` sums EVERY actor row's amount, including
`simulated` (Test mode) and `failed` rows — so the collapsed PayActors header
equals the sum of the per-actor amounts shown when expanded.

**Why:** A paid-only sum showed €$0 in the collapsed header during Test mode while
the expanded rows listed real amounts. Do not revert to paid-only.

**How to apply:** If a true "actually disbursed" figure is ever needed, add a
SEPARATE metric (e.g. `totalDisbursed`) rather than narrowing this aggregate; the
same parity expectation applies to the per-player and acting aggregates nearby.
