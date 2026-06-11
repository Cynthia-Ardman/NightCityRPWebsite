---
name: New-character submission kill switch
description: How the admin flag that blocks new PC submissions is scoped (what it does and does NOT gate)
---

# New-character submission kill switch

Admin toggle (System Admin → Jobs tab) backed by bot_config flag
`character_submissions_disabled` (default OFF, fail-open reader in
`lib/characterSubmissions.ts`).

**Scope — what it gates:** only the *submit-for-review* of NON-NPC character
sheets: `POST /sheets` (when not a draft) and `POST /sheets/:id/submit`. Returns
403 when ON.

**Deliberately NOT gated:**
- NPC sheets — exempt by `sheetType === "NPC"` (a fixer/admin-only type), so
  "new NPCs are fine".
- Drafts — `POST /sheets` with `status:"draft"` still works (a draft never
  enters the queue).
- Edits — existing-character edits go through a *different* path
  (`PATCH /sheets/:id`, pending-edits, `PATCH /characters`), untouched.

**Why:** user wanted to stop player PC intake without blocking edits or NPC
creation. NPC exemption is keyed on sheet TYPE (not actor role) to match the
request literally.

**How to apply:** any future "new character" intake path must also consult
`areCharacterSubmissionsDisabled()` or it becomes a bypass.
