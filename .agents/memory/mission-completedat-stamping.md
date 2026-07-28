---
name: mission completedAt stamping
description: completedAt is the canonical completion signal; every status advance into completed_* must stamp it.
---

# Mission completedAt stamping

All "upcoming mission" predicates (applicant booked-badge, my-applications upcomingOnly, edit gates, NPC signup gate) key on `missions.completedAt IS NULL`. But the payout lifecycle advances `status` into `completed`/`completed_players_paid`/`completed_paid` at three UPDATE sites, and historically did so WITHOUT stamping `completedAt` — finished missions kept surfacing as "upcoming" (stale "Accepted to upcoming mission" badges).

**Rule:** any write that moves `missions.status` into a completed_* value must also `completedAt = COALESCE(completedAt, now())` — use the shared `completedAtStamp()` helper in missionsService.ts. Upcoming predicates should also exclude `MISSION_COMPLETED_STATUSES` as belt-and-braces for legacy rows.

**Why:** status and completedAt are two independent completion signals; drifting them apart breaks every completedAt-only filter. 12 prod rows had completed_* status + NULL completedAt (backfilled from start_at, 2026-07-28).
