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

**How to apply:** mount points stay staff-gated (`isReviewer`/`isStaff`). On the three
queue surfaces (misc/new-char/edit cards) the button lives in the card's ACTION ROW next
to OVERRIDE (label "SEE THREAD"), NOT a header icon — `ReviewQueueCard` has no Discord
prop anymore; each tab renders `DiscordThreadDrawer` itself. The Radix Sheet needs a
`SheetTitle` (kept `sr-only`) or it warns/breaks a11y. Server endpoint is reviewer-gated
regardless, so this is defense-in-depth, not the only gate.

**`watchUnread` on a queue is safe:** it flashes the button gold (localStorage last-seen
vs newest message ts) and polls every 30s. Per-card polling does NOT hit Discord rate
limits because the server caches each thread ~8s keyed by threadId (shared across all
cards/reviewers) — N cards collapse to ≤1 Discord fetch per thread per window. There is
NO server-side seen state; unread is purely client-side per browser.
