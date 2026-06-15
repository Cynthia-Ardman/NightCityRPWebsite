---
name: Legacy bot dual-billing (cyberware meds)
description: The old NightCityBot still runs cyberware-meds billing in prod alongside our live website cron, causing double charges and divergent week/streak counts.
---

The old NightCityBot is STILL running cyberware-meds billing in production at the same time as our website's `cyberware_humanity` cron (bot_config `cyberware_autobill_enabled=true` + `cyberware_live_mode=true` + `master_live_mode=true`). Both debit the same UnbelievaBoat wallet, so chromed players get billed twice in one week.

**Symptom:** a player's DM from "NightCityBot" says one week/amount (e.g. "high level, week 6 ... $1,250") while the website shows a different, usually lower week. The legacy wording — "weekly cyberware meds", "week N of missed checkups", "Streak is now N week(s)", "Gave checkup role to", "Ripperdoc checkup on X. No money deducted." — does NOT exist in our codebase; our memo reads `Weekly cyberpsychosis meds (high, N chrome, week W, household xM)` with `kind='meds'`, `source='website'`.

**Why the week counts diverge:** our streak is per-USER and resets when ANY of the owner's characters gets a ripperdoc checkup (most recent `lastCheckupAt ?? createdAt` across the household, via `weeksSinceLastCheckup`). A checkup on a chrome-FREE character still resets the chromed character's meds clock. The legacy bot keeps its own incrementing counter and does not see our checkups.

**Why:** the migration brought the website's economy live without decommissioning the legacy bot's cyberware job. Until the legacy job is turned off, every chromed player is double-billed and the two systems will never agree on streak.

**How to apply:** if a user reports a website-vs-DM week/charge mismatch for cyberware meds, suspect dual-billing first — check `wallet_transactions` (kind='meds', source='website') AND ask whether they also got a NightCityBot DM. Do not "fix" our streak math to match the legacy number; the legacy job needs to be disabled (operator/owner decision — financial, needs user sign-off) and duplicate charges refunded.
