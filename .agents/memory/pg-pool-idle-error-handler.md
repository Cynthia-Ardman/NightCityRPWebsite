---
name: pg pool idle-error handler
description: node-postgres pools must have an 'error' listener or a dropped idle connection crashes the whole process
---

**Rule:** every long-lived `pg` `Pool` must attach `pool.on("error", ...)`.

**Why:** managed Postgres (Neon) periodically kills idle backend connections
("terminating connection due to administrator command", e.g. compute
restart/scaling). node-postgres emits this as an `error` event on the pool for
the affected idle client; with no listener, Node treats it as an unhandled
'error' event and hard-crashes the process. This took prod down on 2026-07-18
(~16:08 UTC) — users saw PR_CONNECT_RESET_ERROR while the deployment crash-
looped and restarted. Errors on clients with an in-flight query surface to that
query's caller regardless, so the handler only needs to log.

**How to apply:** the shared pool lives in `lib/db` (handler added there). Any
future standalone long-running Pool (workers, bots) needs its own handler.
One-off scripts don't (process exits anyway).

Related, unresolved: prod also logs frequent NODE-CRON "missed execution —
possible blocking IO or high CPU" warnings at cron ticks (many jobs pile up on
:00/:30). Not the crash cause, but a sign the single process is under periodic
load; if reset reports continue after this fix, look at job scheduling spread /
deployment machine size.
