---
name: Sheet chrome snapshot vs live inventory
description: The Cyberware tab's "SHEET: CHROME / IMPLANTS" card is frozen sheet prose and legitimately diverges from the live INSTALLED CHROME inventory.
---

The Cyberware tab shows two chrome lists that are NOT the same source:

- **SHEET: <heading>** renders the character's `sheetData.sections` prose exactly as approved on the original character sheet (including its own "TOTAL: n CWP" line). It is a frozen snapshot and is never updated when chrome changes.
- **INSTALLED CHROME** (and the staff editor) render `inventory_items` category=cyberware — the live, authoritative source that billing and the risk band use.

**Why:** The bulk cyberware import sourced from the spreadsheet, not the sheet prose, so items and CWP totals legitimately differ (e.g. char 132: sheet says 3 items / 6 CWP, inventory has 5 items / 10 CWP). Users read the divergence as "chrome exists but isn't installed" — a support report, not a bug.

**How to apply:** When someone reports missing/uninstalled chrome, first compare `sheetData.sections` prose vs inventory rows before hunting for a derivation bug. A caption on the sheet card (added 2026-07-28) explains the split; don't "fix" the sheet prose to match inventory.
