---
name: Event NPC roster fee is optional
description: Why the event NPC "ATTENDED" confirm must not require a fee > 0 (parity with missions, main-session volunteers)
---

The event NPC roster (EventDetail `NpcRoster`) confirms each volunteer as attended (paying a per-NPC fee) or no-show — mirroring the mission NPC roster. Unlike missions (which carry a mission-level `npcPayAmount` and confirm attended with no per-row fee), events have NO event-level pay field; the fee is typed per confirmation and defaults to 0.

**Rule:** the event ATTENDED button must allow confirming with fee = 0 (unpaid volunteer). Do NOT gate it on `amount > 0`.

**Why:** Main Sessions (eventType "session") always accept NPCs, and their NPCs are unpaid volunteers. With the button disabled while fee ≤ 0, a manager could never mark a main-session NPC as attended — it looked like "main events have no attend button" vs missions/paid events. The server already supports a 0 fee end to end: the confirm route only rejects `amount < 0`, and `payStandaloneActors` skips `patchBalance` when `amount === 0` (records the row as paid €0, not failed).

**How to apply:** keep the ATTENDED disabled condition as `cancelled || amount < 0 || confirm.isPending` (never `amount <= 0`). The FEE input stays optional; 0 = unpaid attendance.
