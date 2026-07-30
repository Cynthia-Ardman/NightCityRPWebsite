---
name: Sheet form save serialization & visible save errors
description: Why the NewSheet form chains saves and surfaces server reasons; the "can't edit cyberware" report was silent failures, not a lock.
---

The rule: in the sheet editor, every save (debounced autosave OR explicit SAVE click) must run through one serialized promise chain, and any save failure must display the server's error reason.

**Why:** A "players can't change/remove cyberware on pending sheets" report (2026-07-30) turned out to be no lock at all — API and UI both allow pending-owner edits. The real causes were (1) a debounced autosave and a SAVE click racing: both read the same baseUpdatedAt revision, the second got a stale_draft 409 and permanently conflict-locked the form; (2) over-cap saves (6-CWP re-validation on pending PATCH) failing with a bare "Save failed" and the submit handler silently returning on overCap. Users read all of these as "editing is blocked".

**How to apply:** Keep `saveChainRef` serialization in NewSheet; new save entry points must go through `saveDraft`, never call the mutation directly. Show `saveError` in the status line; never add a silent `return` on a validation guard without a toast. Conflict lock has a RELOAD LATEST button. Regression tests: `e2e/pending-cyberware-edit.spec.ts` + api-server `sheets-pending-cyberware-edit.test.ts`.
