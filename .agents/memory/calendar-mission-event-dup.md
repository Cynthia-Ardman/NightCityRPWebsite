---
name: Calendar mission/event duplicate via shared discord_event_id
description: Why the same Discord scheduled event can render twice on the calendar, and the reconcile invariant that prevents it.
---

A `missions` row and an `events` row can end up holding the SAME `discord_event_id`.
This happens when the events reconcile imports a Discord scheduled event FIRST (no
mission owned it yet), and a mission is LATER created for / linked to that same
Discord event. The DirectoryCalendar merges missions + events into one chip list,
so the shared Discord event then renders TWICE on the same day.

**Rule:** `reconcileDiscordEvents` must AUTO-HEAL an event row whose `discord_event_id`
is now owned by a mission — cancel the row AND null its `discord_event_id` — not merely
`continue` past it. A bare skip leaves the orphan duplicate forever.

**Why:** The mission system owns the Discord lifecycle for that id. Cancelling hides the
event from the calendar (listEvents excludes `cancelled`); nulling the discord id is
REQUIRED so the cancelled-row teardown branch never deletes the mission's live Discord
event. The heal is a website-only write, so it runs regardless of the Test/Live flag, and
is idempotent (once unlinked the row no longer reaches the heal branch).

**How to apply:** Any time missions and events both carry `discord_event_id` and a UI
merges the two sources, the mission is authoritative; retire the event-side duplicate.
One-off heal mirror: `scripts/src/heal-duplicate-mission-events.ts` (TARGET=dev|live).

**Caveat:** Cancelling the duplicate strands any `event_npc_signups` on it (hidden, not
migrated to the mission). Rare in practice; revisit if duplicates with signups appear.
