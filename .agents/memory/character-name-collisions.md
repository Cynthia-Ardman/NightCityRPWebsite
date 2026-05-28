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
