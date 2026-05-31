---
name: Sheet approval seeds inventory
description: Approving a character sheet must create inventory_items from the sheet's chrome/gear, or the character has an empty inventory and no cyberware band.
---
Approving a PC sheet (`POST /sheets/:id/decision` → `materializeCharacterFromSheet` in sheets.ts) used to only insert the `characters` row + `characterStatus`. It never created `inventory_items` for `data.cyberware` / `data.gear`, so an approved character showed an empty inventory AND no derived cyberware band.

**Rule:** seed inventory from the sheet payload, but ONLY on the fresh-insert branch — never the linked/refresh path (re-approval of a resubmitted edit would dup/clobber player-changed inventory).

**Notes format matters:**
- Cyberware → category `"cyberware"`, notes must start with `CWP <points>` (parsed by lib/cyberware.ts `parseCwp`, which drives `sumCwpByCharacter`/band derivation). Untagged chrome counts as 0 CWP.
- Keep `slot: <x>` LAST in notes: CharacterDetail's slot regex `/slot\s*[:=]\s*([^,;\n]+)/i` captures up to the next comma/semicolon/newline, and the separator used is ` · `, so anything after slot gets swallowed.
- Gear → category `"gear"`.
- Write inventory_events with the SAME `tx` (not recordInventoryEvent, which uses `db`).

**Why:** only one runtime path materializes from character_sheets; admin import flows build characters from import payloads, not sheets. Legacy characters approved before the fix stay unseeded (no self-heal) — would need a targeted backfill.
