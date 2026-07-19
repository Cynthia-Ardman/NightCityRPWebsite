---
name: VRChat instance session history
description: How group-instance session recording works — sources, close semantics, and what analytics can/can't know.
---

# VRChat instance session history

`vrchat_instance_sessions` is the durable, never-pruned history behind the live
`vrchat_instances` cache; the poller writes both. Key semantics:

- One OPEN live session per location enforced by a partial unique index
  (`WHERE closed_at IS NULL AND source='live'`); a location string reused after
  close starts a NEW row (VRChat reuses locations across instance lifetimes).
- Close = absence from a SUCCESSFUL poll; `closedAt = lastSeenAt` (the last
  poll that saw it), never "now", so durations aren't inflated by the poll gap.
- Recording is best-effort inside one transaction per poll tick — a failure
  must never break the live instance browser refresh.
- `source` is `live` (poller) or `vrcx` (imported VRCX gamelog rows).
  **uniqueUsers is only knowable for vrcx rows** — the group-instances API
  returns head counts, never identities; occupancy averages come from
  sampleCount/sumUserCounts per-poll sums.
- Analytics `openNow` is global (not range-scoped); other totals filter on
  first_seen_at >= since.
- The poller only runs deployment-gated, so dev accrues no history; dev serves
  the prod live-cache but session rows only appear in prod's DB.

**Why:** analytics needs lifetimes/occupancy long after instances close, and
merging live + VRCX sources in one table lets one analytics query cover both.
**How to apply:** any VRCX importer must write `source='vrcx'` sessions (may
set uniqueUsers) and must NOT collide with the live partial index.
