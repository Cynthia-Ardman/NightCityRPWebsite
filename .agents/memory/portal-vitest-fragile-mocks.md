---
name: Portal vitest fragile mocks
description: Why some ncrp-portal component tests fail with "No <hook> export is defined" independent of your change.
---
Several ncrp-portal component tests (EditCharacterDialog.test.tsx, CharacterDetail.test.tsx, and CyberwareEditor via those pages) mock `@workspace/api-client-react` with a manual `vi.mock` factory that enumerates only a subset of hooks. When the component under test calls a hook the factory does not list (e.g. `useGetCharacterInventory`, `useListCyberware`), vitest throws `[vitest] No "<hook>" export is defined on the "@workspace/api-client-react"`. CharacterDetail also has a nested-`<a>` hydration warning from a wouter `<Link>` wrapping an anchor.

**Why:** these are test-infra brittleness, not product bugs; the real exports exist in the generated client. They fail in the full `test` workflow regardless of unrelated feature work.

**How to apply:** if the `test` workflow shows these 16 failures after an unrelated change, confirm via `git diff --stat` that the generated client diff is additive (no removals) and that you did not touch those test files/components — then treat them as pre-existing and skip validation with that reason. Only fix by switching the offending tests to `importOriginal()`-spread mocks if asked.
