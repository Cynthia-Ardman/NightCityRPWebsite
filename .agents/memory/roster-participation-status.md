---
name: Roster participation status
description: How a mission roster's per-player "accepted/pending" indicator is derived
---

# Roster participation status

A mission roster row's confirmation state (player accepted the invite vs. awaiting
their reply) is NOT stored on `mission_assignments`. It is DERIVED in
`getMissionDetail` from `custom_requests` rows where `type='mission_participation'`,
matched by `characterId` AND `details.missionId === missionId` (the missionId lives
inside the JSON `details`, so it must be filtered in code, not just by characterId).

Mapping: request `status='approved'` → `accepted`; `status='pending'` → `pending`;
anything else / no row → `null` (e.g. a fixer self-assigning their own character
raises no participation request).

**Why:** the same character can have participation requests across multiple missions,
and a still-pending invite must never inherit an older mission's accept. A pending
row therefore OUTRANKS an accepted one when both exist for the same character+mission
scope.

**How to apply:** any new surface that wants this indicator must replicate the
`details.missionId` scoping + pending-precedence, not read a column. The badge is
shown to all viewers (acceptance isn't sensitive), unlike payAmount which stays
canManage/own-row gated.


## Former index detail (full)
roster accepted/pending DERIVED from custom_requests mission_participation (scoped details.missionId; pending>accepted; null=none); My Applications DERIVE accepted from a live assignment (status never flips) ([desync](mission-application-status-desync.md)); a player holds many app rows/mission so list+detail share pickMyApplicationView (active>pending>withdrawn>rejected, newest) ([picker](mission-application-row-picker.md)).
