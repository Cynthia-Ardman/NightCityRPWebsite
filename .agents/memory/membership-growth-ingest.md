---
name: Membership growth ingest
description: Discord/VRChat join-leave ingest traps — jsonb cursor double-parse, concurrent-walker cursor races, source formats
---

## bot_config jsonb digit-string double-parse (CRITICAL trap)
Storing a bare JSON string of digits (e.g. a Discord snowflake `"1474..."`) in a jsonb bot_config value comes back from drizzle as a precision-lossy JS **number** (double JSON.parse). Any `typeof v === "string"` read then fails → cursor resets to 0 silently.
**Why:** cost a whole afternoon of "backfill inserts 0 and cursor regresses" debugging.
**How to apply:** always wrap scalar cursors/ids as an object, e.g. `{"id":"<snowflake>"}`; keep legacy string/number fallbacks on read.

## Concurrent walkers need a monotonic cursor upsert
The membership_sync cron and a manual backfill script share one cursor; blind upserts let the slower walker move the cursor backwards. Cursor writes use `ON CONFLICT ... WHERE old < new` (numeric compare). Same pattern applies to any resumable channel walk.

## Source formats (community growth timeline)
- Joins: #ncrp-welcome type-7 system messages (full history to server creation, Mar 2025).
- Joins+leaves: #bot-logs Dyno embeds, `embed.author.name` = "Member Joined"/"Member Left", id from footer `ID: <id>` or `<@id>` mention; leave history only from Jan 2026 (Dyno logging start). Channel is ~95% voice-log noise.
- Cross-source join dedupe: same subject within ±15 min, bot-logs ingested first so Dyno rows win.
- VRChat: group audit log (`.join` / `.leave|.remove|.ban`, targetId `usr_*`) — only works from deployed prod (session cookie is network-bound; dev gets 401).
- Idempotency: membership_events.source_ref unique (`discord-msg:<id>` / vrchat audit id) — re-walks are safe.

## Discord history pagination pace
GET channel messages is bucket-limited ~5 req/5s; a full bot-logs history walk (~250k msgs) takes ~30-40 min of chunked runs. Run one-off backfills as repeated bounded chunks (each ShellExec ≤5 min); cursor makes them resumable.
