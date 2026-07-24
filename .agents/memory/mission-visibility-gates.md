---
name: Mission private-visibility gates
description: Every surface that must honor missions.visibility='private' — adding one gate is a bypass if the others are missed.
---

Missions have `visibility: 'public' | 'private'`. Private = visible ONLY to managers (fixer/admin), archivists, the authoring fixer, and rostered players (mission_assignments, any state) — and NEVER touches Discord.

**Why:** the contract is "everyone else sees it nowhere"; a single missed surface (a list, search, or one Discord announcer) leaks existence.

**How to apply:** any new mission read surface or Discord announcer must re-use the same rule:
- Read surfaces sharing `visibleToViewerFilter(viewerId)` in missionsService: board list, fixer profile; detail gate 404s; global search duplicates it with an EXISTS. Archivists keep posted-only scope but BYPASS the private filter (they approve). Calendar/dashboard/history feed off these — no separate gates.
- Discord suppressors: `syncMissionDiscordEvent` shouldExist (flip-to-private tears the event down), `ensureMissionThread` early return, thread-backfill target query, NPC "actors needed" query, and the postMission sign-up announcement (which RE-READS visibility after the posted claim — stale pre-claim row is a race leak).
- `visibility` must stay OPTIONAL in the OpenAPI Mission schemas (list-only-fields rule).
