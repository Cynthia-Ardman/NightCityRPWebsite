---
name: Mission NPC gather time
description: npcStartAt semantics — which surfaces use NPC time vs player start, and the reset/window rules
---

Missions have an optional `npcStartAt` (NPC gather time), normally earlier than `startAt`.

Rule: NPC-facing surfaces use `npcStartAt ?? startAt`; player-facing surfaces stay on `startAt`.

**How to apply:**
- NPC announcement cron windows on `coalesce(npc_start_at, start_at)` and shows the gather time.
- Discord scheduled event ("Actors Needed") starts at `npcStartAt` only when EARLIER than `startAt`; event end is always `startAt + duration`.
- Changing `npcStartAt` (like `startAt`) must reset `npcAnnouncedAt` and post a thread change line.
- Portal: home banner/NPCs-needed card use NPC time for NPC-side viewers (signed up as NPC, or no accepted PC); mission detail shows both.

**Why:** any new mission-time consumer must pick a side deliberately — mixing them double-books NPCs or announces the wrong time.
