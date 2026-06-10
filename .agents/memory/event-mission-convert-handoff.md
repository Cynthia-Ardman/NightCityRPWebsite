---
name: Event<->mission convert handoff
description: How bidirectional event<->mission conversion replaces the original without a calendar duplicate or Discord teardown.
---

Converting an event<->mission is a REPLACE, not a copy: in ONE db.transaction,
lock the source row FOR UPDATE, raw-flip its status to "cancelled" (never call a
cancel-sync helper — those would hit the Discord API), create the counterpart row,
and HAND OFF the Discord scheduled event by nulling `discordEventId` on the
original and setting it on the new row in the same tx. No Discord API calls happen
during convert.

**Why:** a mission + event that both carry the same `discord_event_id` render
twice on the merged calendar (see calendar-mission-event-dup.md), and tearing down
/ recreating the Discord event would churn the real scheduled event and notify
members. The handoff keeps exactly one live Discord event and one calendar entry.

**How to apply:**
- Only `events.discord_event_id` has a partial-unique index; `missions` has none.
  The handoff is cross-table so neither direction collides, but null the original
  FIRST as a safety habit.
- The cancelled original keeps a null discord id, so the reconcile cancelled-row
  teardown branch can never delete the live Discord event; reconcile also builds a
  mission-owned id set and skips importing those ids as duplicate events.
- Merged calendar already filters cancelled rows (server `ne(status,'cancelled')`
  on events; client filter on missions), so the cancelled original disappears.
- Leave `mission_actor_payments` on the cancelled original (historical record).
- Event NPC signups stay on the cancelled source event by design (only payments
  were specced as protected).
- Frontend convert dialogs must invalidate BOTH list query keys (missions AND
  events) plus the source detail key on success, or the stale cancelled original
  briefly shows on list pages before navigation.
