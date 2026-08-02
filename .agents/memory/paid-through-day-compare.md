---
name: Rolling paid_through guards compare by day, not instant
description: Second-precision "paid through" idempotency stamps silently skip a whole billing cycle when the next run reaches the row earlier than last cycle's stamp.
---

Rule: any rolling "paid through" / "billed until" idempotency guard must compare at billing-period granularity (UTC day for the monthly rent job), never exact timestamps. The stamp lands at the second the row happened to be processed, so processing-order jitter makes the next cycle's check see "still paid" and skip the whole period — with no delinquency flag or retry (the system believes it's paid).

**Why:** the monthly rent cron stamped leases `paid_through = charge-time + 1 month` (second precision). The next month's run started at 04:00:00 and skipped every lease stamped later than the second it reached them — 26 of ~35 leases silently missed a month; a prod catch-up backfill was required.

**How to apply:** guard with `dayUTC(paidThrough) > dayUTC(now)` (or period-start compare). Same-period rerun safety is preserved because a successful charge advances the stamp a full period. When backfilling missed charges via one-off script, pace UnbelievaBoat PATCH calls (~2.5s apart, retry on 429) — burst debits get rate-limited.
