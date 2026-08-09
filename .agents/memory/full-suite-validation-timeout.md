---
name: Full-suite validation timeout
description: The monorepo-wide test validation cannot finish within the completion-validation budget.
---

# Full-suite validation timeout

The configured validation command `pnpm -r --if-present run test` cannot complete
inside the task-completion validation budget: the api-server integration suite
alone runs 30+ minutes (each test file re-pushes the *_test DB schema) and gets
SIGTERM-killed (exit 143), so validation runs end in POLL_BUDGET_EXCEEDED even
when every test passes.

**Why:** observed across four consecutive validation runs (Aug 2026); the portal
suite finishes (~35s) but api-server is killed mid-suite with zero failures.

**How to apply:** run the affected package's test files directly (per-file
`npx vitest run <file>` inside artifacts/api-server, allow ~90s each), confirm
they pass, then call `markTaskComplete` with a `skip_validation_reason`
documenting the local runs. Don't burn retries on repeated full-suite
validation attempts.
