---
name: Sheet approval materializes the character
description: Why approving a character_sheet must create/link a characters row, and the trust boundary on sheet.characterId
---

Approving a `character_sheet` (POST /api/sheets/:id/decision, decision="approved")
must MATERIALIZE the backing `characters` row — create it from `sheet.data` (+ a
`character_status` row) and link it back via `characterSheets.characterId`. The
sheet flow never creates a character at draft/submit time, so if approval only
flips `status` the character vanishes: it's no longer `pending` (gone from
"Awaiting Approval") and no `characters` row exists (gone from the owner's list).

**Why:** the original decision handler only set status + wrote audit. Approved
characters appeared nowhere; the audit log showed the approval but the user had
no character.

**How to apply:**
- On approval, run inside a `db.transaction` with `.for("update")` on the sheet
  row so insert + relink are atomic (no duplicate/orphan characters under
  concurrent approvals).
- `characterSheets.characterId` is USER-SUPPLIED (accepted in POST /sheets and
  PATCH /sheets). Never blind-update `characters` by that id. Only take the
  "refresh existing" path when the linked row exists AND `ownerId ===
  sheet.ownerId`; otherwise fall through and INSERT a fresh, correctly-owned
  character. This also self-heals the stale-link case (linked row deleted).
- Map `data.sheetType` ("PC"/"NPC", uppercase) → `characters.kind` ("pc"/"npc").
