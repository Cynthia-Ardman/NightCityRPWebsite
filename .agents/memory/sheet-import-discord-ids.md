---
name: Sheet import of Discord IDs
description: Parsing 64-bit Discord IDs from a Google Sheet/CSV without corrupting them, plus the Postgres SRF-in-aggregate trap in the upsert.
---

# Importing Discord IDs from a spreadsheet/CSV

**Rule:** Never parse a CSV/sheet that contains Discord IDs with a numeric or
spreadsheet parser (XLSX `sheet_to_json`, `Number()`, gviz typed JSON, etc.).
Discord snowflakes are 64-bit and exceed `Number.MAX_SAFE_INTEGER` (2^53), so
numeric coercion silently rounds them — e.g. `262434049862270976` becomes
`262434049862270980`. The corrupted value still looks like a valid ID, so the
bug is invisible until the join key fails to match any `users.id`.

**Why:** The whole point of importing attendance is to join on the Discord ID;
a rounded ID matches nobody and the feature shows nothing, with no error.

**How to apply:** Fetch the sheet as CSV and parse with a string-preserving
RFC-4180 parser that keeps EVERY field as a string. XLSX/Sheets parsers also
coerce single date cells to Date serials, dropping them — another reason to use
the raw-string CSV path. After import, spot-check a known long ID byte-for-byte.

# Postgres set-returning fn in an aggregate

`count(DISTINCT jsonb_array_elements_text(...))` is illegal (parse_agg.c
`check_agg_arguments_walker`: cannot nest a set-returning function inside an
aggregate). Wrap the SRF in a subquery first: `SELECT count(*) FROM (SELECT
DISTINCT jsonb_array_elements_text(...) ) u`.

# Where the data lives

Sheet attendance imports into `bot_mission_log` (userId PK, username,
missionCount, missionDates jsonb). It is NOT append-only guarded, and
`onConflictDoUpdate` unions existing+new dates so re-runs are idempotent and
never clobber legacy bot data. Surfaced read-only in staff Fixer Player Lookup
via `/fixer/players/:userId/activity` → `historicalAppearances`. One-way import,
no writeback, no dedicated page.
