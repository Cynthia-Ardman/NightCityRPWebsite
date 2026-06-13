---
name: Discord thread pop-out drawer
description: The cs-approver Discord thread mirror is a right-side Sheet drawer, not an inline panel; only mount the polling panel when open.
---

The read-only cs-approver Discord thread mirror is surfaced via `DiscordThreadDrawer`
(a header button → Radix `Sheet` slide-over from the right), NOT an inline Card at the
bottom of the page. It wraps the existing read-only `DiscordThreadPanel`.

**Rule:** the drawer mounts `DiscordThreadPanel` only while `open` is true
(`{open && <DiscordThreadPanel .../>}`).

**Why:** `DiscordThreadPanel` runs a 15s polling query. On list surfaces like the misc
Requests queue (`ReviewQueueCard`), one drawer per card would otherwise fire one poll per
visible card on mount. Gating the mount on `open` means closed drawers poll nothing.

**How to apply:** mount points stay staff-gated exactly like the old inline panel
(`isReviewer` on PendingEditDetail, `isStaff` on SheetDetail, `showDiscordThread` —
fed `isReviewer` from PendingRequests — on ReviewQueueCard). The Radix Sheet needs a
`SheetTitle` (kept `sr-only`) or it warns/breaks a11y. Server endpoint is reviewer-gated
regardless, so this is defense-in-depth, not the only gate.
