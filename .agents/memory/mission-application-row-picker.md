---
name: Mission application row picker
description: Why list and detail must share one picker when a player holds many application rows per mission.
---

A player can hold MULTIPLE `mission_applications` rows on one mission — the unique
index is per `(missionId, characterId)`, so different characters (or a withdrawn
row + a re-applied row) coexist. The single `myApplication` surfaced to the viewer
must be chosen consistently across every read path.

**Rule:** select the surfaced row with the shared `pickMyApplicationView` +
`APPLICATION_STATUS_RANK` (accepted=0, pending=1, withdrawn=2, rejected=3; within a
tier prefer newest `createdAt`). Use it in BOTH `getMissionDetail` and
`loadMyApplicationsForMissions` (the open-list cards).

**Why:** the two paths historically diverged — detail picked `[...][0]` (OLDEST by
createdAt ASC) while the list used a last-wins `out.set` (NEWEST). The detail page
hides the apply form whenever `myApplication` is a non-withdrawn row, so surfacing a
stale older pending sibling locked a player out of reapplying the character they
withdrew ("can't reapply, just grayed out"). A withdrawn-only state must fall
through (rank below active) so the apply/reapply form renders.

**How to apply:** any NEW read path that surfaces a viewer's own application for a
mission must route through `pickMyApplicationView`, never `[0]` or last-wins. This is
read-time selection — it applies to all existing missions with no migration. Note:
`rejected`-only is a separate dead-end (no reapply) and is intentional/out of scope.
