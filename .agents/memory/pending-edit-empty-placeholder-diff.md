---
name: Pending-edit empty-placeholder diff
description: Why character-edit review diffs must be empty-/order-insensitive, not raw JSON.stringify
---

Re-saving a character sheet through the edit form rewrites `sheetData` by adding
empty top-level placeholder keys (`hooks`, `skills`, `appearance`, `psychProfile`,
`physicalDescription` = `""`) and reordering keys, even when no real content
changed (the real content lives under `sections` and stays byte-identical).

**Symptom:** a no-op edit shows inconsistent review UI — the unified "CHANGES"
view renders blank/"(no change)" rows while "SIDE-BY-SIDE" looks different
(it dumps raw JSON, so the extra empty keys + reordering jump out). The detail
page `before` is `row.beforeSnapshot` (submit-time), not the live character.

**Rule:** change-detection for pending edits must collapse null/undefined/""/
whitespace-only/empty-array/empty-object to "absent", drop empty object keys, and
sort keys before comparing — never raw `JSON.stringify(a) !== JSON.stringify(b)`.

**Why:** raw stringify flags `undefined` vs `""` and key-order as changes, then
the leaf renderer prints them as "(no change)", desyncing the count/header from
what actually renders.

**How to apply:** use `canonicalForDiff`/`valuesDiffer` in
`ncrp-portal/src/lib/textDiff.ts`. They gate the changed-key filter in
`DiffValue.tsx` (ObjectDiff) and the field-list filters in `PendingEditDetail.tsx`
and `PendingEditDiffInline.tsx`. Preserve meaningful falsy primitives (`0`,
`false`) — only emptiness collapses. Any new pending-edit diff surface must reuse
these helpers, not reinvent equality.
