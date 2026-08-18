#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Apply any newly merged versioned migrations to the dev DB (replaces the old
# schema push — schema changes now ship as generated files in lib/db/migrations).
pnpm --filter @workspace/db run migrate
# Re-assert database-level append-only guards on the immutable history tables
# (rent / cyberware-meds / bot ledger / attendance / audit / activity).
# Idempotent; must run AFTER migrate so the tables exist.
pnpm --filter @workspace/scripts run db:guards
# Remap guidebook sections to the condensed onboarding-ordered catalogue and
# flag the rules pages publicly readable. Idempotent.
pnpm --filter @workspace/scripts run migrate-guidebook-sections
