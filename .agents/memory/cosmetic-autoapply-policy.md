---
name: Character-edit cosmetic auto-apply policy
description: When a character PATCH skips fixer review vs goes to the queue (pending-edits.ts isCosmeticOnlyDiff).
---

# Character-edit auto-apply is CONTENT-based, not field-based

A character edit (PATCH /characters/:id) skips review and applies instantly ONLY when:
1. it changes nothing but portrait images (`portraitUrl`/`portraitUrls`), and/or
2. it touches prose (`background` + sheetData prose keys) but the **word multiset is unchanged** — pure reformatting/re-sectioning/moving text around.

Prose = `background` + sheetData `{preamble, sections, physicalDescription, appearance, psychProfile, hooks, skills}`. For `sections` (a `{title: body}` map) only the **body values** count, never the titles — so creating/renaming sections is reorganization, not content. The signature is lowercased `\p{L}\p{N}` tokens, SORTED (order-independent). Any change to a non-prose sheetData sub-key (`gear`/`guns`/`identity`/legacy stat lines) or to any other top-level field (`name`, `archetype`, `statsImageUrls`, `lifeStatus`, `traumaTeamTier`, `xanaduGold`) forces review.

**Why word-level / why sections=prose is safe:** The user explicitly chose the most lenient "same set of words = no review" rule. It's not a stat-laundering vector because **mechanical stats are NOT in sheetData.sections** — the canonical stat block is `statsImageUrls` (uploaded screenshots, always a review field) and cyberware/equipment live in the `inventory_items` table (a separate, separately-gated write path, never in the edit diff). `sheetData.sections` is free-form story prose (Background/Personality/Relationships…), edited via the EditCharacterDialog "STORY" tab.

**Accepted downside:** rearranging words within a sentence (meaning change, same words) still auto-applies. Staff can audit via the activity log. A legacy "Cyberware" text section could in theory be reworded without review, but real cyberware mechanics are in inventory_items, so it carries no mechanical weight.

**How to apply:** before loosening/tightening this, remember stats=images and cyberware=inventory_items; don't add fields to the cosmetic path without checking they carry no mechanics. applyDiff WHOLE-REPLACES background/sheetData (client sends the merged blob), so `after = {...current, ...diff}` is the correct post-edit state.
