---
name: Custom-request image dual-column invariant
description: custom_requests has both image_urls (jsonb array, canonical) and legacy image_url; every write path must keep them in sync.
---

**Rule:** `custom_requests.image_urls` (string[] jsonb, cap 8) is the canonical image set; legacy `image_url` must always equal `imageUrls[0] ?? null`. Read shaping falls back legacy rows (`imageUrls` null) to `[imageUrl]`.

**Why:** Multi-image support was added on top of a single-image column that Discord embeds and older consumers still read. If a write path sets only one column, either old consumers lose the image or the array goes stale and the UI shows the wrong set.

**How to apply:** Any NEW insert/update of `custom_requests` that carries an image must write BOTH columns (see `sanitizeImageUrls` in requests.ts; the staff custom-gun grant in directory.ts dual-writes `[imageUrl]`). PATCH semantics: `imageUrls` array wins; a legacy single `imageUrl` string rewrites the whole set; empty array clears both. Insert paths without images (missions participation, store invites/stock) are unaffected.
