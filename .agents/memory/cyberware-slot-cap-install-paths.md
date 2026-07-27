---
name: Cyberware slot cap on install paths
description: Every install write path must enforce the one-per-capped-slot rule, not just the CWP capacity cap.
---

The 1-per-capped-slot rule and the 15-CWP capacity cap are SEPARATE guards. The ripperdoc offer paths (stock `install` and `install_owned`) originally checked only CWP capacity, letting "NeoFiber x2" land as one quantity-2 row in a capped slot (prod character 665, 2026-07-27).

**Rule:** any new install write path must call `installSlotClashError()` (lib/cyberwareSlots.ts) twice — a pre-check at creation and a race-safe re-check inside the completion tx under the buyer's `FOR UPDATE` row lock (the lock must cover BOTH install modes, not just one branch).

**Semantics:** capped slots reject qty>1 outright; only INSTALLED chrome (rows with a "CWP n" note tag) occupies a slot — loose uninstalled pieces don't block; NPCs exempt; Miscellaneous/Custom/unknown slots stack freely; install_owned excludes the target row itself via `excludeItemId`.

**How to apply:** grep for `installSlotClashError` before adding any path that inserts or flips a row into `category='cyberware'` with a CWP tag.
