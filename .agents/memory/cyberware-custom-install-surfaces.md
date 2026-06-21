---
name: Cyberware custom-install surfaces
description: Which cyberware editors allow a free-text install under a real catalog slot, and the shared pattern they must mirror.
---

Players need to enter a custom implant name (e.g. "Reflex Tuner") under a real
catalog slot (e.g. "Neural") with a hand-entered CWP — NOT only the catalog
dropdown, and NOT forced into a "Custom slot" that loses the slot identity.

**The pattern** (canonical in `components/CyberwareEditor.tsx`): a `CUSTOM_NAME`
sentinel option in the install/name dropdown; choosing it flips a per-row
`customName` flag that swaps the field to a free-text Input and makes CWP
editable while keeping the catalog slot. A derived `customName` (name set but
not among the slot's catalog installs) round-trips loaded rows so non-catalog
names render as free text on reload.

**Why:** for a catalog slot the install was a locked `<select>` and CWP a
read-only div, so the only escape was a Custom slot — users perceived this as
the field "resetting" their custom entry.

**How to apply:** any cyberware editor surface (sheet create/edit in
`pages/sheets/NewSheet.tsx`, `components/CyberwareEditor.tsx`,
`components/EditCharacterDialog.tsx`, and the `CharacterDetail` request form)
must offer this custom-install path or it's a usability gap. Keep the PC 6-CWP
cap (`pointsSpent`/`overCap`) intact — custom installs still count.
