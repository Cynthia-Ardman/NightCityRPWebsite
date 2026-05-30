---
name: Raw pg one-off import scripts (remote Neon)
description: Why one-off pg scripts appear to "hang" with no output, and how to keep them under the bash tool's timeout.
---

When writing one-off data scripts with raw `pg` (`import pg from "pg"`) run via
`pnpm --filter @workspace/scripts exec tsx src/<file>.ts`:

- **Always end with `main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); })`.**
  If the script throws BEFORE reaching `client.end()`, the open pg sockets keep
  the Node event loop alive forever, so the bash tool hits its timeout and
  returns exit -1 / 124 with NO output — it looks like a connection hang but is
  really an unhandled error + never-exiting process. The real error only shows
  if you redirect to a file (`> /tmp/x.log 2>&1`) and read it after.
- **Bulk-load, don't loop per-row.** dev (`DATABASE_URL`) and live Neon
  (`LIVE_PROD_DATABASE_URL`) are remote/high-latency; ~100 sequential
  round-trips can blow the 2-min tool cap. Read everything in a handful of
  `WHERE col = ANY($1)` queries, build rows in memory, and do ONE multi-row
  `INSERT ... ON CONFLICT DO NOTHING`. Pass JS arrays as a single `$1` param
  with `= ANY($1)` (NOT drizzle `sql\`= ANY(${arr})\``, which spreads to N params).
- Add `connectionTimeoutMillis` + `statement_timeout`/`query_timeout` so a genuinely
  stuck query fails fast instead of hanging.

**How to apply:** Same dev→live target pattern as the mission importers
(`IMPORT_TARGET=live` selects `LIVE_PROD_DATABASE_URL`). Verify dev via
`executeSql` (dev only); for live Neon, verify by re-running (idempotent insert
reports 0 new).
