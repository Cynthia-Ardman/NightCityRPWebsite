---
name: Discord thread mirror linkage
description: When to persist a ticket's discordThreadId so "linked" never lies and backfill stays idempotent.
---

For a Discord thread created FROM a message (`POST /channels/:ch/messages/:msg/threads`),
the thread id ALWAYS equals the message id. So the only ambiguity on a non-OK
response is "thread already exists" vs "real failure".

Rule:
- HTTP 400 with code `160004` / phrase "thread has already been created" => the
  thread exists at id == messageId; return messageId (success).
- Any OTHER non-OK (403/429/network) => NO thread was created; return null.
- Persist `discordThreadId` ONLY when the create helper returns non-null. ALWAYS
  persist `discordMessageId` when the post succeeded (so a later backfill can
  thread from it). NEVER fall back to `discordThreadId = threadId ?? msgId`.

**Why:** the `?? msgId` fallback marked a ticket "linked" on a hard failure (no
thread). The read endpoint then returned `linked:true` with a dead deep link, and
backfill skipped the row forever (never recovered).

**How to apply:** the server lib helper AND any standalone script helper (e.g.
backfill) must BOTH implement the 160004 branch — they are separate functions; a
fix in one is not a fix in the other. Backfill requests must reuse an existing
`discord_message_id` (thread from it, don't re-post) and persist the message id
before thread-create so a rerun never double-announces.
