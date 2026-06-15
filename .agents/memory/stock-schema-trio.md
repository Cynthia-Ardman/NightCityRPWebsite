---
name: Stock schema trio drift
description: Adding a field to store stock requires updating three separate OpenAPI schemas, not one.
---

Store stock has THREE distinct OpenAPI schemas in lib/api-spec/openapi.yaml:
`StockItem` (GET response), `StockInput` (POST/create body), and `StockUpdate` (PATCH body).

**Rule:** when adding a stock field (e.g. cyberwareReq), update ALL THREE schemas, then re-run
`pnpm --filter @workspace/api-spec run codegen`.

**Why:** they do NOT share a base. Updating only Item+Input compiles fine until a frontend PATCH
call sends the new field — then the generated `StockUpdate` type lacks it and tsc fails with
"Object literal may only specify known properties". Easy to miss because GET/POST work.

**How to apply:** mirror the same trio for inventory items (InventoryItem / InventoryItemInput /
InventoryItemUpdate). Check the PATCH/Update schema specifically, since create+read are the obvious
two and the update one gets forgotten.
