---
name: Cyberware CWP cap & duplicate-import dedup
description: Hard 15-CWP cap for non-NPCs, and how over-cap characters are caused by double-import duplicates.
---

Rule of the setting: **no non-NPC character may exceed 15 CWP.** Any non-NPC over 15 is a data bug, not a legitimate loadout. NPCs are exempt (and are already excluded from the dashboard "highest band" calc via `kind === "pc"`).

**Why over-cap happens:** some characters were imported twice — a legacy copy (low inventory_items.id, e.g. 21/22) PLUS a v1 copy (high id, e.g. 6310/6311) of the SAME chrome — so identical pieces get counted twice toward CWP. The band/CWP is derived live from `inventory_items` (category='cyberware', `parseCwp(notes)` × quantity); duplicate rows inflate it.

**How to apply / dedup safely:**
- Within ONE character, group cyberware rows by `normalized(name) + per-unit CWP`. A group with >1 row is a duplicate set: keep the NEWEST (highest id = v1 import), delete the older legacy copies. Only touch point-bearing rows (cwp>0).
- Reusable script: `scripts/src/dedupe-cyberware.ts` — REPORT-ONLY by default, `APPLY=1` to delete. Connects ONLY to `LIVE_PROD_DATABASE_URL`, asserts the portal serial schema (not the legacy uuid DB), deletes in one transaction, and ABORTS if any character would still be >15 after dedup or if the deleted-row count != expected.
- As of the last run, the ONLY over-cap non-NPC in live prod was Vinny Russo (#5): 17→12 after deleting dup rows 21 & 22. 432 cyberware-bearing chars total.
