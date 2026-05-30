---
name: Mission data locations
description: Why the portal Missions/LN page is empty and where the "real" missions actually live across the three DBs.
---

There are two unrelated "mission" concepts in this project. Confusing them causes false data-loss scares.

- **`missions` table** = the Task #62 "LN" workflow (draft→proposal→approved→posted, player applications, NPC announcements). Portal Missions page (`/ln`, routes labelled "ln") reads ONLY this table. It has **never had a row inserted on ANY database** — `missions_id_seq` is `last_value=1, is_called=false` on dev, Replit-managed prod, AND the live Neon DB. So an empty Missions page is BY DESIGN, not data loss.
- **`mission_log` table** = historical attendance, imported by `import-prod.ts` from the legacy bot's `mission_event` table (PROD_DATABASE_URL). ~31 attendance rows spanning 9 distinct legacy missions (5 active: Datadyne Detection, Viva la Libertad, Orbital Dysfunction, No More Romeo, Wolf Cried Wolf; 4 cancelled/test). These are what users mean when they say "we had 6 or 7 missions." `mission_log` is NOT surfaced on the new Missions/LN page; only via per-character history.

**Why:** A user reported missions "disappeared" after the LN feature shipped. Forensics (id sequence never advanced on all 3 DBs; legacy mission_event has exactly the 9 they remembered) proved nothing was deleted — they were conflating the Discord-bot missions (history) with the new empty LN scheduler.

**How to apply:** Before "restoring lost missions," check `missions_id_seq` — if pristine, the table was never used and there is nothing to restore. The legacy missions are completed/past; importing them into the forward-looking LN table only makes sense if the user explicitly wants past missions shown there.
