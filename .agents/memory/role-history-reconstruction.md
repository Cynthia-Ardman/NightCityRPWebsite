---
name: Role history reconstruction
description: How to reconstruct who held a Discord role (fixer etc.) over time — sources, gaps, and scraping traps.
---

**Rule:** Neither the website DB nor Discord keeps queryable role history. `users.roles` is overwritten in place by role_sync; audit_log never records role changes; Discord's own audit-log API retains only ~45 days.

**Best source:** Dyno's #bot-logs channel (id 1349160856688267285) contains role-update embeds: `**<@id> was given the/removed from the \`Role\` role**` (footer `ID: <uid>`). But role-change logging only starts ~2026-02-08 (channel itself starts 2025-06-11). Reconstruct rosters by taking the CURRENT `users.roles` set and undoing logged events in reverse; anything unlogged is assumed stable. Clamp roles to 0 before their creation date — derive role creation from the role-id snowflake (`(id>>22)+1420070400000`).

**Trap:** currently-held roles whose "given" event predates logging survive backward-undo into the initial set even if impossible (e.g. Trial Fixer holders "before" the role existed) — sanity-check against role creation dates.

**Scraping traps:** Discord REST 403s python-urllib's default User-Agent — set `User-Agent: DiscordBot (...)`. Page channels at ~1 page/s (100 msgs); ~30k msgs per 280s shell run; keep a `before`-cursor file so runs resume.

**Active-player time series:** monthly distinct union of bot_attendance_log, attendance_claims, activity-driven bot_balance_history reasons (attendance/actor pay/mission payout/business activity — NOT rent/meds, those bill inactives), activity_events.actor_id, audit_log.actor_id, site_activity_daily (starts 2026-07-20), and vrchat_instance_visits joined via vrchat_links (spans 2025-03→now; unlinked visitors counted by vrchat id).
