#!/usr/bin/env bash
#
# Byte-for-byte mirror of the LIVE production database into the DEV database.
#
# Unlike `sync-from-prod` (which copies a curated subset of tables for local
# development), this drops the dev DB's `public` schema and restores the ENTIRE
# live `public` schema + data verbatim, so the free community TEST site is a
# true one-to-one copy of live as of run time.
#
# Required env:
#   DATABASE_URL           -> the dev DB (DESTINATION — gets wiped & refilled)
#   LIVE_PROD_DATABASE_URL -> the live prod DB (SOURCE, read-only is enough)
#
# Optional:
#   SYNC_TARGET=dev-confirmed   bypass the "destination doesn't look like dev"
#                               guard (only if you really mean to wipe a
#                               non-dev host).
#
# Run with:  pnpm --filter @workspace/scripts run mirror-from-live
#
# Safety: AFTER restoring, all six Live Mode flags in bot_config are forced
# OFF. Combined with the api-server's externalWritesAllowed() guard (writes are
# suppressed unless REPLIT_DEPLOYMENT=1), this means the test site can never
# move real eddies or post to live Discord even though it holds live data.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL (dev destination) is not set}"
: "${LIVE_PROD_DATABASE_URL:?LIVE_PROD_DATABASE_URL (live source) is not set — this is the neondb backing the live portal}"

if [ "$DATABASE_URL" = "$LIVE_PROD_DATABASE_URL" ]; then
  echo "Refusing to run: DATABASE_URL == LIVE_PROD_DATABASE_URL (would wipe live)." >&2
  exit 1
fi

# Extract hosts without ever echoing credentials.
DEV_HOST=$(node -e 'console.log(new URL(process.env.DATABASE_URL).host)')
SRC_HOST=$(node -e 'console.log(new URL(process.env.LIVE_PROD_DATABASE_URL).host)')

# Destination guard: DROP SCHEMA on the wrong DB is unrecoverable.
if ! echo "$DEV_HOST" | grep -qiE 'helium|replit\.dev|replit\.com|localhost|127\.0\.0\.1'; then
  if [ "${SYNC_TARGET:-}" != "dev-confirmed" ]; then
    echo "Refusing to wipe '$DEV_HOST': it does not look like the dev DB." >&2
    echo "If you really mean to, set SYNC_TARGET=dev-confirmed." >&2
    exit 1
  fi
fi

# Source guard: never let the legacy uuid-schema PROD_DATABASE_URL host be the
# source — its schema differs and the restore would be garbage.
if [ -n "${PROD_DATABASE_URL:-}" ]; then
  LEGACY_HOST=$(node -e 'console.log(new URL(process.env.PROD_DATABASE_URL).host)')
  if [ "$LEGACY_HOST" = "$SRC_HOST" ]; then
    echo "Refusing to run: LIVE_PROD_DATABASE_URL points at the legacy PROD_DATABASE_URL host." >&2
    exit 1
  fi
fi

echo "Mirroring (byte-for-byte) $SRC_HOST  ->  $DEV_HOST"

DUMP="$(mktemp -t live_full.XXXXXX.sql)"
trap 'rm -f "$DUMP"' EXIT

echo "  [1/4] Dumping live public schema + data..."
pg_dump --schema=public --no-owner --no-acl --no-comments "$LIVE_PROD_DATABASE_URL" -f "$DUMP"

echo "  [2/4] Resetting dev public schema..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

echo "  [3/4] Restoring into dev..."
# The dump may include its own `CREATE SCHEMA public;` (pg_dump emits it when the
# schema isn't owned by the bootstrap superuser). We already recreated it above,
# so strip that one line to avoid a duplicate-schema error; everything else
# (tables, data, sequences, indexes, constraints) restores verbatim.
sed '/^CREATE SCHEMA public;$/d' "$DUMP" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q

echo "  [4/4] Forcing all Live Mode flags OFF (Test mode)..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO bot_config (key, value) VALUES
  ('master_live_mode',    'false'::jsonb),
  ('missions_live_mode',  'false'::jsonb),
  ('housing_live_mode',   'false'::jsonb),
  ('cyberware_live_mode', 'false'::jsonb),
  ('evictions_live_mode', 'false'::jsonb),
  ('economy_live_mode',   'false'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
SQL

echo "Mirror complete — dev is now a byte-for-byte copy of live (Live Mode forced OFF)."
