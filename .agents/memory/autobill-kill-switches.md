---
name: Autobill kill switches
description: Housing and cyberware monthly billing crons are gated on bot_config flags that default OFF. Manual admin runs bypass the switch by design.
---

Two scheduled jobs charge player wallets and must default OFF in fresh
environments so a deploy never silently bills players before staff are
ready:
- `housing_autobill_enabled` gates the `monthly_rent` cron (housing
  rent + monthly lifestyle, which fire in the same job).
- `cyberware_autobill_enabled` gates the `cyberware_humanity` cron
  (weekly cyberpsychosis meds).

**Rule:** read the flag from `bot_config` with `isAutobillEnabled(key)`
in the cron callback. Only the literal JSON `true` enables; everything
else (missing row, false, null, "", numbers, strings) keeps it OFF.
On DB read failure, treat as OFF.

**Why:** "Default to safe / fail-safe" — never charge real player
balances on the first cron tick after a deploy or after a DB hiccup.
Staff explicitly opt in from the System Jobs admin tab.

**How to apply:** Gate at the cron schedule level only. Do NOT gate
inside `runJob()` itself — admin pressing the manual "Run" buttons in
the Jobs tab is an explicit, supported test path and must always
execute regardless of switch state. Any new wallet-debiting cron must
get its own kill-switch flag added to `AUTOBILL_FLAGS` and a toggle
in `AdminDashboard.JobsTab`.
