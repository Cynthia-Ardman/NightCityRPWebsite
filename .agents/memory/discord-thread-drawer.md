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

**Unread is driven by HUMAN (non-bot) messages only** (`newestHumanMs` skips
`m.authorIsBot`), NOT every message.

**Why:** every thread's INITIAL message is the bot's mirror post, so counting all
messages made a brand-new thread glow immediately; and later bot status-mirror posts
(website-originated) bumped `newest` above the persisted `seen` marker and re-glowed on
refresh even when no real reply happened. The glow must mean "an actual Discord reply you
haven't read". Website review comments have their own on-site unread dots, so excluding
bot-relayed content here is intentional, not a gap.

**How to apply:** also guard the localStorage `seen` read against `NaN`
(`Number.isFinite` → else 0); `newest > NaN` is always false and would silently suppress
the glow forever.

## Missions also use this endpoint (not just review tickets)

The same `GET /review/:type/:id/discord-thread` endpoint + `DiscordThreadDrawer`
serve MISSIONS (`subjectType="mission"`), surfaced via a `canManage`-gated "SEE
THREAD" button on `MissionDetail.tsx`. Mission threads are created at mission
CREATION time (`announceMissionThread` in `routes/missions.ts`), to a configurable
channel (`missions.threadChannelId` config, default the #missions channel).

**Rule:** "mission" lives in a SEPARATE `THREAD_SUBJECT_TYPES` set in
`routes/review.ts`, NOT the shared `SUBJECT_TYPES`. Only the discord-thread route
parses with `parseThreadSubjectType`; comment/seen/close/vote routes keep
`parseParams`/`SUBJECT_TYPES` (edit|request|sheet).

**Why:** missions have a discussion thread but are NOT in the majority-vote review
pipeline. Adding "mission" to the shared `SUBJECT_TYPES` would let it fall through
into comment/close/reopen handlers (which assume a review subject) and break them.
`resolveSubject`/`resolveThreadId` take the wider `ThreadSubjectType` param so only
the thread path reaches the missions-table branch.
