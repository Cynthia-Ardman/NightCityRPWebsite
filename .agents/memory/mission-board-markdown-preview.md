---
name: Mission board markdown preview
description: Where mission color/markdown tags render vs show raw
---
Mission descriptions use `[c=color]text[/c]` color tags parsed by remarkColor inside the <Markdown> component.

**Rule:** any surface showing a mission description must render it through <Markdown>, not a plain `<p whitespace-pre-wrap>`, or tags show literally.

**Why:** the mission *detail* PlayerView already used <Markdown> (worked), but the board card preview rendered `descriptionPreview` in a plain `<p>` — colors showed as raw text. Fixed by rendering the preview through <Markdown>.

**How to apply:** `descriptionPreview` is server-truncated; remarkColor falls back gracefully on unclosed/cut tags, so rendering a truncated preview through <Markdown> is safe.
