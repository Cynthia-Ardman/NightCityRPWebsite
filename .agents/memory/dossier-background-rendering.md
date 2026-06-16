---
name: Dossier background rendering
description: Why the profile background card can vanish, and the dedup rule that keeps it visible.
---

A character's bio lives in TWO independent places that can both be populated:
- the top-level `characters.background` COLUMN (what EditCharacterDialog's BACKGROUND tab writes), and
- a free-form `sheetData.sections` entry literally titled "Background" (legacy imports).

`SheetSections` renders the section entries but NEVER renders the column value.
So the column background must be surfaced by `ProfileDossier` as its own discrete card.

**Rule:** render the discrete background card whenever the (legacy-token-stripped, trimmed)
column background is non-empty, and suppress it ONLY when a "Background" section shows the
EXACT same normalized text. If they differ (edited column bio next to a stale legacy section),
render BOTH — never hide newer column content.

**Why:** the old gate `showDiscreteBackground = !hasSections && !!cleanBg` dropped the column
background entirely for any character that had ANY section entry (e.g. discrete psych/skills
plus a sections map). The dead `entries.length===0` branch in SheetSections never compensates
because SheetSections is only mounted when entries exist.

**How to apply:** any future change to ProfileDossier's discrete-field gating must keep the
column-background path independent of `hasSections`; dedup against section text by value, not by
mere presence of a "Background" heading.
