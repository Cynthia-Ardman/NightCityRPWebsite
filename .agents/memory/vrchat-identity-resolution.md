---
name: VRChat↔portal identity resolution
description: Rules for attributing imported VRChat instance visits to portal users
---

Data: `vrchat_instance_visits` (per-player join/leave rows built by the VRCX importer; leave-without-join opens at session start, open join closes at session end with leftAt NULL). Identity links live in `vrchat_links` (populated by the read-only #vrchat-username channel scanner, upsert).

Resolution policy (fixer intel endpoints):
1. `vrchat_links` first → matchKind "linked", but ONLY if exactly one distinct portal user claims that vrchatUserId. A VRChat account claimed by 2+ users is ambiguous: attribute to nobody AND do not fall through to name matching.
2. Fallback: case-insensitive display-name equality against users.username/globalName → matchKind "name", only when exactly one user matches.

**Why:** last-write-wins on duplicate links misattributes staff intel to the wrong player (architect-flagged). `vrchat_links` has no unique index on vrchat_user_id, so route logic must enforce uniqueness.

**How to apply:** any new surface that maps vrchatUserId→portal user must reuse resolvePortalUsers (fixer.ts) or replicate both uniqueness guards; surface matchKind in UI so staff can tell exact links from name guesses.
