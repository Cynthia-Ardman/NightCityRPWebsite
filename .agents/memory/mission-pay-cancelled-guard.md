---
name: Mission pay-path cancelled/completed symmetry
description: Both mission pay paths (players AND actors) must refuse cancelled missions; cancel does not set completedAt.
---

A mission has two independent "don't pay" states that are stored differently:
- **completed** → `missions.completedAt` is set (managed by `setMissionCompleted`,
  independent of `status`).
- **cancelled** → `missions.status = 'cancelled'`, and `completedAt` stays NULL.

So a `completedAt IS NULL` guard does NOT cover cancelled missions, and a
`status <> 'cancelled'` guard does NOT cover completed ones. Any pay path must
check BOTH.

**Why:** `payMissionPlayers` always refused cancelled missions, but
`payMissionActors` only blocked on `completedAt` — so a fixer could pay actors
real eddies on a cancelled mission. The two pay paths drifted out of symmetry.

**How to apply:**
- Both `payMissionPlayers` and `payMissionActors` must refuse `status==='cancelled'`
  AND `completedAt != null`. Keep them symmetric whenever you touch either.
- For `payMissionActors`, the cheap top-level read guard is not enough on its own:
  the atomic reservation `INSERT ... SELECT ... WHERE EXISTS(...)` must ALSO re-check
  `completed_at IS NULL AND status <> 'cancelled'` so a concurrent
  cancel/complete that commits between the read and the reservation can't slip a
  payout through. Same pattern as the existing completion-lock atomic re-check.
- Paying actors who showed up to a cancelled session is an explicit, separate
  action: use `payStandaloneActors` (non-mission, `missionId = null`), never a
  mission-linked payout.
