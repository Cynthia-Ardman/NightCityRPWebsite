---
name: Staff-edit audit parity
description: Staff PATCH/edit endpoints must write an audit row like their sibling create/delete handlers.
---

When a resource has audited create and/or delete handlers, its staff **edit** (PATCH)
handler must also write an audit row. Missing audit-on-edit is a recurring gap on this
codebase — create/delete get audited, the later-added PATCH does not.

**Why:** Edits to financially-relevant fields are silently untraceable otherwise.
Examples found: `PATCH /housing/:id` (edits `monthlyRent`, which feeds the autobill
cron) and `PATCH /stores/:id/stock/:stockId` (edits price/quantity) both shipped with
no audit while their POST/DELETE siblings audited everything.

**How to apply:**
- Mirror the sibling's pattern. If the file uses `recordAudit(...)` (e.g. housing.ts),
  use that; if a sibling writes `auditLog` inline inside a `db.transaction` (e.g.
  stores.ts POST, directory.ts catalog edits), do the same so the edit + audit commit
  atomically.
- Capture a real BEFORE snapshot (re-select the row, or read the fetched `existing`
  row) — not the request body — and an AFTER of only the changed fields.
- Add a no-op guard (`400 "No changes"`) before writing, matching the catalog edit
  convention, so an empty PATCH doesn't emit a meaningless audit row.
- Coerce numeric inputs defensively (`Math.max(0, Math.round(Number(x) || 0))`) to match
  the create handler instead of trusting raw body values.
