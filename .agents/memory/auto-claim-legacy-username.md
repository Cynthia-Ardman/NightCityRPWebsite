---
name: Legacy character auto-claim & fuzzy reconciliation
description: Back-fill characters.ownerId from legacy_discord_username via NORMALIZED handle matching (login hook + batch). Match username only (never global_name); prefer sibling propagation; never clobber a non-null ownerId.
---

Imported characters land with `owner_id = NULL` and the author's pre-migration
Discord handle in `legacy_discord_username`. The portal can't resolve who that
is until reconciled.

**Match on a normalized key, NOT strict lower() equality.** The legacy handles
predate Discord's 2023 username migration, so they drift from the current handle
by punctuation only. NORM = lowercase → strip `<3`-style emoticons (`<+3+`) →
strip all non-alphanumerics. Examples this folds together:
`ghosted_stoner` ↔ `ghosted_stoner.`, `Vinnybot<3` ↔ `vinnybot`,
`_sliss`/`Sliss_` ↔ `sliss`, `moon.gothie` ↔ `moongothie`, `ItzKrypto` ↔
`itz_krypto`. Strict equality (the original implementation) missed every one.
Require normalized key length ≥ 3 to avoid trivial collisions.

**Match `discordUser.username` only — never `global_name`.** global_name is
user-editable and non-unique; matching it lets anyone set a colliding display
name and steal an orphaned character. (The older memory note claiming we also
match global_name was wrong/aspirational — do not reintroduce it.)

**Two reconciliation surfaces:**
1. *Login hook* (`auth.ts` OAuth callback): after upserting the `users` row,
   UPDATE characters SET `(owner_id, claimed) = (id, true)` WHERE
   `owner_id IS NULL` AND NORM(legacy) = NORM(logging-in username). Wrap in
   try/catch + log warn; must never block login.
2. *Batch* (`scripts/src/backfill-legacy-claims.ts`): for owners who already
   logged in OR whose CURRENT username no longer resembles the legacy handle.
   - **Phase A** users-table match: NORM(legacy) = NORM(users.username).
   - **Phase B** sibling propagation (strongest): an unclaimed char whose
     NORM(legacy) equals that of an ALREADY-OWNED char inherits its owner. A
     prior login/admin already vouched for the handle→owner link, so it covers
     owners whose current username drifted entirely (e.g. owner
     `Sliss_ [Takashi]` → NORM `slisstakashi` ≠ `sliss`, but siblings carry the
     `sliss` handle). Set `claimed=true` so the UNCLAIMED badge (driven purely
     by `!claimed`, even when owner_id is set) clears.

**Safety (all paths):** only accept a normalized key mapping to exactly ONE
owner/user (`HAVING COUNT(DISTINCT ...) = 1`); never clobber a non-null
owner_id (`isNull` guard / `COALESCE(owner_id, …)`). Chars with neither a
matching portal user nor a claimed sibling stay unclaimed by design — they
resolve on owner login or manual admin claim. See memory:
nullable-owner-guards, importer-upsert-idempotency.
