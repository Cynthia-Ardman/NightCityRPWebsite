---
name: Sticky sidebars vs overflow-x on <main>
description: position:sticky inside the portal's <main> breaks if main uses overflow-x-hidden; use overflow-x-clip.
---

# Sticky inside AppLayout main

The portal's `<main>` in AppLayout clips horizontal overflow. `overflow-x-hidden`
turns the element into a scroll container (computed overflow-y becomes auto), so
any `position: sticky` descendant sticks to main's never-scrolling scrollport and
never pins while the window scrolls.

**Why:** Hit when adding the Book of Laws sticky table of contents — it worked at
top but vanished on scroll until `overflow-x-hidden` became `overflow-x-clip`
(clip does NOT create a scroll container).

**How to apply:** Any new sticky element rendered inside `<main>` relies on it
staying `overflow-x-clip`. Don't reintroduce `overflow-x-hidden`/`auto` on main
or intermediate wrappers around sticky content.
