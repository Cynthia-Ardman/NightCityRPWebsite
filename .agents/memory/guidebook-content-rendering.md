---
name: Guidebook imported-content rendering
description: How imported guidebook bodies encode mentions, channel links, and local-time timestamps, and how the frontend renders them.
---

The importer (`cleanContent`) bakes Discord content into portal-flavoured
Markdown that the **shared** `ncrp-portal` Markdown renderer understands (also
used by lore etc.). The two sides share conventions and MUST change in lockstep.

## Conventions (importer emits → frontend renders)
- **User mentions** → `[@name](https://discord.com/users/<id>)` (Discord profile — there is no public per-user portal page).
- **Channel links/mentions** → portal link when the channel id is in the importer's channel→portal map, else a labelled link back to Discord. The map couples the backend to frontend routes/anchors.
- **Timestamps**: Discord `<t:secs:fmt>` → a `[t=secs:fmt]` token (NOT a baked UTC string). A remark plugin turns the token into a `<time>` mdast node and the renderer formats it in the *viewer's* local timezone.

## Gotchas / durable rules
- **Re-import after any `cleanContent` change.** Bodies are baked at import time; editing the renderer alone won't fix already-stored pages.
- **Guidebook links use stable section anchors** (`/guidebook#<sectionKey>`), NOT `/guidebook/:id` — the numeric detail-route id is unstable across envs/re-import (and the detail route is auth-gated).
- **Escape Markdown-special chars in any Discord-sourced link label** (names can contain `]`/`(` which would otherwise close the link early and inject a different destination).
- **Validate dates before `toISOString()`** in the shared `time` renderer — a finite-but-out-of-range token yields Invalid Date and would throw at render, breaking every page that uses the shared component.
- **react-markdown custom-node data**: pass plugin→component data via the node's text child (`node.children[0].value`), not custom `data-*` hProperties (hast camelCases them inconsistently).


## Former index detail (full)
importer bakes mentions/channel links + `[t=secs:fmt]` tokens rendered client-side in local tz (shared with lore); bespoke wording/page edits run as a script AFTER import (sets editedSinceImport → re-import stashes to pendingImport), never baked into cleanContent.
