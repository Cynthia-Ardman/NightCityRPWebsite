---
name: tsx -e inline scripts and top-level await
description: `pnpm exec tsx -e '...'` rejects top-level await with "Top-level await is currently not supported with the cjs output format" and the script silently appears to succeed (warnings: [] line printed, exit 0) while having done nothing. Write a temp `.ts` file instead.
---

**The trap:** when you need a quick one-off DB write, the obvious move is `pnpm exec tsx -e 'import {db}... await db.update(...)'`. This compiles via tsx's CJS path which forbids top-level await. The error is printed to stderr in a deeply nested object dump that looks like build metadata, and the process exits 0 — so any greps for "ERROR" or non-zero exit checks miss it. Your "merge" or "delete" never ran and you proceed thinking it did.

**Why:** tsx's `-e` mode bundles to CJS by default; top-level await needs ESM. Module file extensions on disk get the ESM path automatically.

**How to apply:**
- For any one-off script that needs `await` (drizzle queries, fetch, fs.promises), write `scripts/src/<name>.ts` and run `pnpm exec tsx src/<name>.ts`. Do not use `-e`.
- If you must inline, wrap in `(async () => { ... })()` and call `process.exit(0)` at the end.
- When a "delete" or "merge" looks suspiciously fast or silent, re-query the DB to confirm the write actually happened before moving on.
