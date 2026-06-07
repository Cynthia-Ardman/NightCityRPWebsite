---
name: Venue public-vs-management employee field
description: Public directory venue endpoints expose employeeNames (string[]); management endpoints expose employees (objects). Keep the two contracts separate.
---

Public directory venue detail endpoints (`GET /directory/ripperdocs/:id`, `GET /directory/stores/:id` in `artifacts/api-server/src/routes/directory.ts`) must return `employeeNames: string[]` — NOT the richer `employees` object array. The OpenAPI `RipperdocPublic`/`StorePublic` schemas declare only `employeeNames`, and the public frontends (`DirectoryRipperdocDetail.tsx`, `DirectoryStoreDetail.tsx`) read `data.employeeNames`.

The management endpoints (`GET /ripperdocs/:id`, `GET /stores/:id`) return `employees` (objects with id/name/role/commissionPct) consumed by the manage pages (`MyClinicDetail.tsx`, `MyStoreDetail.tsx`).

**Why:** A handler that returns `employees` on a public endpoint silently breaks the Staff section (always "No staff listed") because the field name doesn't match the schema/frontend — and over-exposes role/commission data publicly. This is a contract-split gotcha: same concept, two different field names by surface.

**How to apply:** When touching public venue directory responses, map to `employeeNames` (names only). When touching management venue responses, return full `employees` objects. Never copy one shape into the other endpoint.
