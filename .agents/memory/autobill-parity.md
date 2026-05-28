---
name: Autobill parity (monthly_rent)
description: monthly_rent cron bills 6 line items per period (residential rent, business rent, lifestyle, baseline, trauma team, xanadu). LOA and idempotency rules differ per line item.
---

The `monthly_rent` cron in `artifacts/api-server/src/lib/jobs.ts` runs
six independent billing passes in a single job invocation. They share
the same kill-switch (`housing_autobill_enabled`) and the same
in-memory caches (LOA lookup, owner lookup, "already billed this
period" set).

**LOA rule (matches NightCityBot):**
- Residential housing rent → skipped on LOA.
- Business housing rent (`housing.kind = 'business'`) → bills anyway.
- Lifestyle, baseline, trauma team, xanadu gold → all personal fees,
  skipped on LOA.

**Why:** business venues keep operating while their owner is away;
personal fees are paused so a player on hiatus doesn't burn through
eddies they can't replenish.

**Idempotency rule:**
- Housing leases: skip if `paid_through > now`. The rent loop bumps
  `paid_through` by one month on every successful debit, so a manual
  rerun in the same period is a no-op.
- Personal fees: at the top of the job, query
  `wallet_transactions` for rows with `kind IN (lifestyle, baseline,
  trauma_team, xanadu_gold)` and `created_at >= start of current UTC
  month`. Build a `Set<"charId:kind">` and skip any pair already
  present. Update the set in memory after each successful debit so
  later passes in the same run don't double-charge either.

**Known crash-window race (not currently guarded):** UB debit
succeeds but the process dies before the wallet row (or
`paid_through` bump) commits. A manual retry inside the same period
will re-debit. NightCityBot has the same exposure. Fix is a
transactional pending/succeeded marker — open task, not part of
parity scope.

**How to apply:** Any new monthly bill type belongs in this same job
under the same kill switch. Add its kind to `TRACKED_PERSONAL_KINDS`
so the period guard catches it, and remember to call `markBilled`
after the successful insert. Default cost should live in
`bot_config` with a hardcoded fallback in `jobs.ts` so a fresh deploy
is internally consistent.
