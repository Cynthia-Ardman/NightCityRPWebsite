---
name: Prod cron deployment target
description: Why the deployment is Reserved VM, and how to verify cron continuity/duplication from job_runs
---

The api-server hosts all crons in-process, so the deployment target is **Reserved VM** (`deploymentTarget = "vm"` in `.replit`, changed via `verifyAndReplaceDotReplit` — direct .replit edits are blocked).

**Why:** Under autoscale (verified 2026-08-18 against live `job_runs`), steady player polling kept crons firing every hour for 14 days — but a scale-out window (2026-08-17 23:55–00:40 UTC) ran two instances and **every cron fired twice per tick**. Idempotency guards absorbed it; duplicate cron runners remain the double-billing failure mode this project has hit before.

**How to verify:** query live prod `job_runs` (LIVE_PROD_DATABASE_URL): zero-run hours = idle-down gaps; same-job starts <30s apart = multi-instance double-fire. Statuses are `succeeded|failed|running` (not `ok`). Even on VM, a redeploy briefly overlaps old/new instances — crons must keep idempotency guards.
