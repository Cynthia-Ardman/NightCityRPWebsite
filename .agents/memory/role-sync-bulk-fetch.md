---
name: role_sync bulk fetch & definite-clear
description: How the role_sync cron reads Discord roles and when it is safe to clear a user's roles to empty.
---

The `role_sync` job prefers a single bulk snapshot (`fetchAllGuildMemberRoles()` — paginates `GET /guilds/{id}/members?limit=1000`, ~1 call per 1000 members) over the old 2-calls-per-user path. Runs hourly (`0 * * * *`).

**Definite-vs-conservative clearing rule:** only persist an EMPTY `users.roles` (i.e. clear stale role names) when the read is *definite*. A non-null bulk result is a complete snapshot, so every lookup against it is definite — an absent member has genuinely left the guild → clear. The per-user fallback returns `[]` identically for "no roles" and a transient fetch failure, so it stays conservative and never clears on empty (only overwrites when it saw names).

**Why:** before the bulk path, the per-user fetch couldn't distinguish "no roles" from "fetch failed", so it skipped empty writes — which meant a member who lost their LAST role (or left) kept stale roles forever. The bulk snapshot makes "no roles" trustworthy, so we can finally reconcile removals. Persistence guard: `if (definite || roles.length || roleIds !== null)` and `set({ ...(definite || roles.length ? { roles } : {}), verified18, rolesSyncedAt })`.

**How to apply:** never clear roles from a partial/uncertain read. `fetchAllGuildMemberRoles()` returns null on any page failure OR page-cap hit specifically so the caller falls back instead of mass-clearing from an undercount. verified18 stays null-guarded (only recomputed when roleIds !== null). The per-user fallback is retained on purpose: it's the only path that works if the bot lacks the Server Members Intent (bulk would always null). Known tradeoff: a bulk failure triggers the expensive per-user sweep that hour — acceptable since a single bulk call rarely 429s.
