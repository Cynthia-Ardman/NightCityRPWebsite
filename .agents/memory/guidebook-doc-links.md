---
name: Guidebook Google-link rewriting
description: How the guidebook importer turns Google Doc/Sheet links into on-site pages, and the script guard trap.
---

# Guidebook Google Doc/Sheet -> on-site page linking

The guidebook content (imported from Discord channels) links out to Google
Docs/Sheets. Those are converted to native pages and the importer rewrites the
links. Lives in `guidebookImport.ts` + `scripts/apply-task188-pages.ts`.

## Link resolution model
- **Already-covered data is NOT duplicated.** Both cyberware sheet ids map
  statically (`CATALOG_DOC_LINKS`) to `/catalog/cyberware`. Don't make a library
  page for cyberware pricing.
- **Converted docs/sheets become `section = "library"` pages** ("Reference
  Library"). Each records its origin Google url in `sources[].url`.
- `buildDocLinkMap()` resolves a Google-file-id -> `/guidebook/<page id>` at run
  time by scanning **only** section "library" pages' `sources` (ordered by id,
  first-wins, static catalog ids always win). The numeric page ids differ per
  env, so this must be DB-derived, never hardcoded.
- `rewriteMappedDocUrls` rewrites markdown links (keeps the label) and bare
  docs.google urls (uses the target label). `docLinks` is threaded through
  cleanContent -> processMessage -> buildPage -> importGuidebookSource.

**Run order:** create/refresh library pages FIRST (apply-task188-pages.ts), then
re-run import-guidebook.ts so the rewrite can resolve the now-existing ids.

## Re-import vs editedSinceImport (Task #187 interplay)
If a page is `editedSinceImport = true`, a re-import does NOT overwrite the live
body — the rewritten content is stashed in `pendingImport` for admin review
(POST `/guidebook/import/review/:id/apply`). So after re-import, FAQ/systems link
rewrites may sit in pending until applied; the live page keeps old links until
an admin (or the apply endpoint) promotes pending -> body.

## dev/prod-guarded one-off script trap
`@workspace/db` reads `DATABASE_URL` **at module load**. Scripts that switch
DATABASE_URL (dev vs LIVE_PROD_DATABASE_URL) before connecting MUST do the guard
first and load db (and anything that imports db) via **dynamic** `await
import(...)` inside `main()`. A static top-level `import` is hoisted and connects
to the wrong DB. (Same reason import-guidebook.ts uses dynamic imports.)
