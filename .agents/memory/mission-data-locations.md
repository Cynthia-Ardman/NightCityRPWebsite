---
name: Mission data locations
description: Why the portal Missions/LN page can look empty and where the "real" missions actually live across the three DBs.
---

There are two unrelated "mission" concepts in this project. Confusing them causes false data-loss scares.

- **`missions` table** = the first-class "LN" workflow (draft→proposal→approved→posted, player applications, NPC announcements). The portal Missions page (`/ln`) reads ONLY this table. It started life EMPTY on every database — an empty Missions page is BY DESIGN, not data loss.
- **`mission_log` table** = historical attendance, imported by `import-prod.ts` from the legacy bot's `mission_event` table (PROD_DATABASE_URL). NOT surfaced on the Missions/LN page; only via per-character history. When users say "we had 6 or 7 missions," they mean these legacy Discord-bot missions.

**Why:** A user reported missions "disappeared" after the LN feature shipped. Forensics proved nothing was deleted — they conflated the completed Discord-bot missions (history) with the new, empty LN scheduler.

**How to apply:**
- Before "restoring lost missions," check `missions_id_seq` — if it has never advanced (`is_called=false`), the table was never used and there is nothing to restore.
- To surface legacy missions ON the LN page, `scripts/src/import-legacy-missions.ts` backfills `mission_event` → `missions` as `workflow_state='posted'`, with `auto_pay_processed_at`/`npc_announced_at` pre-set so the payout/announce crons never fire on imported history. Idempotent; targets dev by default, live Neon with `IMPORT_TARGET=live`.
- Player counts ("0 / N players") come from `mission_assignments`, NOT the mission row. `scripts/src/import-legacy-mission-assignments.ts` backfills players from `mission_event.attendee_ids`, resolving each attendee's per-mission character from the `mission_log` `[legacy-mission:<mid>:<attendee>]` tag (fallback: their active character). Safe because the parent missions already have `auto_pay_processed_at` set.
- ACTORS per mission live in `mission_actor_payments` (actors = assigned players who NPC'd). The legacy `actor_attendance` table is the only actor source, but it ONLY contains "Open Chaos Lobby" (+ "test") — there is NO actor data for the 6 imported missions, so nothing to import there.
