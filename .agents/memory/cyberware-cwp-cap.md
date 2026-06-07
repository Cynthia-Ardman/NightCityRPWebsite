---
name: Cyberware CWP cap & duplicate-import dedup
description: Hard 15-CWP cap for non-NPCs, and how over-cap characters are caused by double-import duplicates.
---

Rule of the setting: **no non-NPC character may exceed 15 CWP.** Any non-NPC over 15 is a data bug, not a legitimate loadout. NPCs are exempt (and are already excluded from the dashboard "highest band" calc via `kind === "pc"`).

**Why over-cap happens:** some characters were imported twice — a legacy copy (low inventory_items.id) PLUS a v1 copy (high id) of the SAME chrome — so identical pieces get counted twice toward CWP. The band/CWP is derived live from `inventory_items` (category='cyberware', `parseCwp(notes)` × quantity); duplicate rows inflate it.

**How to apply / dedup safely:**
- Within ONE character, group cyberware rows by `normalized(name) + per-unit CWP`. A group with >1 row is a duplicate set: keep the NEWEST (highest id = v1 import), delete the older legacy copies. Only touch point-bearing rows (cwp>0).
- **Do NOT add slot to the dedup key.** The duplicates are legacy-row (often NO `slot:` note) vs v1-row (with slot), so keying on slot splits the very pair you need to collapse and the dedup silently does nothing. name+per-unit-CWP is the correct grain for this import artifact; always run REPORT mode first and eyeball the flagged rows.
- Reusable script: `scripts/src/dedupe-cyberware.ts` — REPORT-ONLY by default, `APPLY=1` to delete. **`TARGET=dev|live` selects the DB** (`DATABASE_URL` vs `LIVE_PROD_DATABASE_URL`); asserts the portal serial schema (not the legacy uuid DB), deletes in one transaction, verifies deleted-row count == expected. It now dedups ALL characters with duplicates (not just >15), so it is not gated on the 15-cap.
- Run on dev THEN live (same script, `TARGET` switch). Genuine hits typically shave 2-5 CWP off a character; always confirm via report before APPLY.
