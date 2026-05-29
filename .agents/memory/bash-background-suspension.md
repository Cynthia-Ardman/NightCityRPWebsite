---
name: Background process suspension across tool calls
description: Why detached/nohup background processes appear to "freeze" or die between bash tool calls, and how to run long jobs instead.
---

A process started in the background from one bash tool call (even with
`nohup ... & disown` or `setsid`) is **suspended/frozen the moment that tool call
returns**. `pgrep` may still list it (it is not always reaped immediately), but it
makes **zero forward progress** — a heartbeat loop appending one line/sec writes
only the lines produced during the launching call's own foreground window, then
stops. Subsequent tool calls see the same stale state and eventually the process
is gone.

**Why:** the tool harness scopes each bash invocation; background children of a
finished call do not get scheduled afterwards. This is environment behavior, not
a bug in the script.

**Symptom that misled us for many cycles:** a backfill "driver" always stalled at
exactly the char it was processing when the launch call returned (looked like a
"catastrophic event-loop freeze" on one specific record). It was not a freeze —
the whole process was simply suspended. Run in the foreground, that same record
processed fine in a few seconds.

**How to apply:** for any job longer than one call, do NOT detach + poll from
later calls. Instead run it in the **foreground inside a single tool call**
(max ~120s; wrap the work in `timeout -s KILL -k 5 ~100 ...` so it returns with
margin) and make the job **resumable across calls** via a skip/attempted file:
record each unit the instant it starts (before the first await), exclude recorded
units on the next call, and repeat the foreground call until the job reports zero
remaining. After a non-clean exit (tool-timeout, code -1), drop the last
marked-but-unfinished unit from the skip file so it gets a real attempt.
