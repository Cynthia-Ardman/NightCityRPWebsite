---
name: Fixer NPCs are characters
description: NPCs live in the characters table (kind='npc'), not the legacy empty fixer_npcs table
---

NPCs are first-class `characters` rows with `kind='npc'`, created through the
character-sheet flow (`/sheets/new?type=NPC`) with staff review. They are viewed
at `/characters/:id`.

The legacy `fixer_npcs` table is **empty/dead**. The fixer-hub list endpoints
(`/fixer/npcs`, `/fixer/npcs/mine`) project NPC characters into the hub's
expected shape (district/contact are synthesized as null). The legacy
single-record endpoints (`GET/PATCH/POST /fixer/npcs/:id`) still target
`fixer_npcs` and are orphaned dead code — they speak a different id space than
the list endpoints, so never link list ids to them.

**Why:** The fixer-hub NPC section read blank because it queried the empty
legacy table while real NPCs sit in `characters`.

**How to apply:** When touching anything "fixer NPC", operate on
`characters` + `kind='npc'`, link to `/characters/:id`, and ignore the legacy
`fixer_npcs` endpoints unless deliberately removing them.
