---
name: Prod-import legacy tags
description: Why characters.background can contain `[legacy:<uuid>]` strings
---

`scripts/src/import-prod.ts` stamps `[legacy:<character_uuid>]` into the
`background` column of every character it creates from the old production
DB. That tag is the mapping anchor used to find the row again on rerun
without depending on the (mutable) character name. It is NOT story
content and must never appear in the UI.

**Why:** Names can change and collide; the legacy uuid is the stable join
key into the prod-importer's view of the world. Stripping the tag at
display/projection time is cheaper than backfilling all rows.

**How to apply:** Any code that surfaces `characters.background` (public
directory detail projection, owner CharacterDetail dossier renderer)
must run a `.replace(/\[legacy:[^\]]+\]/g, "").trim()` scrub and treat
the empty result as "no background recorded."

## Cyberware-import HTML-comment blocks
A separate (cyberware) importer wrote literal
`<!--cyberware-import-start--> … <!--cyberware-import-end-->` blocks into
`characters.background`. The portal renders background as PLAIN TEXT, so
those HTML comments showed up verbatim under the BACKSTORY heading.
Scrubbed out of the data once (Postgres: `regexp_replace(background,
'<!--cyberware-import-start-->.*?<!--cyberware-import-end-->','','g')`
then `NULLIF(btrim(...), '')`). **Why:** the real chrome data belongs in
the cyberware/inventory tables, not the prose field. If that importer is
ever re-run it will reintroduce them — prefer also scrubbing this pattern
at the render layer (same place as the `[legacy:]` scrub) if it recurs.
