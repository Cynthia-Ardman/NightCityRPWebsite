---
name: Guild-absence billing pause
description: How leaving the Discord server auto-pauses weekly meds/household billing and rejoin resumes it.
---

# Guild-absence billing pause

`users.inGuild` (default true) + `users.guildLeftAt` are maintained ONLY by the hourly role_sync cron, and ONLY on a DEFINITE bulk member snapshot — a partial/per-user fallback read never flips the flag in either direction (neither pausing nor resuming). Absent member ⇒ inGuild=false + guildLeftAt + audit row (`billing.guild_absence_paused`, category `wallet`); reappearing ⇒ inGuild=true, guildLeftAt cleared, audit `billing.guild_rejoin_resumed` so staff see the resume.

**Billing effect:** the weekly `cyberware_humanity` cron filters out every character whose ownerId is in the inGuild=false set, at the same tier as the LOA exclusions — no meds charge AND no household-multiplier inflation. Rent (monthly_rent) deliberately still charges by staff policy default.

**Why:** a player racked up five figures of meds debt while out of the guild because pausing required manual per-character LOA.

**How to apply:** any new recurring personal charge that should pause for absent players must consult `users.inGuild` alongside the two LOA flags; anything writing inGuild outside role_sync's definite branch is a bug.
