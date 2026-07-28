---
name: Cyberware slot cap on install paths
description: Every install write path must enforce the one-per-capped-slot rule, not just the CWP capacity cap.
---

The 1-per-capped-slot rule and the 15-CWP capacity cap are SEPARATE guards. The ripperdoc offer paths (stock `install` and `install_owned`) originally checked only CWP capacity, letting "NeoFiber x2" land as one quantity-2 row in a capped slot (prod character 665, 2026-07-27).

**Rule:** any new install write path must call `installSlotClashError()` (lib/cyberwareSlots.ts) twice — a pre-check at creation and a race-safe re-check inside the completion tx under the buyer's `FOR UPDATE` row lock (the lock must cover BOTH install modes, not just one branch).

**Semantics:** capped slots reject qty>1 outright; only INSTALLED chrome (rows with a "CWP n" note tag) occupies a slot — loose uninstalled pieces don't block; NPCs exempt; Miscellaneous/Custom/unknown slots stack freely; install_owned excludes the target row itself via `excludeItemId`.

**How to apply:** grep for `installSlotClashError` before adding any path that inserts or flips a row into `category='cyberware'` with a CWP tag.

**Batch seeding gap (fixed 2026-07-28):** paths that seed a whole SET of cyberware rows at once (sheet-approval materialize, admin manual character create) never trigger the per-item guard for siblings within the batch — prod character 228 got NeoFiber + Dense Marrow (both Skeleton & Torso Musculature) from one sheet approval that predated any guard. Batch paths must call `batchSlotClashError()` (same file) on the seeded set; the custom-cyberware request materialize additionally takes a `FOR UPDATE` lock on the character row before its `installSlotClashError` check so concurrent approvals serialize. NPCs exempt everywhere. Note: legacy pre-guard violations still exist in prod data (scan: group installed rows by normalized slot per character) — the guards block new ones, they don't heal old ones.
