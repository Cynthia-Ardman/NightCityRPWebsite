---
name: Custom-request Discord announce paths
description: Which customRequests creation paths post to cs-approver + open a Discord thread, and which silently skip it.
---

Not every `custom_requests` insert announces to the cs-approver channel / opens the
read-only Discord thread mirror. `announceRequest()` (exported from
`routes/requests.ts`) is the single helper that does `postToChannel` +
`startThreadFromMessage` + persists `discordMessageId`/`discordThreadId`.

**Rule:** any request type that shows up in the cs-approver REVIEW QUEUE (vote
buttons + thread-mirror panel) MUST have its creation path call `announceRequest`,
or reviewers see "No Discord thread linked to this ticket yet."

**Why:** `customRequests` has multiple insert sites across files
(`routes/requests.ts`, `routes/stores.ts`, `routes/directory.ts`,
`routes/missions.ts`). Only the standard `POST /requests` create path and the
draft-submit path call `announceRequest`. Types created elsewhere (e.g.
`venue_stock` in `stores.ts`) historically skipped it. Types that are
STAFF_QUEUE_EXCLUDED (`stock_cost`, `employee_invite`, `mission_participation`)
legitimately don't need a thread — they never enter the reviewer queue.

**How to apply:** when wiring a new reviewable request type, trace its actual
insert site (not just `POST /requests`) and add a fire-and-forget
`void announceRequest(...)` after the insert. `announceRequest` is deployment-gated
(no-op outside REPLIT_DEPLOYMENT/ALLOW_EXTERNAL_WRITES), guarded on CS_CHANNEL_ID,
and try/catch-wrapped, so it only fires threads in production. Existing pre-fix rows
are NOT retroactively threaded — needs a backfill if wanted.
