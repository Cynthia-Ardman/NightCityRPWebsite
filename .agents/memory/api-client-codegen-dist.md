---
name: api-client-react codegen → rebuild dist
description: Why a freshly-codegen'd hook shows up as "no exported member" in the portal until you rebuild the client package's declarations.
---

After OpenAPI codegen regenerates `lib/api-client-react/src/generated/*`, you MUST rebuild that package's emitted declarations before consumers see the new exports:

```
pnpm --filter @workspace/api-client-react exec tsc --build --force
```

**Why:** `@workspace/api-client-react`'s tsconfig is `composite` + `emitDeclarationOnly` with `outDir: dist`, and consumers (e.g. `artifacts/ncrp-portal`) wire it in via TS **project references** (`references: [{ path: "../../lib/api-client-react" }]`). Project references resolve types from the referenced project's **built `dist/*.d.ts`**, not from `src`. So if codegen (often done by a merged task agent) updates `src/generated/api.ts` but the `dist` declarations aren't rebuilt, the new hook exists in source yet the consumer's `tsc --noEmit` fails with `'@workspace/api-client-react' has no exported member named 'useListXyz'`.

**How to apply:** If a portal typecheck error claims a generated hook/type doesn't exist but you can `rg` it in `lib/api-client-react/src/generated`, the dist is stale — rebuild it (above), don't "fix" the call site. This is exactly the kind of thing post-merge reconciliation should cover after any task that runs codegen.

**Same trap for `@workspace/db`:** it is also `composite` + `emitDeclarationOnly` (`outDir: dist`). After you add a Drizzle table/type to `lib/db/src/schema/index.ts` and `pnpm --filter @workspace/db run push`, the api-server `tsc --noEmit` still fails with `Module '"@workspace/db"' has no exported member 'fooTable'` until you rebuild the db declarations: `pnpm --filter @workspace/db exec tsc --build --force`. `push` updates the DB, NOT the emitted `.d.ts` — they are independent steps.
