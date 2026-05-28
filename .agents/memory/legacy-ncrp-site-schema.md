---
name: Legacy NCRP site schema
description: nightcityroleplay.com (the live legacy site) runs a totally different DB from our portal — URL ids do NOT map to portal character ids.
---

The live site at `nightcityroleplay.com/directory/characters/<n>` runs against `PROD_DATABASE_URL`, which has a uuid-keyed legacy roster with completely different columns:

  - `character_id text` (uuid string — not an int)
  - `discord_user_id`, `character_name`, `normalized_character_name`, `status`, timestamps

There is NO integer `id` column. The `/characters/<n>` URL path number is some derived index (probably a row index in a public listing), not a primary key. It does NOT correspond to our portal's `characters.id`.

**Why:** Easy to assume the live site and our dev portal share a DB because both are called "NCRP". They don't. Our portal (DATABASE_URL) is a new system with its own schema; PROD is the historical Discord roster from the bot.

**How to apply:**
- When a user gives a URL like `/directory/characters/543`, do NOT query `WHERE id = 543` in our portal DB and report what you find — that's a coincidentally-existing different character.
- Look up by character name (and player) in our portal DB instead.
- If you need to confirm what's on the live site, query PROD_DATABASE_URL by `character_name`, not by integer id.
- There may appear to be a `URL = DB+1` offset for *some* characters — that's coincidence from import ordering, not a real mapping. Don't trust it.
