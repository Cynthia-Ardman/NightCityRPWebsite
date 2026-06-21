---
name: Mission forum-thread creation
description: The mission thread channel is a Discord FORUM channel, not a text channel — thread creation needs the forum API and a required tag.
---

The mission thread channel (#fixer-job-proposals, config key `missions_thread_channel_id`)
is a Discord **FORUM channel (type 15)**, not a text channel.

**Why it broke:** the old `ensureMissionThread` flow was `postToChannel` (POST
`/channels/{id}/messages`) then `startThreadFromMessage`. Forum channels have NO
top-level messages, so the message POST fails → returns null → bails before
creating a thread. This silently broke BOTH new-mission thread creation AND the
`mission_thread_backfill` cron (they share `ensureMissionThread`).

**How to apply:**
- A forum "post" IS a thread; create it with `createForumThread` →
  POST `/channels/{id}/threads` with `{name, auto_archive_duration, applied_tags, message:{content, embeds, allowed_mentions}}`. The returned `id` is the thread id AND the starter message id (set both `discordThreadId` and the brief-message column to it).
- This forum has **require-tag ON** (`flags & 16`), so a create with NO
  `applied_tags` is rejected (400). Always pass ≥1 tag id. Tags are matched by
  NAME at runtime (posted→"Approved", else→"WIP") via `getChannelMeta` (cached
  GET, NOT write-gated) with a fallback to the first available tag, so renamed
  tag IDs never block creation.
- `ensureMissionThread` branches on channel type (`getChannelMeta().type === 15`),
  so it still works if an admin repoints the config at a text channel.
- All creates stay deployment-gated (`externalWritesAllowed`), so dev no-ops;
  verify forum behavior by reading the live channel via the Discord API, don't
  spam the real forum from dev.

**Diagnosing "missions aren't posting":** `announceMissionThread` runs only at
the `POST /missions` create path (missions.ts), so any mission created another
way (event→mission conversion) or before forum support, or that hit a transient
Discord error, gets NULL `discordThreadId`. Channel/tags/bot-perms were all
correct as of 2026-06 (forum type 15, require-tag, tags Approved/WIP/Mission
Finished), so don't assume a live bug — it's almost always a missed/unhealed row.

**Self-heal:** `mission_thread_backfill` now runs on a **cron** (every 10 min,
minutes `5,15,25,35,45,55`, added to `startCron()` in jobs.ts), in addition to
the manual "Backfill Mission Threads" button (AdminDashboard → Cron Jobs). It is
idempotent (only touches `workflow_state='posted'`, non-history rows missing a
thread/snapshot) and the create is deployment-gated, so dev no-ops — threads
only appear in the deployed prod. Because the cron + button can now overlap,
`mission_thread_backfill` is in `NO_OVERLAP_JOBS` (the in-process mutex shared
with the money jobs in `runJob`) so two runs can't double-create a forum thread.
**Why:** the per-mission create reads `discordThreadId` then writes it later, so
without the mutex two concurrent runs both see null and post twice.
