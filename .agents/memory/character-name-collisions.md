---
name: Character name collisions
description: Why same-name characters are not always duplicates — verify before merging
---

NCRP characters can share a name/street-alias and still be **distinct
characters owned by different players**. Real example: two rows named
"Bones" — one owned by `leonardofoxtron` (archetype "BBB member"), one
unclaimed (legacy `Lova`, archetype "Former Arasaka black-ops bartender")
with a totally different backstory. They are different people.

**Why:** street names/handles repeat in the setting; an exact or fuzzy
name match is a *candidate* signal, not proof of duplication. The real
duplicates from the re-import were same-name **and** same `owner_id`
(Takashi/Mitsuyo/Raelyna) — those were safe to merge.

**How to apply:** Before merging/deleting a "duplicate", confirm
`owner_id` matches AND the backstories describe the same person. If
owners differ or backstories diverge, treat them as separate and ask the
user. The re-import dupes were also recognizable as: same owner, the
loser row's only `background` content was a `[legacy:…]` placeholder or a
cyberware-import block (i.e. no real prose to lose on delete).

Merge is safe to do as a plain `DELETE` of the loser only after checking
attached data: no NCRP-native table referenced any of these rows
(wallet_transactions, inventory_items, mission_log, housing, shop_opens,
pending_character_edits, character_status/updates, users.active_character_id,
etc. — all FK refs are `onDelete: cascade`, plus non-FK int columns like
`*_character_id`). If a survivor must absorb the loser's id references,
re-point those columns first.

**Dev vs live differ — never assume child data matches.** On the dev DB the
duplicate/stub rows (Raelyna #540, Wallie #543) had NO attached rows, so they
were clean deletes. On LIVE prod the SAME stub rows owned the character's real
`inventory_items` (the cyberware import created both the `<!--cyberware-import-*-->`
background block AND structured inventory_items on whichever row it ran). A
blind `DELETE` there would cascade-delete the cyberware. Fix: re-point
`inventory_items.character_id` (and align `owner_id`) to the survivor BEFORE
deleting. Generalize: a merge script must re-check attached data on the actual
target DB and migrate child rows it can safely move (tables with no UNIQUE/PK
on character_id, e.g. inventory_items), and REFUSE + report anything else
rather than guess. See `scripts/src/cleanup-character-archive.ts` (id-agnostic,
content-based strip, dry-run default, empty-stub + no-unhandled-data guards).
