---
name: Sheet draft optimistic concurrency
description: character_sheets stale-draft protection via updatedAt revision token; ms-precision comparison trap
---
Draft/pending character-sheet PATCH supports optional `baseUpdatedAt` (revision token = last-seen `updatedAt`). Mismatch → 409 `{error:"stale_draft"}`; omitted token keeps legacy last-write-wins for old clients.

**Why:** an old sleeping browser tab's debounced autosave silently overwrote a newer draft saved from another device.

**How to apply:**
- Server re-asserts the revision INSIDE the UPDATE's WHERE using `date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $token::timestamptz)`. Plain `eq(updatedAt, new Date(iso))` FAILS spuriously: the column's `defaultNow()` stores microseconds that a client ISO string (ms precision) can never round-trip. Every write sets `updatedAt: new Date()` (ms), so only the initial default row hits this.
- On 0-row update with a token supplied, re-read to distinguish stale_draft (409) vs status-locked (409 locked).
- Client (NewSheet.tsx): revision kept in a ref, advanced from every save/create response; on stale_draft flip a conflict ref synchronously (autosave may already be queued), stop autosave, disable save/submit, show reload banner. Submit must NOT fall through to the create path when a save on an existing draft fails — that duplicated the sheet with stale data.
