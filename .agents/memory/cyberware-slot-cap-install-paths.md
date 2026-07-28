---
name: Cyberware installed-uniqueness guards on install paths
description: Every install write path must enforce one-installed-copy-per-item (any slot), no installed qty>1, and one-per-capped-slot — not just the CWP capacity cap.
---

The installed-cyberware rules and the 15-CWP capacity cap are SEPARATE guards. Owner-mandated rules (effective 2026-07-28):
1. At most ONE installed copy of any cyberware item per character (matched by normalized name), in ANY slot — capped or uncapped. A spare copy may sit UNINSTALLED in inventory.
2. No installed row may carry quantity > 1 ("NeoFiber x2 installed" = two installed copies).
3. At most one installed item per CAPPED slot (different items in Miscellaneous/Custom/unknown slots may still coexist).

**Why:** CWP cap alone let a quantity-2 install row through (prod char 665); batch sheet-approval seeding let two different items land in one capped slot (prod char 228); Misc-slot stacking allowed duplicate installed copies until the owner forbade it outright.

**Rule:** any new per-item install path must call `installSlotClashError()` (lib/cyberwareSlots.ts) twice — a pre-check at creation and a race-safe re-check inside the completion tx under the buyer's `FOR UPDATE` row lock (the lock must cover BOTH install modes). Paths that seed a SET of rows at once (sheet-approval materialize, admin character create) must call `batchSlotClashError()` on the set — the per-item guard never sees siblings in the same batch. The custom-request materialize takes a `FOR UPDATE` lock on the character row before its check so concurrent approvals serialize.

**Semantics:** only INSTALLED chrome (rows with a "CWP n" note tag) counts — uninstalled stash pieces never block; `installSlotClashError` always treats the INCOMING item as about-to-be-installed (some callers pass notes:null), so callers adding an uninstalled spare must skip the guard themselves (see manual inventory POST in characters.ts); NPCs exempt everywhere; install_owned excludes the target row via `excludeItemId`. Staff PATCH inventory is a deliberate unguarded escape hatch for corrections.

**How to apply:** grep for `installSlotClashError` before adding any path that inserts or flips a row into `category='cyberware'` with a CWP tag. Unit tests: lib/cyberwareSlots.test.ts.

Note: legacy pre-guard violations may persist in prod data (scan: group installed rows by normalized name/slot per character) — guards block new ones, they don't heal old ones.
