---
name: Import-time name dedupe for legacy chars
description: When importing fresh Discord-thread character rows into a DB that already has legacy bare-row characters, exact lower(name) match is not enough — players' canonical names diverge from Discord thread titles ("Corpse" vs "The Corpse Hound"). Need fuzzy match or a follow-up merge pass.
---

The character importer keys dedupe on `(ownerId, lower(name))`. That misses cases where the legacy row was created with a short nickname and the Discord thread title is the full name (e.g. legacy "Diesel" vs thread "Malcolm 'Diesel' Reyes"). Result: a duplicate row per character whose FKs (wallet, inventory, housing) all hang off the legacy id and become orphaned from the new sheet data.

**Why:** Players name their Discord threads with full character names but admins/early adopters often created the original DB rows with just the nickname. There is no canonical name anywhere — both forms are legitimate.

**How to apply:**
- Prefer the importer match on tokenized substring (every token of the legacy name appears as a substring of some token of the fresh name, or vice versa) when ownerId matches. Falls back to exact match only when token match is ambiguous (>1 candidate).
- For one-off post-import cleanup, see the pattern in `scripts/src/merge-duplicate-characters.ts`: load all rows, group by ownerId, fuzzy-match legacy↔fresh, MERGE in a transaction that **deletes fresh FIRST then updates legacy** (the unique index on `imported_from_thread_id` fires otherwise).
- Ambiguous matches (one legacy maps to multiple fresh, common when same owner has multiple sheets with the legacy nickname as a substring of all of them) must be surfaced for human resolution — do not auto-pick.
- Owners with both legacy bare-rows AND fresh thread-rows after merge are usually NOT bugs: it's a player who has multiple distinct characters, one pre-portal and one new.
