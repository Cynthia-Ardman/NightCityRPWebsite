---
name: Global search authz & hrefs
description: Rules for /search command-palette results — href openability and View-as scrubbing
---
Rules for the site-wide `/search` endpoint + Ctrl+K palette:

- **Hrefs must be openable by the caller.** A result's href must land on a page the requester's PORTAL route guards allow, not just an API-visible resource. There is no player-facing page for other players' characters, so players search only their OWN characters (`/characters/:id`); staff get the full roster with archive hrefs (`/directory/characters/:id`).
- **View-as safety is a server+client contract:** the server flags any row reachable only via a staff page with `staffOnly: true`; GlobalSearch scrubs flagged rows using `useEffectiveMe` (missions/characters gate on effective isAdmin||isFixer, NCPD on those + isNcpd/isNcpdCommissioner). Adding a new staff-scoped group means BOTH flagging server rows and wiring the client scrub, or View-as-player leaks staff results.
- Merged groups (venues = stores + clinics, each independently capped) must be re-capped after merge to GROUP_LIMIT.

**Why:** two code-review rejections — first for character hrefs pointing at a StaffArchiveGuard-gated page players can't open, then for View-as-player still receiving staff-scoped character rows.
**How to apply:** whenever adding a group or changing scoping in search.ts / GlobalSearch.tsx.
