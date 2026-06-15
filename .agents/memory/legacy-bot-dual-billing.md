---
name: Legacy bot dual-billing (cyberware meds)
description: The old NightCityBot still runs cyberware-meds billing in prod alongside our live website cron, causing double charges and divergent week/streak counts.
---

The old NightCityBot is STILL running cyberware-meds billing in production at the same time as our website's `cyberware_humanity` cron (bot_config `cyberware_autobill_enabled=true` + `cyberware_live_mode=true` + `master_live_mode=true`). Both debit the same UnbelievaBoat wallet, so chromed players get billed twice in one week.

**Symptom:** a player's DM from "NightCityBot" says one week/amount (e.g. "high level, week 6 ... $1,250") while the website shows a different, usually lower week. The legacy wording — "weekly cyberware meds", "week N of missed checkups", "Streak is now N week(s)", "Gave checkup role to", "Ripperdoc checkup on X. No money deducted." — does NOT exist in our codebase; our memo reads `Weekly cyberpsychosis meds (high, N chrome, week W, household xM)` with `kind='meds'`, `source='website'`.

**Why the week counts diverge:** our streak is per-USER and resets when ANY of the owner's characters gets a ripperdoc checkup (most recent `lastCheckupAt ?? createdAt` across the household, via `weeksSinceLastCheckup`). A checkup on a chrome-FREE character still resets the chromed character's meds clock. The legacy bot keeps its own incrementing counter and does not see our checkups.

**Why:** the migration brought the website's economy live without decommissioning the legacy bot's cyberware job. Until the legacy job is turned off, every chromed player is double-billed and the two systems will never agree on streak.

**How to apply:** if a user reports a website-vs-DM week/charge mismatch for cyberware meds, suspect dual-billing first — check `wallet_transactions` (kind='meds', source='website') AND ask whether they also got a NightCityBot DM. Do not "fix" our streak math to match the legacy number; the legacy job needs to be disabled (operator/owner decision — financial, needs user sign-off) and duplicate charges refunded.

## Refunding a legacy bot run

**Authoritative source of who/how-much the legacy bot charged:** `OLD_BOT_DATABASE_URL` (NOT `PROD_DATABASE_URL`, which is a different legacy DB). Table `cyberware_weekly_runs` holds only `paid_ids[]`/`unpaid_ids[]` (no amounts); the actual per-user $ deducted is in `balance_history(user_id, ts, cash_delta, bank_delta, reason='Cyberware meds week N')` — aggregate by user over a tight `ts` window around the run's `run_at`.

**"Double-charge" is per-user, not assumed:** only ~26/46 of one run were also billed by the website that cycle (verify via prod `wallet_transactions` kind='meds' source='website'); the rest the website intentionally skipped (no chrome / recent checkup / LOA). Refunding ALL of a decommissioned bot's final run is still defensible (website is now sole authority), but confirm scope + message wording with the operator.

**Executing money/DM writes from the dev workspace:** `patchBalance` (UB) and `sendDirectMessage` both no-op unless `externalWritesAllowed()` — i.e. run the one-off with `ALLOW_EXTERNAL_WRITES=1`. UB **PATCH is additive** (delta), so a positive `cash` credits. The live site's reconcile job then writes the wallet-history ledger rows automatically — you do NOT (and cannot) write the live prod ledger from here.

**Idempotency for a multi-user money loop:** two-phase per-user state file (mark refunded BEFORE sending the DM) so a re-run never double-credits, only retries an unsent DM. DRY_RUN mode MUST NOT persist state (it'll mark everyone done and skip the real run). Script: `artifacts/api-server/scripts/refund-legacy-meds.ts` (+ `refund-data.json`, `refund-state.json`).

**DM delivery:** Discord 403 code `50278` ("no mutual guilds") = the user left the server; unfixable, skip (their refund still applies).
