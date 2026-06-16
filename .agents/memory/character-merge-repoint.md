---
name: Character merge repoint completeness
description: Which character-referencing columns the admin character-merge transaction must repoint, including non-FK plain-integer columns.
---

# Character merge must repoint non-FK character columns too

The admin character-merge transaction (`artifacts/api-server/src/routes/admin.ts`,
the `/admin/characters/.../merge` handler) moves all of the drop character's rows
onto the keep character before deleting the drop row.

**The trap:** it's easy to only repoint columns that have a real FK (which would
otherwise cascade-delete or SET NULL). Plain `integer` columns that *reference a
character by id but have no FK constraint* do NOT cascade — their rows survive the
drop's deletion but are left pointing at a now-deleted character id (a dangling
reference). `sale_offers.seller_character_id` is exactly this: a plain integer,
no `.references()`, no cascade. `sale_offers.buyer_character_id` IS an FK (cascade),
so it was repointed; the seller column was missed.

**Rule:** when adding/auditing the merge, repoint EVERY column that holds a
character id — FK or not. For non-FK columns the repoint is the only thing that
keeps them consistent.

**Why:** a missed non-FK column silently leaves orphaned references after a merge
(no error, no cascade), surfacing later as "character not found" when something
resolves that id.

**How to apply:** grep the schema for every column that references `characters.id`
(both `.references(() => characters.id)` AND bare `integer("..._character_id")`
with a comment but no FK). Repoint all of them. No unique constraint on
`sellerCharacterId`, so its repoint can't 23505; columns WITH a unique on
characterId still need the explicit collision/delete-before-update handling that
mission_applications uses.
