---
name: Cyberware installed-ness derivation
description: What "installed" means for a cyberware inventory row and why the equipped flag is unreliable
---

**Rule:** Installed-ness of a cyberware `inventory_items` row is derived from the CWP install tag in `notes` (`parseCwp(notes) != null`, portal `hasCwpTag`), never from the `equipped` boolean. `equipped` is cosmetic and historically drifted (offer-install inserts didn't set it before July 2026; prod rows still carry `equipped=false`).

**Why:** The meds cron, risk band, CWP cap, and install-owned offer eligibility all key on the notes tag + `category='cyberware'`. Tag presence matters, not value — `CWP 0` is a legitimate install, so `cwpFromNotes(...) > 0` is the wrong predicate.

**How to apply:**
- Any UI/logic asking "is this chrome installed?" → tag presence (fallback `|| equipped` for tagless legacy rows is OK for display only).
- P2P inventory transfer BLOCKS currently-installed cyberware (400, "have a ripperdoc remove it first") — otherwise the tag travels and the recipient gets phantom installed chrome + meds billing. `cyberware (removed)` transfers fine.
- Prod DB is read-only from dev; display fixes for drifted flags must be derivation-side, not data backfills.
