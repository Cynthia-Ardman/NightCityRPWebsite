---
name: AdminTabs render-guard mock completeness
description: The System Admin tabs render-guard test mocks api-client-react with a no-importOriginal factory; every hook in a tab's subtree must be listed or the tab silently fails to mount.
---

`artifacts/ncrp-portal/src/pages/AdminTabs.test.tsx` mocks `@workspace/api-client-react`
with a plain factory `vi.mock("@workspace/api-client-react", () => ({ ... }))` that
does NOT use `importOriginal`. So the mock is an allowlist: only the hooks explicitly
listed exist. Any hook reached while rendering a System Admin tab must be in that list.

**Why:** when you add a new hook to a component rendered by a tab (e.g. a new
`CyberwareEditor` calling `useListCyberware` inside `CreateCharacterCard`, or a new
`LoginRestrictionCard` calling `useAdminGetSiteAccess`/`useAdminSetSiteAccess` inside
`JobsTab`), the render-guard test throws `No "useX" export is defined on the
"@workspace/api-client-react"` and the tab "fails to mount" — even though the app is
fine. These look like regressions but are just an incomplete mock.

**How to apply:** whenever you add a client hook to anything in the CharactersTab /
JobsTab / EconomyTab / UsersTab / AuditTab subtree, add a stub for it to that factory
(query hooks → `() => ({ data: undefined, isLoading: false })`; mutations →
`() => ({ mutate: h.mutate, mutateAsync: h.mutate, isPending: false, reset: vi.fn() })`).
Run `pnpm --filter @workspace/ncrp-portal exec vitest run src/pages/AdminTabs.test.tsx`.
