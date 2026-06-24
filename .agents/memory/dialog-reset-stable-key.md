---
name: EditCharacterDialog form-reset key
description: Why the edit-dialog form-reset effect must key on character.id, not the character object
---

The form-reset `useEffect` in `EditCharacterDialog` must depend on `[open, character.id]`, NOT `[open, character]`.

**Why:** `PendingEditDetail` (and any amend/resubmit caller) seeds the dialog with `mergedCharacter = { ...character, ...diff }`, rebuilt as a BRAND-NEW object on every render. Keying the reset on the object reference re-fires it on any parent re-render while the dialog is open — e.g. a background refetch kicked off by an image upload — snapping `statsImageUrls`/`portraitUrls`/text back to the proposed values mid-edit. That was the "kept putting back to the original specs / outright deleting it" image-amend bug.

**How to apply:** Reset form state only on open and on genuine character switch (stable id). Same-id server refreshes deliberately do NOT rehydrate an open editor (close/reopen to pull latest) — this is the safer editor default and prevents clobbering. The sibling cyberware hydration effect uses a dirty-guard for the same reason; keep both clobber-safe. Add `// eslint-disable-next-line react-hooks/exhaustive-deps` since the body reads `character.*` but depends only on `character.id`.
