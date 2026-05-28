---
name: Object-storage URL prefix must be client-routable
description: Stored image URLs need the /api/storage prefix or the SPA swallows them.
---

The api-server serves uploaded objects at `GET /api/storage/objects/*` (mounted under the `/api` artifact prefix). The portal SPA owns every other path including `/objects/*` — so any `<img src="/objects/uploads/<id>">` returns the portal's `index.html` (200, text/html) and renders broken, even though the file exists in App Storage.

**Rule:** what gets stored in the DB must be the *client-facing* URL, not the storage-lib's internal canonical path. The upload-URL endpoint (`POST /api/storage/uploads/request-url`) must return `objectPath` already prefixed with `/api/storage`. The internal lib can keep using `/objects/<id>` for its own bookkeeping, but never let that shape escape into a column anyone will later `<img src>`.

**Why:** path-based artifact routing means root paths belong to the SPA. curl-from-shell hits the proxy and may look fine (200 + bytes) but the browser-rendered SPA returns its HTML shell for unknown routes, so a 200 in curl is not proof the URL works in a real page — always check the response `Content-Type`.

**How to apply:**
- When adding any new column that stores an object URL, store the `/api/storage/objects/...` form.
- The character-sheet importer just persists whatever `objectPath` the request-url response returns, so fixing the endpoint fixes the importer too.
- If you ever migrate the api to a different base path, bulk-rewrite stored URLs in lockstep (characters.portrait_url, portrait_urls[], stats_image_urls[] today).
