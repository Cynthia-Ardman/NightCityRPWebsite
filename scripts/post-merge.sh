#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
# Re-assert database-level append-only guards on the immutable history tables
# (rent / cyberware-meds / bot ledger / attendance / audit / activity).
# Idempotent; must run AFTER push so the tables exist.
pnpm --filter @workspace/scripts run db:guards
