---
name: Legacy character auto-claim on Discord login
description: When a user logs in via Discord, back-fill ownerId for any imported characters whose legacyDiscordUsername matches that user's current username or globalName. Never clobber a non-null ownerId.
---

When importing characters from a legacy source that has only a Discord
display name (not a user ID), the row lands with `owner_id = NULL` and
the original string saved in `legacy_discord_username`. The portal does
not know who that maps to until the user logs in for the first time.

**Rule:** in the OAuth callback, after upserting the `users` row, run an
UPDATE on `characters` setting `(owner_id, claimed) = (user.id, true)`
WHERE `owner_id IS NULL` AND lower(legacy_discord_username) matches
either `discordUser.username` or `discordUser.global_name`.

**Why:** The legacy importer can only match users currently in the
guild at import time. Anyone who joined later, changed names, or was
in the guild but couldn't be resolved gets `owner_id = NULL`. Without
this hook those characters stay orphaned forever and the player has to
ask an admin to claim them. With it, the very next login fixes it.

**How to apply:** Guard the update with `isNull(ownerId)` so we never
overwrite an admin-assigned owner. Wrap in try/catch and log warn on
failure — the back-fill must not block login.
