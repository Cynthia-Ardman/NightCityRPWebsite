---
name: Adding a player-submit / fixer-voted custom_request type
description: The full set of spots to touch when adding a new custom_requests type modeled on the freeform "gun" template (player submits, fixers vote, materializes to inventory).
---

The cleanest template for a freeform player-submitted, fixer-voted request that
materializes into inventory is the **`gun`** type (no mechanical approval params).
Mirror it. The wiring spans MORE than the review-queue spots — these are the
non-obvious ones that bite:

**Backend** `artifacts/api-server/src/routes/requests.ts`:
- `REQUEST_TYPES` array (gates POST validation).
- `typeLabelFor` (Discord/activity label).
- `auditCategoryFor` (return `"inventory"` for item-like).
- `materializeRequest` (add an insert block; returns `appliedRef: inventory:<uuid>`).
- `afterApprove` recordInventoryEvent condition (`gun || cyberware || ...`).
- `normalizeApprovalParams` default `{ ok: {} }` already covers no-param types — leave it.
- Do NOT add to `STAFF_QUEUE_EXCLUDED_REQUEST_TYPES` (those are owner/player-decided; a fixer-voted type MUST stay visible in the staff queue).

**OpenAPI** `lib/api-spec/openapi.yaml` — THREE enums (easy to miss one):
1. `CustomRequest.type` (the schema, ~line 6940).
2. `CustomRequestInput.type` (submit body).
3. `listMyCustomRequests` query `type` enum.
   (The `listCustomCatalogItems` enum is the staff-only "Custom catalog tab" — only add there if you also build a catalog page for the type.)
Then run `pnpm --filter @workspace/api-spec run codegen` (orval client + zod; runs typecheck:libs). Client exports `src` directly — no separate dist build needed for api-client-react.

**Frontend** — exhaustive maps over `CustomRequest["type"]` / category will fail typecheck if missed:
- `pages/requests/PendingRequests.tsx` `TYPE_META` (label + lucide icon; accessed without `?.`).
- `pages/MyRequests.tsx` — its OWN `HistoryRow["category"]` union, `CUSTOM_LABEL` Record, `CATEGORY_FILTERS` array, `categoryColor` switch, AND `FIXER_VOTED_TYPES` set.
- `components/catalog/CatalogRequestSection.tsx` `RequestType` union (reusable submit dialog; `hasSource` is gun/cyberware-only, so a no-source type just shows title+desc+image).
- A player entry point (e.g. a card in `pages/CharacterDetail.tsx` using `CatalogRequestSection` with `presetCharacterId`).

**Why:** TS catches the frontend Record/union omissions and api-server switch, but the THREE openapi enums and the MyRequests `FIXER_VOTED_TYPES`/filters are silent gaps that ship a half-wired type. Run portal+api-server+libs typecheck and the `requests.pipeline.test.ts` after.


## Former index detail (full)
adding a player-submit/fixer-voted type (gun template): requests.ts spots + 3 openapi enums + MyRequests own union/CUSTOM_LABEL/FILTERS/FIXER_VOTED_TYPES + PendingRequests TYPE_META; don't add to STAFF_QUEUE_EXCLUDED.
