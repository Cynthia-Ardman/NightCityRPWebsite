---
name: Player character tags
description: Player/staff tag editing on characters — registry lock, lenient sheet-close seeding, applied/manual split, PATCH race guard.
---
- PATCH /characters/:id/tags is the owner+staff full-set editor; vocabulary locked to character_tag_options, but `extraAllowed` = the character's CURRENT tags so legacy/Discord-imported tags stay removable/keepable without registry membership.
- resolveRegistryTags returns `{ tags, unknown }` — strict callers (player/staff writes, sheet submission) reject when unknown.length>0; the sheet-close materialize path is LENIENT (keeps known tags, drops ones removed from the registry since submit). Never make close strict or approved sheets brick on a stale label.
- **Why:** an early strict version returned ONLY `unknown` when any tag was stale, which silently dropped ALL tags at close.
- The PATCH re-reads+locks the character row FOR UPDATE inside the tx and re-splits against fresh appliedTags — the importer rewrites appliedTags concurrently; splitDesiredTags keeps Discord-origin tags in appliedTags, everything else in manualTags.
- **How to apply:** any new tag write surface must go through resolveRegistryTags + splitDesiredTags (lib/characterTags) and lock the row in-tx.
