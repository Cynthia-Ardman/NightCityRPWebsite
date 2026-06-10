---
name: View-as role gating
description: Player-facing pages must gate staff UI/intel on useEffectiveMe, not useAuthMe, or the admin "View as player" preview leaks staff content.
---

The admin "View as <role>" preview works by downgrading role flags in `useEffectiveMe()` (contexts/ViewAsContext.tsx) — it does NOT touch `useAuthMe()` (the real identity). Any component that gates staff-only controls or intel on `useAuthMe()` will keep showing staff content while previewing as a player.

**Rule:** on player-reachable pages, derive isStaff/isFixer/isAdmin/etc. from `useEffectiveMe()`. Reserve `useAuthMe()` for things that must reflect the REAL account (e.g. whether to render the View-as switcher itself). Identity fields (name/avatar/id) are preserved by the downgrade, so switching to useEffectiveMe is safe for display too.

**Why:** lore/guidebook detail pages have fixer-only intel sections; directory/calendar/missions/home show staff controls. All originally used useAuthMe and leaked under view-as. Route-guarded staff-only tools (AdminDashboard, PendingRequests, sheets review, catalog management) are fine on useAuthMe since players never reach them.

**How to apply:** when adding a new content page or a staff-only block on a shared page, gate it via useEffectiveMe.
