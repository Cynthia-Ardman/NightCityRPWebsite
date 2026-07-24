---
name: LOA has two independent flags — all billing must honor both
description: characters.lifeStatus="loa" vs character_status.loa boolean are separate; billing crons that check only one silently overcharge players who set the other.
---

There are TWO distinct LOA mechanisms and they do NOT sync:
- `characters.lifeStatus = "loa"` — the HEADLINE status dropdown, set via review /
  admin / importer (importer maps an old character_status.loa to lifeStatus="loa").
  Checked by `countsForCyberwareBilling()` / `CYBERWARE_EXCLUDED_LIFE_STATUSES`.
- `character_status.loa` (boolean) — the SELF-SERVICE toggle a player flips on the
  website via `PATCH /characters/:id/status`. This is what a player means by "I set
  LOA on the website." It does NOT touch lifeStatus (their headline can stay
  "active"/"missing" while loa=true).

**Why it bit us:** monthly_rent honored `character_status.loa`, but the weekly
cyberware meds cron (`cyberware_humanity`) filtered only on lifeStatus. A player who
self-served LOA (loa=true, lifeStatus="missing") kept getting billed meds week after
week. Fix: meds job now also excludes `character_status.loa===true` from billing AND
household-multiplier grouping (a paused member must not add +25% to active members).

**Second bite (July 2026):** the dashboard `/dashboard/upcoming-bills` PROJECTION did
not honor `character_status.loa` while the crons did — player saw meds/rent "due" on
the dashboard despite being correctly not charged. Any bill *preview/projection* must
mirror the exact exclusion rules of the cron it forecasts (LOA flags, paused
residential leases), or players report phantom charges.

**How to apply:** ANY billing-critical or "is this character active" read must consider
BOTH the headline lifeStatus AND the self-service character_status.loa flag. Checking
one alone is a silent-overcharge bug. The two flags are independent by design — do not
"fix" it by syncing them; honor both everywhere money is debited.
