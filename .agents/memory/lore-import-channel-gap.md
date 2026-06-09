---
name: Lore import channel-mention & protected-edit gap
description: Why manual lore fixes get clobbered and raw <#id> render literally in lore
---

The guidebook importer rewrites `<#channelId>` mentions (buildChannelLinkMap /
CHANNEL_PORTAL_LINKS in guidebookImport.ts) and guidebook_pages has an
`editedSinceImport` flag so on-site edits survive re-import (stashed as
pendingImport). **The lore pipeline has NEITHER.**

- lore_entries has no editedSinceImport/title protected-edit flag.
- The lore import/publish path (lore_import_drafts -> lore_entries) does NOT
  rewrite `<#id>` mentions, so they render as broken literal text on-site.

**Why this matters:** any hand-fix to a lore entry (e.g. rewriting a raw `<#id>`
to a Discord deep-link) is silently overwritten the next time that lore draft is
re-imported and published. Treat lore data-fixes as temporary until the pipeline
gains the same two capabilities as the guidebook importer.

**How to apply:** if you fix lore content directly in the DB, note it will not
survive re-import; prefer fixing at the importer. Mirror guidebookImport.ts when
adding `<#id>` rewriting + a protected-edit flag to lore.
