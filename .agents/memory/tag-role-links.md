---
name: Character tag → Discord role links
description: How tag options map to Discord roles and the approval gate on player self-adds.
---

Registry tag options carry `discordRoleId` (nullable) + `requiresApproval`.

- Role sync lives in api-server `lib/tagRoles.ts` (`syncTagRolesForCharacter`):
  fire-and-forget after tag diffs; role REMOVAL is skipped if a sibling
  character of the same owner still carries the tag. Wire it at every tag
  write path (tags PATCH + character_tag request materialize) or roles drift.
- Player tags PATCH diverts NEW gated tags into internal `character_tag`
  customRequests (Misc queue, fixer-voted); staff (fixer/admin) bypass the
  gate. Dedup = partial unique index `custom_requests_character_tag_live_idx`
  on (character_id, lower(details->>'tag')) over pending/changes_requested +
  untargeted onConflictDoNothing.
- **Why:** approval gate is per-tag (not per-request-type), so any future tag
  write path (importers, sheet close) must decide explicitly whether it is a
  "staff" path (bypass) or a player path (divert).
