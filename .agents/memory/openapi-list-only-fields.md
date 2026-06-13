---
name: OpenAPI list-only response fields
description: When adding a field that only some endpoints of a reused schema return, keep it optional in OpenAPI.
---

A field computed only in a list/hydration handler (e.g. `lastActivityAt` on CustomRequest) must stay OPTIONAL in its OpenAPI schema, never `required`.

**Why:** Schemas like `CustomRequest` are returned by a shared `shape(row)` builder used across many endpoints (POST create, vote, override, close/reopen, update, resubmit). Only the list handler (`attachTallies`) attaches the extra field. Marking it `required` makes generated clients claim data that those non-list endpoints never return — a silent contract regression.

**How to apply:** Add the property to the schema's `properties` but NOT its `required` array. Frontend consumers must fall back (`x.lastActivityAt ?? x.createdAt`). Same caution for any summary schema (PendingSheetSummary, PendingEditSummary) that might be returned by non-list endpoints.
