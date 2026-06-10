---
name: Owner assignment provisions stub users for never-signed-in members
description: How staff assign a character to any Discord guild member, including people with no users row yet.
---

Staff owner-assignment paths must NOT 404 when the target has no `users` row.
Instead, provision a minimal stub `users` row from the Discord profile.

**Rule:** owner-assignment endpoints (character create + reassign) resolve an
ownerId through a shared helper that returns the existing user OR mints a stub
keyed on the Discord id, then assigns it. The stub is keyed on `users.id` =
Discord snowflake (same PK the OAuth upsert uses).

**Why:** the `users` table only holds people who have signed in. Staff need to
assign characters to anyone in the guild (e.g. a returning player who hasn't
logged into the portal yet). A stub row keyed on the Discord id is adopted on
first login (the OAuth callback updates the existing-id row, filling session
fields), so the ownership set now is preserved seamlessly. Legacy
auto-claim-by-username only touches rows where `characters.ownerId IS NULL`, so
it never clobbers a stub-backed assignment. Stub insert uses
onConflictDoNothing + race re-read (two concurrent assigns to the same new
member).

**How to apply:** any new path that takes an ownerId/userId for a *guild member*
(not strictly an existing portal user) should route through the same
resolve-or-provision helper rather than a bare `users` lookup + 404. The picker
UI searches the whole guild via the bot member-search endpoint (`hasAccount`
flag distinguishes signed-in vs stub). Note: the resolver validates the Discord
user exists, not strictly guild membership — fine because the UI only offers
guild members and the route is staff-gated; tighten with a guild-member lookup
only if API-level guild-only enforcement is ever required.

**Shared helper:** the resolve-or-provision logic lives in
`lib/userProvision.ts` (`resolveOrProvisionUser`); admin owner-assignment AND
the actor-pay paths both use it (admin's `resolveOrProvisionOwner` is now a thin
alias). Don't re-inline the select→fetchDiscordUser→insert-onConflict→re-read
pattern.

**Actor-pay corollary (two parts):** "find/pay ANY discord user" surfaces have
TWO gaps, not one. (1) A bare `users`/character-name search misses guild members
who never signed in — merge `searchGuildMembers(q)` into the results
(best-effort: on null, return local-only rather than failing the search). (2)
The pay path inserts into `mission_actor_payments`, whose `user_id` is NOT NULL
with an FK to `users.id` — so provision the stub BEFORE the insert, and if
provisioning returns null (Discord unreachable / bogus id) you MUST skip the
insert and count it failed, never fall through to the insert, or you throw an
unhandled FK 23503 mid-batch after earlier actors were already paid. Both
`payStandaloneActors` and `payMissionActors` need this.
